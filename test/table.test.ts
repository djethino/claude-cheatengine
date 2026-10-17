import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness } from './harness.js';
import { parseHotkey } from '../src/tools/table.js';

const h = useHarness();

test('watch list: add, list, modify, remove, clear', async () => {
  h.ce.exec('__fake.pid = 7');
  await h.call('ce_write_memory', { address: '0x400100', type: 'int32', value: '100' });
  assert.equal((await h.call('ce_watch_add', { address: '0x400100', name: 'hp' })).text, 'Added #0 [0x400100] hp = 100');
  assert.equal((await h.call('ce_watch_add', { address: '0x400108', value_type: 'float' })).text, 'Added #1 [0x400108] 0x400108 = 0');
  assert.equal((await h.call('ce_watch_list')).text, 'records 1-2 of 2\n#0 [0x400100] hp = 100\n#1 [0x400108] 0x400108 = 0');
  assert.equal((await h.call('ce_watch_modify', { record: 0, value: '50', description: 'health' })).text, 'Modified #0 [0x400100] health = 50');
  assert.equal(h.ce.eval('readInteger(0x400100)'), 50);
  assert.match((await h.call('ce_watch_modify', { record: 0 })).text, /^Error: nothing to change/);
  assert.equal((await h.call('ce_watch_remove', { record: 9 })).text, 'Error: no record with ID 9 (see ce_watch_list)');
  assert.equal((await h.call('ce_watch_remove', { record: 1 })).text, 'Removed #1 [0x400108] 0x400108 = 0');
  assert.equal((await h.call('ce_watch_clear')).text, 'Address list cleared (1 entries)');
  assert.equal((await h.call('ce_watch_list')).text, 'No records');
});

test('freeze an address or a record, list, unfreeze', async () => {
  h.ce.exec('__fake.pid = 7');
  assert.equal((await h.call('ce_freeze', {})).text, 'Error: give either record or address');
  assert.equal((await h.call('ce_freeze', { address: '0x400104', value: '9' })).text, 'Frozen #0 [0x400104] Frozen: 0x400104 = 9 [FROZEN]');
  await h.call('ce_watch_add', { address: '0x400100', name: 'hp' });
  assert.equal((await h.call('ce_freeze', { record: 1 })).text, 'Frozen #1 [0x400100] hp = 0 [FROZEN]');
  assert.equal((await h.call('ce_freeze_list')).text, '#0 [0x400104] Frozen: 0x400104 = 9 [FROZEN]\n#1 [0x400100] hp = 0 [FROZEN]');
  assert.equal((await h.call('ce_unfreeze', { record: 1 })).text, 'Unfrozen #1 [0x400100] hp = 0');
  assert.equal((await h.call('ce_unfreeze')).text, 'Unfrozen 1 entries');
  assert.equal((await h.call('ce_freeze_list')).text, 'No frozen entries');
});

test('hotkeys: key names, actions that need a value', async () => {
  await h.call('ce_watch_add', { address: '0x400100', name: 'hp' });
  assert.equal((await h.call('ce_hotkey_add', { record: 0, keys: 'Ctrl+F1' })).text, 'Hotkey Ctrl+F1 (toggle) added to record #0 hp');
  assert.match((await h.call('ce_hotkey_add', { record: 0, keys: 'Ctrl+Nope' })).text, /^Error: unknown key "NOPE"/);
  assert.equal((await h.call('ce_hotkey_add', { record: 0, keys: 'F2', action: 'set' })).text, "Error: action 'set' needs a value");
  assert.deepEqual(parseHotkey('alt + shift + x'), [18, 16, 88]);
  assert.deepEqual(parseHotkey('Numpad5'), [101]);
});

test('ce_code_entry: original bytes read, toggled by ce_record_activate', async () => {
  await h.unlock();
  await h.call('ce_write_memory', { address: '0x400010', type: 'bytes', value: '89 45' });
  assert.equal(
    (await h.call('ce_code_entry', { address: 'game.exe+10', description: 'no damage', enable_bytes: '90 90' })).text,
    'Code entry #0 "no damage" at 0x400010 (enabled): enable 90 90 / disable 89 45',
  );
  assert.equal(h.ce.eval('getAddressList().getMemoryRecordByID(0).Script'), '[ENABLE]\n400010:\ndb 90 90\n\n[DISABLE]\n400010:\ndb 89 45\n');
  assert.equal(
    (await h.call('ce_code_entry', { address: '0x400010', description: 'x', enable_bytes: '90', disable_bytes: '89 45' })).text,
    'Error: enable_bytes has 1 bytes and disable_bytes 2: they must patch the same range',
  );
  assert.equal((await h.call('ce_record_activate', { record: 0, active: false })).text, 'Record #0 "no damage" disabled');
  assert.equal((await h.call('ce_freeze', { record: 0 })).text, 'Error: record 0 is a script: enable it with ce_watch_modify or the CE window');
});
