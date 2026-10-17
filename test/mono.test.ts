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
    '=== Fields of Game.Player (5) ===\n+0x10: System.Int32 hp\n+0x18: Game.Enemy target\n+0x0: Game.Player Instance [static]\n+0x8: System.Int32 count [static]\n+0x0: System.Int32 MAX [static] [const]',
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
    '=== Game.Player at 0x401000 ===\n+0x10 System.Int32 hp = 75\n+0x18 Game.Enemy target = 0x0\nstatic Game.Player Instance = 0x401000\nstatic System.Int32 count = 3',
  );
});

test('static fields: Mono static data, IL2CPP per-field reads; constants skipped', async () => {
  await monoReady();
  const expected = '=== Static fields of Game.Player ===\nGame.Player Instance = 0x401000\nSystem.Int32 count = ';
  assert.equal((await h.call('ce_mono_static', { class_name: 'Game.Player' })).text, `${expected}3`);
  h.ce.exec('__fake.il2cpp = true');
  assert.equal((await h.call('ce_mono_static', { class_name: 'Game.Player' })).text, `${expected}-2`);
  assert.equal((await h.call('ce_mono_static', { class_name: 'Game.Player', field_name: 'MAX' })).text, '=== Static fields of Game.Player ===\nNo static field MAX');
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
