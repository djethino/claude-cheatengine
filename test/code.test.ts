import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness } from './harness.js';

const h = useHarness();

const SCRIPT = '[ENABLE]\ngame.exe+10:\nnop\n[DISABLE]\ngame.exe+10:\ndb 89\n';

test('ce_asm_script: sections required, check only (allowed in SAFE mode), syntax errors', async () => {
  assert.match((await h.call('ce_asm_script', { script: 'nop' })).text, /^Error: the script needs an \[ENABLE\] and a \[DISABLE\] section/);
  assert.match((await h.call('ce_asm_script', { script: SCRIPT, check_only: true })).text, /^Syntax OK/);
  assert.match(
    (await h.call('ce_asm_script', { script: SCRIPT.replace('nop', 'INVALID'), check_only: true })).text,
    /^Error: \[ENABLE\] section: Error in line 2 \(INVALID\)/,
  );
  assert.match((await h.call('ce_asm_script', { script: SCRIPT })).text, /^BLOCKED/);
  assert.equal(h.ce.eval('getAddressList().Count'), 0);
});

test('ce_asm_script creates an entry; ce_record_activate toggles it; refusals reported', async () => {
  await h.unlock();
  assert.equal(
    (await h.call('ce_asm_script', { script: SCRIPT, description: 'god mode' })).text,
    'Auto assembler entry #0 "god mode" created, enabled. Toggle it with ce_record_activate(record=0).',
  );
  assert.equal((await h.call('ce_record_activate', { record: 0, active: false })).text, 'Record #0 "god mode" disabled');
  h.ce.exec('__fake.scriptsFail = true');
  assert.equal((await h.call('ce_record_activate', { record: 0, active: true })).text, 'Error: CE could not enable record #0 "god mode" (see the CE window)');
  assert.match((await h.call('ce_asm_script', { script: SCRIPT })).text, /^Error: Auto assembler entry #1 "MCP script" created, NOT enabled/);
  assert.equal((await h.call('ce_record_activate', { record: 5, active: true })).text, 'Error: no record with ID 5 (see ce_watch_list)');
});

test('ce_asm_inject: whole instructions covered, original code kept, restored on disable', async () => {
  await h.unlock();
  assert.match((await h.call('ce_asm_inject', { address: 'game.exe+20', asm_code: 'mov eax,1' })).text, /^Auto assembler entry #0 "Injection at game.exe\+20" created, enabled/);
  assert.equal(
    h.ce.eval('getAddressList().getMemoryRecordByID(0).Script'),
    [
      '[ENABLE]', 'alloc(cemcp_newmem, 2048, 400020)', 'label(cemcp_return)', '', 'cemcp_newmem:', 'mov eax,1',
      '// original code', 'nop', 'nop', 'nop', 'nop', 'nop', 'jmp cemcp_return', '', '400020:', 'jmp cemcp_newmem',
      'cemcp_return:', '', '[DISABLE]', '400020:', 'db 00 00 00 00 00', 'dealloc(cemcp_newmem)',
    ].join('\n'),
  );
  assert.equal((await h.call('ce_asm_inject', { address: 'nowhere', asm_code: 'nop' })).text, 'Error: invalid address: nowhere');
});
