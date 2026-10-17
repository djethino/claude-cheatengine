import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FakeCE } from './fake-ce.js';
import { Session, BLOCKED_DANGEROUS, BLOCKED_NO_PROCESS, OwnershipError } from '../src/ce/session.js';
import { CEPipeError } from '../src/ce/pipe.js';
import { lua } from '../src/lua/lit.js';

let ce: FakeCE;
let session: Session;
const call = (tool = 'test_tool') => ({ tool, args: '' });

before(async () => {
  ce = await FakeCE.start();
});
after(async () => {
  await ce.stop();
});
beforeEach(async () => {
  session?.close();
  ce.resetLuaState();
  session = new Session(ce.path, 'test');
});

test('run returns the text left in _mcp_str, null when nothing is set', async () => {
  const text = await session.exclusive(call(), (s) => s.run(lua`_mcp_str = 'hello ' .. ${'wörld'}`));
  assert.equal(text, 'hello wörld');
  assert.equal(await session.exclusive(call(), (s) => s.run(lua`local x = 1`)), null);
  assert.equal(await session.exclusive(call(), (s) => s.run(lua`_mcp_str = 12.5`)), '12.5');
});

test('Lua errors are reported, syntax errors too', async () => {
  const runtime = await session.exclusive(call(), (s) => s.run(lua`error('boom')`));
  assert.match(runtime ?? '', /^LUA_ERROR: .*boom/);
  const syntax = await session.exclusive(call(), (s) => s.run(lua`_mcp_str = (`));
  assert.match(syntax ?? '', /^LUA_SYNTAX_ERROR: /);
});

test('first connection resets SAFE mode and claims CE; the call is logged once', async () => {
  ce.exec('_mcp_unsafe = true');
  await session.exclusive(call('ce_x'), async (s) => {
    await s.run(lua`_mcp_str = 'a'`);
    await s.run(lua`_mcp_str = 'b'`);
  });
  assert.equal(ce.eval('_mcp_unsafe'), false);
  assert.equal(ce.eval('#__fake.logs'), 1);
  assert.equal(ce.eval('__fake.logs[1]'), 'ce_x ');
});

test('dangerous bodies are refused in SAFE mode, inside the same chunk', async () => {
  ce.exec('ran = false');
  const blocked = await session.exclusive(call(), (s) => s.run(lua`ran = true _mcp_str = 'done'`, { dangerous: true }));
  assert.equal(blocked, BLOCKED_DANGEROUS);
  assert.equal(ce.eval('ran'), false);
  // Unlocked from CE (menu toggle) after the server started
  ce.exec('_mcp_unsafe = true');
  const allowed = await session.exclusive(call(), (s) => s.run(lua`ran = true _mcp_str = 'done'`, { dangerous: true }));
  assert.equal(allowed, 'done');
});

test('requiresProcess refuses while no process is opened', async () => {
  const blocked = await session.exclusive(call(), (s) => s.run(lua`_mcp_str = 'read'`, { requiresProcess: true }));
  assert.equal(blocked, BLOCKED_NO_PROCESS);
  ce.exec('__fake.pid = 1234');
  assert.equal(await session.exclusive(call(), (s) => s.run(lua`_mcp_str = 'read'`, { requiresProcess: true })), 'read');
});

test('long output: truncated at maxBytes on a UTF-8 boundary, continued with readMore', async () => {
  // 'é' is 2 bytes: 7 bytes of 'a' then 'é' puts a character across the 8-byte cut
  const full = 'aaaaaaaé' + 'b'.repeat(20) + 'é';
  const first = await session.exclusive(call(), (s) => s.run(lua`_mcp_str = ${full}`, { maxBytes: 8 }));
  assert.equal(first, `aaaaaaa\n[truncated: bytes 1-7 of 31 shown. Call ce_output_more(offset=7) next to read the rest; calling any other tool discards it]`);
  const rest = await session.exclusive(call('ce_output_more'), (s) => s.readMore(7, 100));
  assert.equal(rest, 'é' + 'b'.repeat(20) + 'é');
});

test('another tool call discards the pending continuation', async () => {
  await session.exclusive(call(), (s) => s.run(lua`_mcp_str = ${'x'.repeat(50)}`, { maxBytes: 10 }));
  await session.exclusive(call('other'), (s) => s.run(lua`_mcp_str = 'y'`));
  const more = await session.exclusive(call('ce_output_more'), (s) => s.readMore(10, 100));
  assert.match(more, /^Nothing to continue/);
});

test('64-bit exact transfer of every byte value', async () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const text = await session.exclusive(call(), (s) =>
    s.run(lua`local t = {} for i = 0, 255 do t[#t + 1] = string.char(i) end _mcp_str = table.concat(t)`, { maxBytes: 1000 }),
  );
  // Bytes 0x80-0xff are not valid UTF-8 alone: shown as \xNN
  const expected = bytes.subarray(0, 128).toString('latin1') + Array.from(bytes.subarray(128), (b) => `\\x${b.toString(16)}`).join('');
  assert.equal(text, expected);
});

test('concurrent calls never interleave', async () => {
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      session.exclusive(call(), (s) => s.run(lua`_mcp_str = string.rep(${String(i)}, 40)`)),
    ),
  );
  results.forEach((text, i) => assert.equal(text, String(i).repeat(40)));
});

test('timeout: error, then the next call reconnects and works', async () => {
  // Connect first: the delay must hit the tool's script, not the connection setup
  await session.exclusive(call(), (s) => s.run(lua`_mcp_str = 'warm'`));
  ce.delayNext = 500;
  await assert.rejects(
    session.exclusive(call(), (s) => s.run(lua`_mcp_str = 'slow'`, { timeoutMs: 100 })),
    (err: Error) => err instanceof CEPipeError && /did not answer within 0.1 s/.test(err.message),
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(await session.exclusive(call(), (s) => s.run(lua`_mcp_str = 'fast'`)), 'fast');
});

test('CE restart: the next call sets the connection up again', async () => {
  await session.exclusive(call(), (s) => s.run(lua`_mcp_str = 'before'`));
  ce.dropConnections();
  ce.resetLuaState();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await session.exclusive(call(), (s) => s.run(lua`_mcp_str = 'after'`)), 'after');
  assert.equal(ce.eval('_mcp ~= nil'), true);
});

test('second server: refused while the first one is active, until it takes over', async () => {
  await session.exclusive(call(), (s) => s.run(lua`_mcp_str = 'first'`));
  const other = new Session(ce.path, 'test');
  try {
    await assert.rejects(
      other.exclusive(call(), (s) => s.run(lua`_mcp_str = 'second'`)),
      (err: Error) => err instanceof OwnershipError,
    );
    await other.exclusive(call(), (s) => s.takeOver());
    assert.equal(await other.exclusive(call(), (s) => s.run(lua`_mcp_str = 'second'`)), 'second');
    await assert.rejects(session.exclusive(call(), (s) => s.run(lua`_mcp_str = 'first'`)), OwnershipError);
  } finally {
    other.close();
  }
});

test('pause() lets other calls run while a job waits', async () => {
  const order: string[] = [];
  const job = session.exclusive(call('job'), async (s) => {
    order.push('job start');
    await s.pause(50);
    order.push('job end');
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await session.exclusive(call('quick'), async () => {
    order.push('quick');
  });
  await job;
  assert.deepEqual(order, ['job start', 'quick', 'job end']);
});
