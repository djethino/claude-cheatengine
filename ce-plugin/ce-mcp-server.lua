--[[
  Cheat Engine MCP Server Plugin

  Loaded at CE startup by autorun/ce-mcp-loader.lua (installed by /ce-install),
  which runs the per-user copy kept up to date by the MCP server.
  Provides a menu to control the MCP server and visual feedback.
--]]

-- Load once per CE session, even if a legacy autorun copy is still present
if CEMCP and CEMCP.loaded then
  print("[CE-MCP] Plugin already loaded, skipping duplicate")
  return
end

-- Configuration
local CONFIG = {
  pipeName = "ce-mcp",
  autoStart = true,          -- Start server automatically on CE launch
  showNotifications = true,  -- Show popup notifications
  logToConsole = true,       -- Log to Lua Engine console
}

-- State (global so MCP can access it)
CEMCP = {
  loaded = true,
  running = false,
  menu = nil,
  menuItems = {},
  logForm = nil,
  commandCount = 0,
  lastCommandTime = 0,
  isUnsafe = false,
  statusLabel = nil,  -- Colored status indicator
}

--------------------------------------------------------------------------------
-- Safe/Unsafe Mode Detection (runtime only, set by MCP server)
--------------------------------------------------------------------------------

function checkUnsafeMode()
  -- Check global set by MCP server (_mcp_unsafe)
  -- Defaults to false (SAFE) if not set
  CEMCP.isUnsafe = _mcp_unsafe == true
  return CEMCP.isUnsafe
end

local function getSecurityStatus()
  checkUnsafeMode()
  return CEMCP.isUnsafe and "UNSAFE (writes enabled)" or "SAFE (read-only)"
end

--------------------------------------------------------------------------------
-- Logging
--------------------------------------------------------------------------------

-- Global log buffer accessible via MCP
CEMCP_logBuffer = CEMCP_logBuffer or {}
CEMCP_logMaxSize = 50

local function log(message)
  local timestamp = os.date("%H:%M:%S")
  local formatted = string.format("[%s] [CE-MCP] %s", timestamp, message)

  -- Store in global buffer (circular)
  table.insert(CEMCP_logBuffer, formatted)
  while #CEMCP_logBuffer > CEMCP_logMaxSize do
    table.remove(CEMCP_logBuffer, 1)
  end

  if CONFIG.logToConsole then
    print(formatted)
  end

  -- Log to form if open
  if CEMCP.logForm and CEMCP.logForm.Memo then
    CEMCP.logForm.Memo.Lines.add(formatted)
    -- Auto-scroll to bottom
    CEMCP.logForm.Memo.SelStart = #CEMCP.logForm.Memo.Text
  end
end

-- Get logs for MCP
function CEMCP_getLogs(clear)
  local logs = table.concat(CEMCP_logBuffer, '\n')
  if clear then
    CEMCP_logBuffer = {}
  end
  return logs
end

-- Clear logs
function CEMCP_clearLogs()
  CEMCP_logBuffer = {}
end

local function notify(message)
  if CONFIG.showNotifications then
    showMessage("[CE-MCP] " .. message)
  end
  log(message)
end

--------------------------------------------------------------------------------
-- Server Control
--------------------------------------------------------------------------------

local function startServer()
  if CEMCP.running then
    log("Server already running")
    return true
  end

  local success, err = pcall(function()
    openLuaServer(CONFIG.pipeName)
  end)

  if success then
    CEMCP.running = true
    CEMCP.commandCount = 0
    log("Server started on pipe: \\\\.\\pipe\\" .. CONFIG.pipeName)
    updateMenuState()
    return true
  else
    log("ERROR: Failed to start server: " .. tostring(err))
    return false
  end
end

local function stopServer()
  if not CEMCP.running then
    log("Server not running")
    return
  end

  -- Note: CE doesn't have a closeLuaServer function
  -- The server stops when CE closes
  -- We can only mark it as "logically stopped" for the UI
  log("Server stop requested (will fully stop when CE closes)")
  CEMCP.running = false
  updateMenuState()
end

local function getStatus()
  local status = CEMCP.running and "RUNNING" or "STOPPED"
  local pid = getOpenedProcessID()
  local processName = pid and pid > 0 and process or "None"
  local securityStatus = getSecurityStatus()

  return string.format(
    "MCP Server: %s\n" ..
    "Security: %s\n" ..
    "Pipe: \\\\.\\pipe\\%s\n" ..
    "Commands processed: %d\n" ..
    "Attached process: %s (PID: %s)",
    status,
    securityStatus,
    CONFIG.pipeName,
    CEMCP.commandCount,
    processName,
    pid or "N/A"
  )
end

--------------------------------------------------------------------------------
-- Menu
--------------------------------------------------------------------------------

function updateMenuState()
  if not CEMCP.menuItems.start then return end

  CEMCP.menuItems.start.Enabled = not CEMCP.running
  CEMCP.menuItems.stop.Enabled = CEMCP.running

  -- Update caption to show state and security
  checkUnsafeMode()
  if CEMCP.menu then
    local stateIcon = CEMCP.running and "ON" or "OFF"
    local secIcon = CEMCP.isUnsafe and "UNSAFE" or "SAFE"
    CEMCP.menu.Caption = string.format("MCP [%s|%s]", stateIcon, secIcon)
  end

  -- Update menu items and colored status label
  updateSecurityMenuItem()
  updateStatusLabel()
end

-- Status indicator in the status bar (colored)

function createStatusLabel()
  local mainForm = getMainForm()
  if not mainForm or CEMCP.statusLabel then return end

  -- Find the status bar
  local statusBar = nil
  for i = 0, mainForm.ControlCount - 1 do
    local ctrl = mainForm.Control[i]
    if ctrl.ClassName == "TStatusBar" then
      statusBar = ctrl
      break
    end
  end

  if statusBar then
    -- Create a panel on the status bar
    CEMCP.statusLabel = createPanel(statusBar)
    CEMCP.statusLabel.Caption = "MCP: SAFE"
    CEMCP.statusLabel.Font.Name = "Consolas"
    CEMCP.statusLabel.Font.Size = 9
    CEMCP.statusLabel.Font.Style = "fsBold"
    CEMCP.statusLabel.BevelOuter = "bvNone"
    CEMCP.statusLabel.Align = "alRight"
    CEMCP.statusLabel.Width = 100
    CEMCP.statusLabel.Alignment = "taCenter"
    log("Status indicator added to status bar")
  else
    -- Fallback: create label at bottom of form
    CEMCP.statusLabel = createPanel(mainForm)
    CEMCP.statusLabel.Caption = "MCP: SAFE"
    CEMCP.statusLabel.Font.Name = "Consolas"
    CEMCP.statusLabel.Font.Size = 9
    CEMCP.statusLabel.Font.Style = "fsBold"
    CEMCP.statusLabel.BevelOuter = "bvLowered"
    CEMCP.statusLabel.Align = "alBottom"
    CEMCP.statusLabel.Height = 20
    CEMCP.statusLabel.Alignment = "taCenter"
    log("Status indicator added to bottom of form (no status bar found)")
  end

  updateStatusLabel()
end

function updateSecurityMenuItem()
  if not CEMCP.menuItems.security then return end

  if CEMCP.isUnsafe then
    CEMCP.menuItems.security.Caption = "Mode: UNSAFE (click to lock)"
  else
    CEMCP.menuItems.security.Caption = "Mode: SAFE (click to unlock)"
  end
end

function updateStatusLabel()
  if not CEMCP.statusLabel then return end

  if CEMCP.isUnsafe then
    CEMCP.statusLabel.Caption = " MCP: UNSAFE "
    CEMCP.statusLabel.Font.Color = 0x0000FF  -- Red (BGR format)
    CEMCP.statusLabel.Color = 0xCCCCFF      -- Light red background
  else
    CEMCP.statusLabel.Caption = " MCP: SAFE "
    CEMCP.statusLabel.Font.Color = 0x006600  -- Dark green (BGR format)
    CEMCP.statusLabel.Color = 0xCCFFCC      -- Light green background
  end
end

local function createMenu()
  -- Find or create main menu
  local mainForm = getMainForm()
  if not mainForm then
    log("ERROR: Cannot find main form")
    return
  end

  local mainMenu = mainForm.Menu
  if not mainMenu then
    log("ERROR: Cannot find main menu")
    return
  end

  -- Create MCP menu
  CEMCP.menu = createMenuItem(mainMenu)
  CEMCP.menu.Caption = "MCP Server"
  mainMenu.Items.add(CEMCP.menu)

  -- Start item
  CEMCP.menuItems.start = createMenuItem(CEMCP.menu)
  CEMCP.menuItems.start.Caption = "Start Server"
  CEMCP.menuItems.start.OnClick = function()
    if startServer() then
      notify("Server started")
    end
  end
  CEMCP.menu.add(CEMCP.menuItems.start)

  -- Stop item
  CEMCP.menuItems.stop = createMenuItem(CEMCP.menu)
  CEMCP.menuItems.stop.Caption = "Stop Server"
  CEMCP.menuItems.stop.OnClick = function()
    stopServer()
    notify("Server stopped")
  end
  CEMCP.menu.add(CEMCP.menuItems.stop)

  -- Separator
  local sep = createMenuItem(CEMCP.menu)
  sep.Caption = "-"
  CEMCP.menu.add(sep)

  -- Status item
  CEMCP.menuItems.status = createMenuItem(CEMCP.menu)
  CEMCP.menuItems.status.Caption = "Show Status"
  CEMCP.menuItems.status.OnClick = function()
    showMessage(getStatus())
  end
  CEMCP.menu.add(CEMCP.menuItems.status)

  -- Log window item
  CEMCP.menuItems.logs = createMenuItem(CEMCP.menu)
  CEMCP.menuItems.logs.Caption = "Show Logs"
  CEMCP.menuItems.logs.OnClick = function()
    showLogWindow()
  end
  CEMCP.menu.add(CEMCP.menuItems.logs)

  -- Separator
  local sep2 = createMenuItem(CEMCP.menu)
  sep2.Caption = "-"
  CEMCP.menu.add(sep2)

  -- Auto-start toggle
  CEMCP.menuItems.autostart = createMenuItem(CEMCP.menu)
  CEMCP.menuItems.autostart.Caption = "Auto-start: " .. (CONFIG.autoStart and "ON" or "OFF")
  CEMCP.menuItems.autostart.OnClick = function()
    CONFIG.autoStart = not CONFIG.autoStart
    CEMCP.menuItems.autostart.Caption = "Auto-start: " .. (CONFIG.autoStart and "ON" or "OFF")
    log("Auto-start set to: " .. tostring(CONFIG.autoStart))
  end
  CEMCP.menu.add(CEMCP.menuItems.autostart)

  -- Separator before security toggle
  local sep3 = createMenuItem(CEMCP.menu)
  sep3.Caption = "-"
  CEMCP.menu.add(sep3)

  -- Security mode toggle (SAFE/UNSAFE)
  CEMCP.menuItems.security = createMenuItem(CEMCP.menu)
  CEMCP.menuItems.security.Caption = "Mode: SAFE"
  CEMCP.menuItems.security.OnClick = function()
    _mcp_unsafe = not _mcp_unsafe
    CEMCP.isUnsafe = _mcp_unsafe
    updateSecurityMenuItem()
    updateStatusLabel()
    log("Security mode: " .. (CEMCP.isUnsafe and "UNSAFE" or "SAFE"))
  end
  CEMCP.menu.add(CEMCP.menuItems.security)

  -- Create colored status indicator
  createStatusLabel()

  updateMenuState()
  log("Menu created")
end

--------------------------------------------------------------------------------
-- Log Window
--------------------------------------------------------------------------------

function showLogWindow()
  if CEMCP.logForm then
    CEMCP.logForm.show()
    return
  end

  -- Create log window
  CEMCP.logForm = createForm()
  CEMCP.logForm.Caption = "CE-MCP Server Logs"
  CEMCP.logForm.Width = 600
  CEMCP.logForm.Height = 400
  CEMCP.logForm.Position = "poScreenCenter"

  -- Create memo for logs
  CEMCP.logForm.Memo = createMemo(CEMCP.logForm)
  CEMCP.logForm.Memo.Align = "alClient"
  CEMCP.logForm.Memo.ReadOnly = true
  CEMCP.logForm.Memo.ScrollBars = "ssVertical"
  CEMCP.logForm.Memo.Font.Name = "Consolas"
  CEMCP.logForm.Memo.Font.Size = 10

  -- Add initial log
  CEMCP.logForm.Memo.Lines.add("=== CE-MCP Server Logs ===")
  CEMCP.logForm.Memo.Lines.add("Pipe: \\\\.\\pipe\\" .. CONFIG.pipeName)
  CEMCP.logForm.Memo.Lines.add("")

  CEMCP.logForm.show()
end

--------------------------------------------------------------------------------
-- Breakpoint Handler for MCP
--------------------------------------------------------------------------------

-- Persistent storage for breakpoint hits (survives across MCP calls)
CEMCP_breakpointHits = {}
CEMCP_activeBreakpoints = {}

-- Set a breakpoint with MCP-compatible callback
function CEMCP_setBreakpoint(address, bpType, size)
  local addr = getAddress(address)
  if not addr then
    return { error = "Invalid address" }
  end

  -- Clear previous hits for this address
  CEMCP_breakpointHits[addr] = {}

  local bpTypeMap = {
    access = bptAccess,
    write = bptWrite,
    execute = bptExecute
  }
  local bp = bpTypeMap[bpType] or bptAccess

  debug_setBreakpoint(addr, size or 4, bp, function()
    -- All code in pcall to catch any errors
    local ok, err = pcall(function()
      -- RIP/EIP are global variables set by CE when breakpoint hits
      local rip = RIP or EIP or 0
      local disasmText = "unknown"

      -- Disassemble the instruction (safely)
      if rip ~= 0 then
        local dok, dresult = pcall(disassemble, rip)
        if dok and dresult then
          disasmText = dresult
        end
      end

      -- Capture registers (64-bit with 32-bit fallback)
      local hit = {
        address = rip,
        disasm = disasmText,
        regs = {
          rax = RAX or EAX or 0,
          rbx = RBX or EBX or 0,
          rcx = RCX or ECX or 0,
          rdx = RDX or EDX or 0,
          rsi = RSI or ESI or 0,
          rdi = RDI or EDI or 0,
          rbp = RBP or EBP or 0,
          rsp = RSP or ESP or 0,
        }
      }

      -- Store in our persistent table
      if not CEMCP_breakpointHits[addr] then
        CEMCP_breakpointHits[addr] = {}
      end
      table.insert(CEMCP_breakpointHits[addr], hit)
    end)

    if not ok then
      print('[CE-MCP] BP callback error: ' .. tostring(err))
    end

    -- Remove after 20 hits to prevent memory bloat
    if #CEMCP_breakpointHits[addr] >= 20 then
      debug_removeBreakpoint(addr)
      CEMCP_activeBreakpoints[addr] = nil
      log("Breakpoint auto-removed after 20 hits")
    end

    return 0  -- Continue execution without pausing (0=continue, 1=break)
  end)

  CEMCP_activeBreakpoints[addr] = true
  log(string.format("Breakpoint set at 0x%X (%s, %d bytes)", addr, bpType, size or 4))

  return { success = true, address = addr }
end

-- Get breakpoint hits
function CEMCP_getBreakpointHits(address)
  if address then
    local addr = getAddress(address)
    return CEMCP_breakpointHits[addr] or {}
  else
    -- Return all hits
    local allHits = {}
    for addr, hits in pairs(CEMCP_breakpointHits) do
      for _, hit in ipairs(hits) do
        hit.targetAddress = addr
        table.insert(allHits, hit)
      end
    end
    return allHits
  end
end

-- Clear breakpoint hits
function CEMCP_clearBreakpointHits(address)
  if address then
    local addr = getAddress(address)
    CEMCP_breakpointHits[addr] = {}
  else
    CEMCP_breakpointHits = {}
  end
end

-- Remove a breakpoint
function CEMCP_removeBreakpoint(address)
  if address then
    local addr = getAddress(address)
    debug_removeBreakpoint(addr)
    CEMCP_activeBreakpoints[addr] = nil
    CEMCP_breakpointHits[addr] = nil
  else
    debug_removeBreakpoint()
    CEMCP_activeBreakpoints = {}
    CEMCP_breakpointHits = {}
  end
end

--------------------------------------------------------------------------------
-- Enhanced Lua Functions for MCP
--------------------------------------------------------------------------------

-- These functions provide better formatted output for MCP consumption

-- Called by MCP server to log commands to CE console
function CEMCP_logCommand(toolName, args)
  CEMCP.commandCount = CEMCP.commandCount + 1
  CEMCP.lastCommandTime = os.time()

  local argsStr = args and (" " .. tostring(args)) or ""
  log(string.format(">> %s%s", toolName, argsStr))

  -- Refresh menu state (updates security indicator)
  updateMenuState()
end

-- Check if writes are allowed (called by MCP for verification)
function CEMCP_isUnsafe()
  return checkUnsafeMode()
end

-- Get current security mode as string
function CEMCP_getSecurityMode()
  checkUnsafeMode()
  return CEMCP.isUnsafe and "unsafe" or "safe"
end

function CEMCP_getProcessInfo()
  local pid = getOpenedProcessID()
  if not pid or pid == 0 then
    return { attached = false }
  end

  return {
    attached = true,
    pid = pid,
    is64bit = targetIs64Bit(),
    processName = process or "Unknown"
  }
end

function CEMCP_readMemoryTable(address, dataType, count)
  count = count or 1
  local results = {}
  local addr = getAddress(address)

  if not addr then
    return { error = "Invalid address: " .. tostring(address) }
  end

  local readFunc = {
    byte = readBytes,
    int16 = readSmallInteger,
    int32 = readInteger,
    int64 = readQword,
    float = readFloat,
    double = readDouble,
  }

  local func = readFunc[dataType]
  if not func then
    return { error = "Unknown type: " .. tostring(dataType) }
  end

  local size = ({ byte=1, int16=2, int32=4, int64=8, float=4, double=8 })[dataType]

  for i = 1, count do
    local value = func(addr + (i-1) * size)
    table.insert(results, {
      address = string.format("0x%X", addr + (i-1) * size),
      value = value
    })
  end

  return results
end

function CEMCP_scanValue(valueType, value, startAddr, stopAddr)
  -- Map valueType string to CE variable type constant
  local vtMap = {
    byte = vtByte,
    int8 = vtByte,
    int16 = vtWord,
    int32 = vtDword,
    int64 = vtQword,
    float = vtSingle,
    double = vtDouble,
    string = vtString,
    aob = vtByteArray,
  }
  local vt = vtMap[valueType] or vtDword

  -- Configure scan
  local ms = getMemScan()
  if not ms then
    ms = createMemScan()
  end

  ms.firstScan(
    soExactValue,           -- Scan option
    vt,                     -- Variable type (mapped from valueType)
    rtRounded,              -- Round type
    value,                  -- Value to find
    nil,                    -- Second value (for between scans)
    startAddr or 0,         -- Start address
    stopAddr or 0x7FFFFFFF, -- Stop address
    "*X*W",                 -- Protection flags
    fsmNotAligned,          -- Fast scan method
    nil,                    -- Fast scan alignment
    false,                  -- Hex input
    false,                  -- Unicode
    false                   -- Case sensitive
  )

  ms.waitTillDone()

  local fl = createFoundList(ms)
  fl.initialize()

  local results = {}
  for i = 0, math.min(fl.Count - 1, 100) do
    table.insert(results, fl.Address[i])
  end

  fl.destroy()

  return results
end

--------------------------------------------------------------------------------
-- Initialization
--------------------------------------------------------------------------------

local function initialize()
  log("Initializing CE-MCP plugin...")

  -- Create menu (delayed to ensure main form is ready)
  createTimer().OnTimer = function(timer)
    timer.destroy()
    createMenu()

    -- Auto-start if configured
    if CONFIG.autoStart then
      log("Auto-starting server...")
      startServer()
    end
  end

  log("Plugin loaded")
end

-- Run initialization
initialize()
