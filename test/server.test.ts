import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { useHarness } from './harness.js';
import { Session, BLOCKED_DANGEROUS } from '../src/ce/session.js';
import { createServer, BLOCKED_READ_ONLY } from '../src/server.js';
import { allTools } from '../src/tools/index.js';

// Replies split in two writes: the client must reassemble them
const h = useHarness({ splitReplies: true });

test('ce_status reports the connection and SAFE mode', async () => {
  const { text, isError } = await h.call('ce_status');
  assert.match(text, /^Connected: Lua 5\.4 - CE 7\.7 \(PID: 0\) \[safe\]\nCE plugin:/);
  assert.equal(isError, false);
});

test('Cheat Engine older than 7.7 is refused with a clear message', async () => {
  h.ce.exec('__fake.ceVersion = 7.6');
  // ce_status reports it (with the install state); any other tool fails with it
  assert.match((await h.call('ce_status')).text, /^Not connected: Cheat Engine 7\.7 or later is required \(this is CE 7\.6\)/);
  const { text, isError } = await h.call('ce_process_info');
  assert.match(text, /^Error: Cheat Engine 7\.7 or later is required \(this is CE 7\.6\)/);
  assert.equal(isError, true);
});

test('ce_lua is locked in SAFE mode and reported as an error', async () => {
  const { text, isError } = await h.call('ce_lua', { code: 'return 1' });
  assert.equal(text, BLOCKED_DANGEROUS);
  assert.equal(isError, true);
});

test('ce_lua after /unsafe-ce: every return value, run once, syntax errors reported', async () => {
  await h.unlock();
  assert.equal((await h.call('ce_lua', { code: "counter = (counter or 0) + 1 return '', 42, nil" })).text, '\t42\tnil');
  assert.equal(h.ce.eval('counter'), 1); // the Python server ran this code twice (empty string result)
  assert.equal((await h.call('ce_lua', { code: 'local s = "multi"\nreturn s .. "line"' })).text, 'multiline');
  assert.equal((await h.call('ce_lua', { code: 'x = 1' })).text, '(no return value)');
  const syntax = await h.call('ce_lua', { code: 'return (' });
  assert.match(syntax.text, /^LUA_SYNTAX_ERROR: /);
  assert.equal(syntax.isError, true);
  assert.match((await h.call('ce_lua', { code: "error('boom')" })).text, /^LUA_ERROR: .*boom/);
});

test('ce_lua without a process attached adds the nudge', async () => {
  await h.call('ce_safety_enable_writes', { confirm: 'USER_CONFIRMED' });
  assert.equal((await h.call('ce_lua', { code: 'return 5' })).text, '5\n[NUDGE: No process attached - be careful with memory operations]');
});

test('the unlock needs the user to click Yes in Cheat Engine, and names the anti-cheat', async () => {
  h.ce.exec('__fake.dialogAnswer = mrNo');
  const declined = await h.call('ce_safety_enable_writes', { confirm: 'USER_CONFIRMED' });
  assert.equal(declined.text, 'BLOCKED: the user declined the unlock in Cheat Engine');
  assert.equal(declined.isError, true);
  assert.notEqual(h.ce.eval('_mcp_unsafe'), true);
  h.ce.exec('__fake.dialogAnswer = mrYes; __fake.pid = 5555; _mcp.ac = { [5555] = "BattlEye" }');
  assert.match((await h.call('ce_safety_enable_writes', { confirm: 'USER_CONFIRMED' })).text, /^UNSAFE mode enabled \(confirmed by the user in Cheat Engine\)/);
  assert.match(String(h.ce.eval('__fake.dialogs[2]')), /ANTI-CHEAT DETECTED in game\.exe: BattlEye\.\nUsing Cheat Engine on this game can get your account banned/);
  assert.equal(h.ce.eval('_mcp_unsafe'), true);
});

test('enable writes needs the confirmation token', async () => {
  const { text, isError } = await h.call('ce_safety_enable_writes');
  assert.match(text, /^BLOCKED: Use the \/unsafe-ce command/);
  assert.equal(isError, true);
  assert.notEqual(h.ce.eval('_mcp_unsafe'), true);
});

test('read-only mode refuses writing tools before contacting CE', async () => {
  process.env.CLAUDE_PLUGIN_OPTION_READ_ONLY = 'true';
  h.ce.exec('_mcp_unsafe = true');
  const before = h.ce.scripts.length;
  assert.equal((await h.call('ce_lua', { code: 'return 1' })).text, BLOCKED_READ_ONLY);
  assert.equal(h.ce.scripts.length, before);
  assert.match((await h.call('ce_status')).text, /Read-only mode: on/);
});

test('long outputs are truncated and continued through ce_output_more', async () => {
  await h.unlock();
  const first = await h.call('ce_lua', { code: "return string.rep('x', 12000)" });
  assert.match(first.text, /\[truncated: bytes 1-10000 of 12000 shown\. Call ce_output_more\(offset=10000\)/);
  assert.equal((await h.call('ce_output_more', { offset: 10000 })).text, 'x'.repeat(2000));
});

test('CE not running: a clear error', async () => {
  const offline = new Session('\\\\.\\pipe\\ce-mcp-no-such-pipe', 'test');
  const server = createServer(offline, allTools, 'test');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(clientSide);
  const status = await c.callTool({ name: 'ce_status', arguments: {} });
  assert.match((status.content as Array<{ text: string }>)[0].text, /^Not connected: Cannot connect to .*Cheat Engine is not running.*\nCE plugin:/);
  const result = await c.callTool({ name: 'ce_process_info', arguments: {} });
  assert.match((result.content as Array<{ text: string }>)[0].text, /^Error: Cannot connect to .*Cheat Engine is not running/);
  assert.equal(result.isError, true);
  await c.close();
  offline.close();
});
