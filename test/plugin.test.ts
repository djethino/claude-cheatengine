import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initLua, LuaVM } from './lua-vm.js';
import { luaStr } from '../src/lua/lit.js';
import { pluginScriptHash } from '../src/install.js';
import pluginScript from '../ce-plugin/ce-mcp-server.lua';

before(initLua);

test("the CE plugin's own hash (Lua) matches the server's (TypeScript)", () => {
  // The loop of scriptHash() in ce-plugin/ce-mcp-server.lua, on the shipped script's bytes
  assert.match(pluginScript, /for i = 1, #data do h = \(\(h ~ data:byte\(i\)\) \* 16777619\) & 0xFFFFFFFF end/);
  const vm = new LuaVM();
  const lua = vm.run(`
    local data = ${luaStr(pluginScript)}
    local h = 2166136261
    for i = 1, #data do h = ((h ~ data:byte(i)) * 16777619) & 0xFFFFFFFF end
    return h`);
  assert.equal(lua, pluginScriptHash());
});

// CE's GUI as objects that accept anything; the plugin's start-up timer is run by hand
const GUI_STUBS = `
local function obj()
  return setmetatable({}, { __index = function(t, k)
    local v = (k == 'add' or k == 'destroy' or k == 'show') and function() end or obj()
    rawset(t, k, v)
    return v
  end })
end
local mainForm = obj()
mainForm.ControlCount = 0
function getMainForm() return mainForm end
function createMenuItem() return obj() end
function createPanel() return obj() end
__timers = {}
function createTimer() local t = obj() __timers[#__timers + 1] = t return t end
function print() end
__messages, __opened = {}, 0
function showMessage(m) __messages[#__messages + 1] = m end
function openLuaServer(name) __opened = __opened + 1 __openedName = name end
__probe = nil
function connectToPipe(name) if __otherServer then __probe = { destroyed = false, destroy = function() __probe.destroyed = true end } return __probe end end
`;

function startPlugin(otherServer: boolean): LuaVM {
  const vm = new LuaVM();
  vm.run(GUI_STUBS);
  vm.run(`__otherServer = ${otherServer}`);
  vm.run(pluginScript);
  vm.run('__timers[1].OnTimer(__timers[1])');
  return vm;
}

test('the CE plugin opens the pipe server, or stays off when another Cheat Engine serves it', () => {
  const alone = startPlugin(false);
  assert.equal(alone.run('return __opened'), 1);
  assert.equal(alone.run('return __openedName'), 'ce-mcp');
  assert.equal(alone.run('return CEMCP.statusLabel.Caption'), ' MCP: SAFE ');
  // Stop then start from the menu: CE cannot close a Lua server, the one opened is reused
  alone.run('CEMCP.menuItems.stop.OnClick() CEMCP.menuItems.start.OnClick()');
  assert.equal(alone.run('return __opened'), 1);
  assert.equal(alone.run('return CEMCP.running'), true);

  const second = startPlugin(true);
  assert.equal(second.run('return __opened'), 0);
  assert.equal(second.run('return __probe.destroyed'), true);
  assert.equal(second.run('return CEMCP.running'), false);
  assert.equal(second.run('return CEMCP.statusLabel.Caption'), ' MCP: OFF (other CE) ');
  assert.match(String(second.run('return __messages[#__messages]')), /another Cheat Engine already serves Claude Code/);
});
