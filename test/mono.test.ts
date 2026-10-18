import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness } from './harness.js';

const h = useHarness();

async function monoReady(): Promise<void> {
  await h.unlock();
  assert.equal((await h.call('ce_mono_init')).text, 'Mono data collector ready (Mono), 1 assemblies loaded');
  h.ce.exec('__fake.monoObjects()');
}

test('the collector must be started first', async () => {
  h.ce.exec('__fake.pid = 7');
  assert.equal((await h.call('ce_mono_fields', { class_name: 'Game.Player' })).text, 'Error: Mono is not initialized: run ce_mono_init first');
});

test('assemblies, classes, methods, fields; unknown names', async () => {
  await monoReady();
  assert.equal((await h.call('ce_mono_assemblies')).text, 'assemblies 1-1 of 1\nAssembly-CSharp.dll');
  assert.equal((await h.call('ce_mono_classes')).text, 'classes 1-2 of 2\nEnemy\nGame.Player');
  assert.equal((await h.call('ce_mono_methods', { class_name: 'Game.Player' })).text, 'methods 1-2 of 2\nHit(System.Int32)\nHeal()');
  assert.equal(
    (await h.call('ce_mono_fields', { class_name: 'Game.Player', assembly: 'assembly-csharp.dll' })).text,
    '=== Fields of Game.Player (8) ===\n+0x10: System.Int32 hp\n+0x18: Game.Enemy target\n+0x0: Game.Player Instance [static]\n+0x8: System.Int32 count [static]\n+0x0: System.Int32 MAX [static] [const]\n' +
      '+0x20: CodeStage.AntiCheat.ObscuredTypes.ObscuredInt coins\n+0x40: CodeStage.AntiCheat.ObscuredTypes.ObscuredFloat speed\n+0x10: UnityEngine.Vector3 spawn [static]',
  );
  assert.equal((await h.call('ce_mono_fields', { class_name: 'Game.Nope' })).text, 'Error: class not found: Game.Nope');
  assert.equal((await h.call('ce_mono_fields', { class_name: 'Game.Player', assembly: 'Nope' })).text, 'Error: no assembly named Nope (see ce_mono_assemblies)');
});

test('instance fields: read and dump with their types', async () => {
  await monoReady();
  assert.equal(
    (await h.call('ce_mono_read_field', { class_name: 'Game.Player', field_name: 'hp', instance_address: '0x401000' })).text,
    'Game.Player.hp (System.Int32) at 0x401010 = 75',
  );
  assert.equal(
    (await h.call('ce_mono_read_field', { class_name: 'Game.Player', field_name: 'nope', instance_address: '0x401000' })).text,
    'Error: no field nope in Game.Player (see ce_mono_fields)',
  );
  assert.equal(
    (await h.call('ce_mono_dump', { class_name: 'Game.Player', instance_address: '0x401000', include_statics: true })).text,
    '=== Game.Player at 0x401000 ===\n+0x10 System.Int32 hp = 75\n+0x18 Game.Enemy target = 0x0\nstatic Game.Player Instance = 0x401000\nstatic System.Int32 count = 3\n' +
      '+0x20 CodeStage.AntiCheat.ObscuredTypes.ObscuredInt coins = 100 (ACTk ObscuredInt, checked against its honeypot)\n' +
      '+0x40 CodeStage.AntiCheat.ObscuredTypes.ObscuredFloat speed = 2.5 (ACTk ObscuredFloat)\nstatic UnityEngine.Vector3 spawn = 0x0',
  );
});

test('static fields: Mono static data, IL2CPP per-field reads (structs refused: they overflow the collector); constants skipped', async () => {
  await monoReady();
  const expected = '=== Static fields of Game.Player ===\nGame.Player Instance = 0x401000\nSystem.Int32 count = ';
  assert.equal((await h.call('ce_mono_static', { class_name: 'Game.Player' })).text, `${expected}3\nUnityEngine.Vector3 spawn = 0x0`);
  h.ce.exec('__fake.il2cpp = true');
  assert.equal(
    (await h.call('ce_mono_static', { class_name: 'Game.Player' })).text,
    `${expected}-2\nUnityEngine.Vector3 spawn = ?? (IL2CPP: only number, boolean and reference static fields are readable)`,
  );
  assert.equal((await h.call('ce_mono_static', { class_name: 'Game.Player', field_name: 'MAX' })).text, '=== Static fields of Game.Player ===\nNo static field MAX');
});

test('ce_mono_write_field: typed instance and static writes, values checked', async () => {
  await monoReady();
  const write = async (field_name: string, value: string, instance_address = '0x401000') =>
    (await h.call('ce_mono_write_field', { class_name: 'Game.Player', field_name, value, instance_address })).text;
  assert.equal(await write('hp', '120'), 'Game.Player.hp (System.Int32) at 0x401010: 75 -> 120');
  assert.equal(await write('hp', 'abc'), 'Error: abc is not a valid Int32');
  assert.equal(await write('hp', '5000000000'), 'Error: 5000000000 does not fit in a Int32');
  assert.equal(await write('target', '0'), 'Error: only primitive fields (numbers, booleans) can be written, not Game.Enemy');
  assert.equal(await write('MAX', '1'), 'Error: MAX is a constant (compiled into the code, not in memory)');
  assert.equal(await write('hp', '1', ''), 'Error: hp is an instance field: give instance_address');
  assert.equal(await write('count', '9', ''), 'Game.Player.count (System.Int32) at 0x401808: 3 -> 9');
  h.ce.exec('__fake.il2cpp = true');
  assert.equal(await write('count', '-5', ''), 'Game.Player.count (System.Int32, static): -2 -> -5');
  assert.match(await write('spawn', '1', ''), /^Error: IL2CPP static field: only primitive fields/);
});

test('ACTk obscured values: decoded, re-encrypted with the honeypot kept equal, unknown encodings refused', async () => {
  await monoReady();
  const write = async (field_name: string, value: string) =>
    (await h.call('ce_mono_write_field', { class_name: 'Game.Player', field_name, value, instance_address: '0x401000' })).text;
  const checked = (v: string) => `${v} (ACTk ObscuredInt, checked against its honeypot)`;
  assert.equal(await write('coins', '250'), `Game.Player.coins (CodeStage.AntiCheat.ObscuredTypes.ObscuredInt) at 0x401020: ${checked('100')} -> ${checked('250')}`);
  assert.equal(h.ce.eval('readInteger(0x401024) ~ 0x5A5A'), 250);
  assert.equal(h.ce.eval('readInteger(0x40102C)'), 250);
  // Honeypot inactive: an obscured float is not written on an unchecked decoding
  assert.match(await write('speed', '4'), /^Error: ACTk ObscuredFloat: its encoding is only trusted once checked against its honeypot/);
  h.ce.exec('writeFloat(0x40104C, 2.5) writeBytes(0x401050, { 1 })');
  assert.match(await write('speed', '4.5'), /: 2\.5 \(ACTk ObscuredFloat, checked against its honeypot\) -> 4\.5 \(ACTk ObscuredFloat, checked against its honeypot\)$/);
  // A honeypot that disagrees: the decoding is wrong for this game, nothing is written
  h.ce.exec('writeInteger(0x40102C, 7)');
  const unknown = 'ACTk ObscuredInt: XOR decoding gives 250 but its honeypot holds 7 (unknown encoding)';
  assert.equal(
    (await h.call('ce_mono_read_field', { class_name: 'Game.Player', field_name: 'coins', instance_address: '0x401000' })).text,
    `Game.Player.coins (CodeStage.AntiCheat.ObscuredTypes.ObscuredInt) at 0x401020 = ?? (${unknown})`,
  );
  assert.equal(await write('coins', '1'), `Error: ${unknown}`);
  assert.equal(h.ce.eval('readInteger(0x401024) ~ 0x5A5A'), 250);
});

test('find_instances keeps real objects only, unless unfiltered', async () => {
  await monoReady();
  assert.match(
    (await h.call('ce_mono_find_instances', { class_name: 'Game.Player' })).text,
    /1 object\(s\) of Game\.Player \(class pointer 0x777 found 2 times, 1 discarded as not objects\)\n  0x401000$/,
  );
  assert.match(
    (await h.call('ce_mono_find_instances', { class_name: 'Game.Player', unfiltered: true })).text,
    /2 object\(s\) of Game\.Player \(class pointer 0x777 found 2 times, unfiltered\)\n  0x401000\n  0x401100$/,
  );
});
