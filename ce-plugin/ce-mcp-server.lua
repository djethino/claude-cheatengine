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
  return CEMCP.isUnsafe and "UNSAFE (crash-prone tools allowed)" or "SAFE (crash-prone tools locked)"
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
-- Functions called by the MCP server
--------------------------------------------------------------------------------

-- Log a command to the CE console and the MCP log window
function CEMCP_logCommand(toolName, args)
  CEMCP.commandCount = CEMCP.commandCount + 1
  CEMCP.lastCommandTime = os.time()

  local argsStr = args and (" " .. tostring(args)) or ""
  log(string.format(">> %s%s", toolName, argsStr))

  -- Refresh menu state (updates security indicator)
  updateMenuState()
end

--------------------------------------------------------------------------------
-- Initialization
--------------------------------------------------------------------------------

-- FNV-1a (32-bit) of this script's own file: the MCP server compares it with the copy it ships,
-- to tell the user to restart CE when CE still runs an older plugin script
local function scriptHash()
  local source = debug.getinfo(1, 'S').source
  if source:sub(1, 1) ~= '@' then return nil end
  local f = io.open(source:sub(2), 'rb')
  if not f then return nil end
  local data = f:read('a')
  f:close()
  local h = 2166136261
  for i = 1, #data do h = ((h ~ data:byte(i)) * 16777619) & 0xFFFFFFFF end
  return h
end

local function initialize()
  log("Initializing CE-MCP plugin...")
  CEMCP.scriptHash = scriptHash()

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
