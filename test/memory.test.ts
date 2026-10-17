import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness } from './harness.js';
import { BLOCKED_NO_PROCESS } from '../src/ce/session.js';
import { parseInteger } from '../src/tools/memory.js';

const h = useHarness();

test('ce_attach: name and PID, hostile names stay data', async () => {
  assert.equal((await h.call('ce_attach', { process: 'game.exe' })).text, 'Attached to PID: 4242 (game.exe, x64)');
  assert.equal((await h.call('ce_attach', { process: '1234' })).text, 'Attached to PID: 1234 (game.exe, x64)');
  // The Python server pasted this into openProcess('...') and ran the injected code
  h.ce.exec('injected = false');
  await h.call('ce_attach', { process: "x'); injected = true; --" });
  assert.equal(h.ce.eval('injected'), false);
});

test('tools that need a process refuse without one', async () => {
  const { text, isError } = await h.call('ce_read_memory', { address: '0x400000', type: 'int32' });
  assert.equal(text, BLOCKED_NO_PROCESS);
  assert.equal(isError, true);
});

test('lists are paginated and filtered in CE', async () => {
  h.ce.exec('__fake.pid = 7');
  assert.equal(
    (await h.call('ce_list_modules')).text,
    'modules 1-2 of 2\ngame.exe: 0x400000 (size: 0x1000)\nother.dll: 0x800000 (size: 0x100)',
  );
  assert.equal(
    (await h.call('ce_list_modules', { limit: 1 })).text,
    'modules 1-1 of 2\ngame.exe: 0x400000 (size: 0x1000)\n... 1 more, next page: offset=1',
  );
  assert.equal((await h.call('ce_list_modules', { filter: 'DLL' })).text, 'modules 1-1 of 1 matching "DLL"\nother.dll: 0x800000 (size: 0x100)');
  assert.equal((await h.call('ce_list_modules', { offset: 5 })).text, 'offset=5 is past the end: 2 modules');
  assert.equal((await h.call('ce_list_processes', { filter: 'nothing' })).text, 'No processes matching "nothing"');
  assert.match((await h.call('ce_memory_regions')).text, /0x500000 - 0x502000 \(size: 0x2000\) \[RWG\]/);
});

test('read/write integers: signed with hex, unsigned accepted, ranges checked', async () => {
  h.ce.exec('__fake.pid = 7');
  assert.equal((await h.call('ce_write_memory', { address: 'game.exe+10', type: 'int32', value: '-5' })).text, 'Written -5 (int32) to game.exe+10 (0x400010)');
  assert.equal((await h.call('ce_read_memory', { address: 'game.exe+10', type: 'int32' })).text, 'game.exe+10 (int32): -5 (0xFFFFFFFB)');
  await h.call('ce_write_memory', { address: '0x400010', type: 'int32', value: '0xFFFFFFFF' });
  assert.equal((await h.call('ce_read_memory', { address: '0x400010', type: 'int32' })).text, '0x400010 (int32): -1 (0xFFFFFFFF)');
  const tooBig = await h.call('ce_write_memory', { address: '0x400010', type: 'byte', value: '256' });
  assert.equal(tooBig.text, 'Error: 256 does not fit in 8 bits');
  assert.equal(tooBig.isError, true);
  await h.call('ce_write_memory', { address: '0x400018', type: 'int64', value: '-2' });
  assert.equal((await h.call('ce_read_memory', { address: '0x400018', type: 'int64' })).text, '0x400018 (int64): -2 (0xFFFFFFFFFFFFFFFE)');
});

test('read/write floats keep their value (the Python server returned integers)', async () => {
  h.ce.exec('__fake.pid = 7');
  await h.call('ce_write_memory', { address: '0x400020', type: 'float', value: '3.25' });
  assert.equal((await h.call('ce_read_memory', { address: '0x400020', type: 'float' })).text, '0x400020 (float): 3.25');
  await h.call('ce_write_memory', { address: '0x400028', type: 'double', value: '-0.1' });
  assert.equal((await h.call('ce_read_memory', { address: '0x400028', type: 'double' })).text, '0x400028 (double): -0.1');
});

test('bytes and strings, with hostile content', async () => {
  h.ce.exec('__fake.pid = 7');
  await h.call('ce_write_memory', { address: '0x400030', type: 'bytes', value: '90 90 C3' });
  assert.equal((await h.call('ce_read_memory', { address: '0x400030', type: 'bytes', size: 3 })).text, '0x400030 (bytes): 90 90 C3');
  assert.match((await h.call('ce_write_memory', { address: '0x400030', type: 'bytes', value: '9 0' })).text, /^Error: not a hex byte string/);
  const hostile = "it's ]] \"quoted\"";
  await h.call('ce_write_memory', { address: '0x400040', type: 'string', value: hostile });
  assert.equal((await h.call('ce_read_memory', { address: '0x400040', type: 'string', size: 50 })).text, `0x400040 (string): ${hostile}`);
});

test('invalid and unreadable addresses are errors', async () => {
  h.ce.exec('__fake.pid = 7');
  const invalid = await h.call('ce_read_memory', { address: 'nowhere', type: 'int32' });
  assert.equal(invalid.text, 'Error: invalid address: nowhere');
  assert.equal(invalid.isError, true);
  assert.equal((await h.call('ce_read_memory', { address: '0x900000', type: 'int32' })).text, 'Error: cannot read 0x900000 (0x900000)');
  assert.equal((await h.call('ce_write_memory', { address: '0x900000', type: 'int32', value: '1' })).text, 'Error: write failed at 0x900000 (not writable?)');
});

test('ce_value_change: integer and float deltas', async () => {
  h.ce.exec('__fake.pid = 7');
  await h.call('ce_write_memory', { address: '0x400050', type: 'int32', value: '100' });
  assert.equal((await h.call('ce_value_change', { address: '0x400050', delta: '-30' })).text, 'Changed 0x400050 (int32): 100 -> 70');
  await h.call('ce_write_memory', { address: '0x400058', type: 'float', value: '1.5' });
  assert.equal((await h.call('ce_value_change', { address: '0x400058', delta: '0.25', type: 'float' })).text, 'Changed 0x400058 (float): 1.5 -> 1.75');
});

test('ce_aob_scan: pattern checked, module filter by address range, paginated', async () => {
  h.ce.exec('__fake.pid = 7');
  assert.match((await h.call('ce_aob_scan', { pattern: "90 ')" })).text, /^Error: invalid pattern/);
  assert.equal(
    (await h.call('ce_aob_scan', { pattern: '89 45 ?? 8b', module: 'game.exe' })).text,
    'AOB matches 1-2 of 2\n0x400010  game.exe+10\n0x400020  game.exe+20',
  );
  assert.equal(h.ce.eval('__fake.lastAob.pattern'), '89 45 ?? 8b');
  assert.match((await h.call('ce_aob_scan', { pattern: '90', limit: 1 })).text, /^AOB matches 1-1 of 3\n.*\n\.\.\. 2 more, next page: offset=1$/);
  assert.equal((await h.call('ce_aob_scan', { pattern: '90', module: 'nope.dll' })).text, 'Error: module not found: nope.dll');
});

test('resolve, disassemble, struct view, process info', async () => {
  h.ce.exec('__fake.pid = 7');
  assert.equal((await h.call('ce_resolve_address', { expression: 'game.exe+20' })).text, 'game.exe+20 = 0x400020 (game.exe+20)');
  assert.equal((await h.call('ce_resolve_address', { expression: 'zz' })).text, 'zz = Not found');
  assert.equal((await h.call('ce_disassemble', { address: '0x400000', count: 2 })).text, '400000 - 90 - nop\n400001 - 90 - nop');
  await h.call('ce_write_memory', { address: '0x400100', type: 'int64', value: '0x400200' });
  const view = (await h.call('ce_struct_view', { address: '0x400100', size: 8 })).text;
  assert.match(view, /^=== Structure at 0x400100 ===\n\+0x00: 00 02 40 00 +i32:4194816 .*PTR->0x400200 \(game\.exe\+200\)\n\+0x04: 00 00 00 00 /);
  assert.match((await h.call('ce_process_info')).text, /Size: 0x1000 \(4 KB\)\nMono\/\.NET: not initialized/);
});

test('parseInteger', () => {
  assert.equal(parseInteger('0x10', 8), 16n);
  assert.equal(parseInteger('-128', 8), -128n);
  assert.equal(parseInteger('255', 8), 255n);
  assert.throws(() => parseInteger('-129', 8));
  assert.equal(parseInteger('0xFFFFFFFFFFFFFFFF', 64), -1n);
  assert.throws(() => parseInteger('1.5', 32));
});
