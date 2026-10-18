import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness } from './harness.js';

const h = useHarness();

const INFO = { id: '11', title: 'Error', texts: [], buttons: [{ id: '12', text: '' }] };
const QUESTION = { id: '21', title: 'Confirmation', texts: [], buttons: [{ id: '22', text: '&Yes' }, { id: '23', text: '&No' }] };

/** Connect once with CE's window known (dialogs are then watched). */
async function connected(): Promise<void> {
  h.ce.exec('__fake.cePid = 111 __fake.ceMain = 222 __fake.pid = 7');
  await h.call('ce_read_memory', { address: '0x400000', type: 'int32' });
}

test('a call blocked by a dialog ends with its description, long before the timeout', async () => {
  await connected();
  h.win.dialogs = [INFO];
  h.ce.delayNext = 8000;
  const started = Date.now();
  const { text, isError } = await h.call('ce_read_memory', { address: '0x400000', type: 'int32' });
  assert.match(text, /^Error: Cheat Engine is blocked by a dialog: this call was given up \(its result is lost/);
  assert.match(text, /\nCheat Engine shows the dialog "Error" - information \(1 button\)\. Read it with ce_dialogs .* ce_dialog_close\(id="11"\)$/);
  assert.equal(isError, true);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  // A question is the user's: described as such
  h.win.dialogs = [QUESTION];
  h.ce.delayNext = 8000;
  assert.match((await h.call('ce_read_memory', { address: '0x400000', type: 'int32' })).text, /"Confirmation" - a QUESTION for the user \(buttons: Yes, No\)\. Tell the user to answer it in Cheat Engine; never answer it yourself$/);
});

test('a call that asks the user waits through its question, but not through an error dialog', async () => {
  await connected();
  h.win.dialogs = [QUESTION];
  h.ce.delayNext = 3500;
  // Meanwhile, the dialog tools work without waiting for the blocked call
  const unlock = h.call('ce_safety_enable_writes', { confirm: 'USER_CONFIRMED' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const listed = await h.call('ce_dialogs');
  assert.match(listed.text, /^1 dialog\(s\) open in Cheat Engine \(image: the first one\)\nid 21: Cheat Engine shows the dialog "Confirmation" - a QUESTION/);
  assert.match((await unlock).text, /^UNSAFE mode enabled \(confirmed by the user in Cheat Engine\)/);
  h.ce.exec('_mcp_unsafe = false');
  h.win.dialogs = [QUESTION, INFO];
  h.ce.delayNext = 8000;
  assert.match((await h.call('ce_safety_enable_writes', { confirm: 'USER_CONFIRMED' })).text, /^Error: Cheat Engine is blocked by a dialog/);
});

test('ce_dialogs and ce_dialog_close: images, information closed, questions refused', async () => {
  assert.match((await h.call('ce_dialogs')).text, /^Error: Not connected to Cheat Engine in this session yet/);
  await connected();
  assert.equal((await h.call('ce_dialogs')).text, 'No dialog is open in Cheat Engine');
  h.win.dialogs = [{ ...INFO, image: 'iVBORw0KGgo=' }];
  const listed = await h.call('ce_dialogs');
  assert.match(listed.text, /^1 dialog\(s\) open/);
  assert.equal((await h.call('ce_dialog_close', { id: '99' })).text, 'Error: no dialog 99 open in Cheat Engine. Open now:\n' + listed.text.split('\n')[1].replace('id 11: ', ''));
  h.win.dialogs.push(QUESTION);
  assert.equal((await h.call('ce_dialog_close', { id: '21' })).text, 'BLOCKED: "Confirmation" asks the user a question (2 buttons): only the user answers it, in Cheat Engine');
  assert.equal((await h.call('ce_dialog_close', { id: '11' })).text, 'Closed the dialog "Error"');
  assert.deepEqual(h.win.closed, ['11']);
});

test('ce_status warns when several Cheat Engines run', async () => {
  h.win.ceProcesses = [1234, 5678];
  assert.match((await h.call('ce_status')).text, /\nWarning: 2 Cheat Engines are running \(PIDs 1234, 5678\): only one serves Claude Code/);
});

test('ce_launch: nothing to do when CE answers', async () => {
  await connected();
  assert.equal((await h.call('ce_launch')).text, 'Cheat Engine is already running and answering (PID 111)');
});

test('ce_restart: confirmation listing what is lost, scripts disabled, a question while closing is the user\'s', async () => {
  await connected();
  await h.call('ce_freeze', { address: '0x400100', value: '5' });
  await h.call('ce_watch_add', { address: '0x400104' });
  h.ce.exec('__fake.dialogAnswer = mrNo');
  assert.equal((await h.call('ce_restart')).text, 'BLOCKED: the user declined the restart in Cheat Engine');
  assert.equal(h.ce.eval('__fake.dialogs[#__fake.dialogs]'), 'Claude Code asks to restart Cheat Engine. This ends:\n- the address list (2 entries) unless you saved it\n- 1 frozen value(s): released\n\nRestart now?');
  assert.equal(h.ce.eval('getAddressList().getMemoryRecordByID(0).Active'), true);
  h.ce.exec('__fake.dialogAnswer = mrYes');
  h.win.ceProcesses = [111];
  h.win.dialogs = [QUESTION];
  assert.match((await h.call('ce_restart')).text, /^Cheat Engine did not close yet:\nCheat Engine shows the dialog "Confirmation" - a QUESTION for the user .*\nOnce it is closed, start it again with ce_launch\.$/s);
  assert.equal(h.ce.eval('getAddressList().getMemoryRecordByID(0).Active'), false);
});
