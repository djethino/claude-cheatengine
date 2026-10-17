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

-- Kept across reconnections of the same CE session (running jobs survive a server restart)
_mcp = _mcp or {}
_mcp.version = server.version

print(string.format('[CE-MCP] asymptomatik-cheatengine %s connected - Mode: %s', server.version, _mcp_unsafe and 'UNSAFE' or 'SAFE'))
