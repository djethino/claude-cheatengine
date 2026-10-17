import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { initLua, LuaVM } from './lua-vm.js';
import { lua, luaInt, luaNum, luaStr, raw } from '../src/lua/lit.js';

const HOSTILE = [
  '',
  "x'); writeBytes(0x1000, 0x90); --",
  'a"b\\c',
  ']]..os.exit()..[[',
  'line1\nline2\r\n\ttab',
  'nul\u0000byte',
  "Baldur's Gate 3.exe",
  'émoji 🎮 日本語',
  '\\',
  '%s%d%%',
];

before(initLua);

test('luaStr: every hostile string comes back unchanged and runs nothing', () => {
  const vm = new LuaVM();
  for (const value of HOSTILE) {
    // Compare byte strings: Lua strings are bytes, the test passes the expected bytes as hex
    const hex = Buffer.from(value, 'utf8').toString('hex');
    const ok = vm.run(`
      local s = ${luaStr(value)}
      local hex = s:gsub('.', function(c) return string.format('%02x', c:byte()) end)
      return hex == '${hex}'`);
    assert.equal(ok, true, `round trip failed for ${JSON.stringify(value)}`);
  }
});

test('luaStr: only printable ASCII is kept as is', () => {
  assert.equal(luaStr('ab'), '"ab"');
  assert.equal(luaStr('"'), '"\\034"');
  assert.equal(luaStr('\\'), '"\\092"');
  assert.equal(luaStr('\n'), '"\\010"');
  assert.equal(luaStr('é'), '"\\195\\169"');
});

test('lua template: values become literals, raw() stays code', () => {
  const name = "x'); evil(); --";
  const code = lua`return ${name}, ${42}, ${0.5}, ${true}, ${2n ** 62n}, ${raw('1 + 1')}`;
  const vm = new LuaVM();
  vm.run(`function evil() error('injected') end`);
  const result = vm.run(`
    local a, b, c, d, e, f = (function() ${code.code} end)()
    return table.concat({ a, tostring(b), tostring(c), tostring(d), tostring(e), tostring(f) }, '|')`);
  assert.equal(result, `${name}|42|0.5|true|4611686018427387904|2`);
});

test('lua template: refuses values it cannot encode', () => {
  assert.throws(() => lua`${Number.NaN}`, RangeError);
  assert.throws(() => lua`${Infinity}`, RangeError);
  assert.throws(() => lua`${undefined as unknown as string}`, TypeError);
  assert.throws(() => lua`${{} as unknown as string}`, TypeError);
});

test('luaInt / luaNum edge cases', () => {
  assert.equal(luaInt(-(2n ** 63n)), 'math.mininteger');
  assert.equal(luaInt(2n ** 63n - 1n), '9223372036854775807');
  assert.throws(() => luaInt(2n ** 63n), RangeError);
  assert.throws(() => luaInt(1.5), RangeError);
  assert.equal(luaNum(3), '3');
  assert.equal(luaNum(-0.25), '-0.25');
  assert.equal(luaNum(1e21), '1e+21');
  // Integral beyond 2^53 or fractional: a float literal that Lua reads back as the same double
  const vm = new LuaVM();
  for (const value of [2 ** 60, 2 ** 53 + 2, 1e21, -1.5e-7, 0.1, Number.MAX_VALUE]) {
    const literal = luaNum(value);
    const bits = Buffer.alloc(8);
    bits.writeDoubleLE(value);
    const luaBits = vm.run(`
      local x = ${literal}
      return math.type(x) .. ' ' .. (string.pack('<d', x):gsub('.', function(c) return string.format('%02x', c:byte()) end))`);
    assert.equal(luaBits, `float ${bits.toString('hex')}`, `literal ${literal}`);
  }
});
