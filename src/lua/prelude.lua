-- First script of every connection from the MCP server (src/ce/session.ts), run in CE's Lua state.
-- _mcp_server = { owner, version, resetSafe, lapse } is set just before this code.
--
-- Helpers live here rather than in the CE plugin (ce-plugin/ce-mcp-server.lua): the plugin is
-- only loaded when CE starts, so a CE launched before a plugin update would lack new helpers.

local server = _mcp_server
_mcp_server = nil

-- Claim CE unless another server is still using it (its last call is recent)
if _mcp_owner == nil or _mcp_owner == server.owner or os.time() - (_mcp_owner_seen or 0) > server.lapse then
  _mcp_owner = server.owner
  _mcp_owner_seen = os.time()
  -- SAFE mode is on whenever a server starts: an earlier session's unlock does not carry over
  if server.resetSafe then
    _mcp_unsafe = false
    if updateMenuState then pcall(updateMenuState) end
  end
end

-- Kept across reconnections of the same CE session (running jobs survive a server restart).
-- STATE is the format of what _mcp holds: bump it whenever that format changes, so the state left
-- in CE by an older server version is discarded instead of being misread.
local STATE = 2
if _mcp and _mcp.state ~= STATE then
  for _, s in pairs(_mcp.scans or {}) do
    pcall(function()
      if type(s) == 'table' and s.ms then
        if s.fl then s.fl.destroy() end
        s.ms.destroy()
      else
        s.destroy()
      end
    end)
  end
  for _, job in pairs(_mcp.jobs or {}) do
    job.cancelled = true
    if job.form then pcall(job.form.destroy) end
  end
  if _mcp.jobTimer then pcall(_mcp.jobTimer.destroy) end
  _mcp = nil
end
_mcp = _mcp or { state = STATE }
_mcp.version = server.version
_mcp.jobs = _mcp.jobs or {}
_mcp.nextJob = _mcp.nextJob or 0

--------------------------------------------------------------------------------
-- Jobs: long operations run without blocking CE's main thread.
--
-- spec = {
--   kind = 'pointer scan',             -- shown in the progress window and job status
--   run = function(job, thread) end,    -- optional, runs in a CE thread; check job.cancelled
--   update = function(job) end,         -- optional, main thread: refresh job.done/total/message
--   finish = function(job) return 'result text' end,  -- main thread, once run has returned
--   window = true,                      -- show a progress window with a Cancel button
-- }
-- job.status: running -> finishing -> done | cancelled | error
--------------------------------------------------------------------------------

local function closeWindow(job)
  if job.form then
    pcall(function() job.form.destroy() end)
    job.form = nil
  end
end

local function openWindow(job)
  local form = createForm(false)
  form.Caption = 'CE MCP - ' .. job.kind
  form.Width, form.Height = 360, 110
  form.Position = 'poScreenCenter'
  form.BorderStyle = 'bsSingle'
  local label = createLabel(form)
  label.Left, label.Top = 12, 10
  label.Caption = job.kind .. '...'
  local bar = createProgressBar(form)
  bar.Left, bar.Top, bar.Width, bar.Height = 12, 32, 336, 18
  bar.Max = 1000
  local cancel = createButton(form)
  cancel.Caption = 'Cancel'
  cancel.Left, cancel.Top, cancel.Width = 274, 60, 75
  cancel.OnClick = function() _mcp.cancelJob(job.id) end
  form.OnClose = function() _mcp.cancelJob(job.id) return caHide end
  form.show()
  job.form, job.label, job.bar = form, label, bar
end

local function refreshWindow(job)
  if not job.form then return end
  local text = job.message ~= '' and job.message or (job.kind .. '...')
  if job.total and job.total > 0 then
    job.bar.Position = math.floor(1000 * math.min(job.done, job.total) / job.total)
    text = string.format('%s (%d%%)', text, math.floor(100 * math.min(job.done, job.total) / job.total))
  end
  job.label.Caption = text
end

-- Main-thread step of a job: progress refresh, then finish once its thread has returned
function _mcp.stepJob(job)
  if job.status ~= 'running' and job.status ~= 'finishing' then return end
  if job.spec.update then
    local ok, err = pcall(job.spec.update, job)
    if not ok then job.status, job.error = 'error', tostring(err) end
  end
  if job.status == 'finishing' then
    if job.cancelled then
      job.status = 'cancelled'
    else
      local ok, result = pcall(job.spec.finish, job)
      if ok then job.status, job.result = 'done', tostring(result) else job.status, job.error = 'error', tostring(result) end
    end
  end
  if job.status == 'running' or job.status == 'finishing' then refreshWindow(job) else closeWindow(job) end
end

function _mcp.startJob(spec)
  _mcp.nextJob = _mcp.nextJob + 1
  local job = { id = _mcp.nextJob, kind = spec.kind, spec = spec, status = 'running', done = 0, total = nil,
                message = '', cancelled = false, started = os.time() }
  _mcp.jobs[job.id] = job
  if spec.window then openWindow(job) end
  if spec.run then
    createThread(function(thread)
      thread.Name = 'CE MCP ' .. spec.kind
      local ok, err = pcall(spec.run, job, thread)
      if not ok and job.status == 'running' then job.status, job.error = 'error', tostring(err) end
      if job.status == 'running' then job.status = 'finishing' end
    end)
  else
    job.status = 'finishing'
  end
  -- A timer keeps windows and finished jobs moving even when no MCP call polls them
  if not _mcp.jobTimer then
    _mcp.jobTimer = createTimer()
    _mcp.jobTimer.Interval = 200
    _mcp.jobTimer.OnTimer = function()
      local active = false
      for _, j in pairs(_mcp.jobs) do
        _mcp.stepJob(j)
        if j.status == 'running' or j.status == 'finishing' then active = true end
      end
      if not active then _mcp.jobTimer.Enabled = false end
    end
  end
  _mcp.jobTimer.Enabled = true
  return job
end

function _mcp.cancelJob(id)
  local job = _mcp.jobs[id]
  if job and (job.status == 'running' or job.status == 'finishing') then job.cancelled = true end
  return job
end

--------------------------------------------------------------------------------
-- Named scans (src/tools/scan.ts): _mcp.scans[name] = { ms = memscan, fl = foundlist, ready = bool }
-- One FoundList per memscan, kept for the scan's life: destroying a FoundList leaves the memscan
-- pointing at it, and the next nextScan() aborts the whole script without any Lua error (seen on
-- CE 7.7). It is deinitialized while a scan runs and initialized again once it is done.
--------------------------------------------------------------------------------
_mcp.scans = _mcp.scans or {}

function _mcp.dropScan(name)
  local s = _mcp.scans[name]
  if not s then return false end
  _mcp.scans[name] = nil
  if s.fl then
    if s.ready then pcall(s.fl.deinitialize) end
    s.fl.destroy()
  end
  s.ms.destroy()
  return true
end

-- Before a next scan: release the results file the FoundList holds open
function _mcp.scanBegin(s)
  if s.ready then s.fl.deinitialize() end
  s.ready = false
end

-- After a scan: open its results for reading
function _mcp.scanEnd(s)
  s.fl = s.fl or createFoundList(s.ms)
  s.fl.initialize()
  s.ready = true
end

-- One-line status for the MCP server: status|done|total|message
function _mcp.jobLine(id)
  local job = _mcp.jobs[id]
  if not job then return 'missing|0|0|' end
  _mcp.stepJob(job)
  local message = (job.error or job.message or ''):gsub('[\r\n|]', ' ')
  return string.format('%s|%d|%d|%s', job.status, math.floor(job.done or 0), math.floor(job.total or 0), message)
end

print(string.format('[CE-MCP] asymptomatik-cheatengine %s connected - Mode: %s', server.version, _mcp_unsafe and 'UNSAFE' or 'SAFE'))
