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
