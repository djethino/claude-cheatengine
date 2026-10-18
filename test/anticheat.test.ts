import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { useHarness } from './harness.js';
import { detectActk, detectFromModules } from '../src/anticheat.js';

const h = useHarness();

test('module signatures', () => {
  assert.deepEqual(detectFromModules(['game.exe', 'kernel32.dll']), []);
  assert.deepEqual(detectFromModules(['EasyAntiCheat_x64.dll', 'BEClient_x64.dll']), ['Easy Anti-Cheat', 'BattlEye']);
});

test('ACTk in Mono and IL2CPP builds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cemcp-actk-'));
  try {
    const exe = join(dir, 'My Game.exe');
    writeFileSync(exe, '');
    assert.equal(detectActk(exe), false);
    mkdirSync(join(dir, 'My Game_Data', 'il2cpp_data', 'Metadata'), { recursive: true });
    writeFileSync(join(dir, 'My Game_Data', 'il2cpp_data', 'Metadata', 'global-metadata.dat'), Buffer.from('xx CodeStage.AntiCheat.ObscuredTypes xx'));
    assert.equal(detectActk(exe), true);
    rmSync(join(dir, 'My Game_Data'), { recursive: true });
    mkdirSync(join(dir, 'My Game_Data', 'Managed'), { recursive: true });
    writeFileSync(join(dir, 'My Game_Data', 'Managed', 'ACTk.Runtime.dll'), '');
    assert.equal(detectActk(exe), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ce_attach refuses a protected process in SAFE mode, without opening it', async () => {
  const { text, isError } = await h.call('ce_attach', { process: 'protected.exe' });
  assert.match(text, /^BLOCKED: not attached\. Anti-cheat detected in protected\.exe: Easy Anti-Cheat\. .*banned.*Tell the user this reason/);
  assert.equal(isError, true);
  assert.equal(h.ce.eval('__fake.pid'), 0);
  // A clean process attaches normally
  assert.match((await h.call('ce_attach', { process: 'game.exe' })).text, /^Attached to PID: 4242/);
});

test('a protected process opened from CE itself: every process tool is refused, exempt tools still work', async () => {
  h.ce.exec('__fake.pid = 5555');
  const read = await h.call('ce_read_memory', { address: '0x400000', type: 'int32' });
  assert.match(read.text, /^BLOCKED: anti-cheat detected in .*Easy Anti-Cheat\. .*Tell the user this reason/);
  assert.equal(read.isError, true);
  assert.match((await h.call('ce_scan_value', { value: '1' })).text, /^BLOCKED: anti-cheat detected/);
  assert.match((await h.call('ce_status')).text, /^Connected/);
  assert.match((await h.call('ce_list_processes')).text, /^processes/);
});

test('UNSAFE mode lets the user go on, with a warning at attach', async () => {
  await h.call('ce_safety_enable_writes', { confirm: 'USER_CONFIRMED' });
  const attach = await h.call('ce_attach', { process: 'protected.exe' });
  assert.match(attach.text, /^Attached to PID: 5555 .*\nWARNING: anti-cheat present \(Easy Anti-Cheat\)/);
  assert.match((await h.call('ce_read_memory', { address: '0x400000', type: 'int32' })).text, /^0x400000 \(int32\)/);
});

test('the verdict is cached in CE per process', async () => {
  h.ce.exec('__fake.pid = 5555');
  await h.call('ce_read_memory', { address: '0x400000', type: 'int32' });
  assert.equal(h.ce.eval('_mcp.ac[5555]'), 'Easy Anti-Cheat');
  h.ce.exec('__fake.pid = 4242');
  await h.call('ce_read_memory', { address: '0x400000', type: 'int32' });
  assert.equal(h.ce.eval('_mcp.ac[4242]'), '');
});
