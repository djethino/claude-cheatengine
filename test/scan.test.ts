import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness } from './harness.js';

const h = useHarness();

async function setHealth(value: number): Promise<void> {
  await h.call('ce_write_memory', { address: '0x400100', type: 'int32', value: String(value) });
}

test('find a value: exact, then changed after the game changed it', async () => {
  h.ce.exec('__fake.pid = 7');
  await setHealth(100);
  await h.call('ce_write_memory', { address: '0x400200', type: 'int32', value: '100' });
  assert.match((await h.call('ce_scan_value', { value: '100' })).text, /^Scan "main" complete \(exact, int32\): 2 results\n  0x00400100 = 100\n  0x00400200 = 100$/);
  await setHealth(85);
  assert.equal((await h.call('ce_scan_next', { scan_type: 'changed' })).text, 'Scan "main" refined (changed): 1 results remaining\n  0x00400100 = 85');
  await setHealth(80);
  assert.equal((await h.call('ce_scan_next', { scan_type: 'decreased_by', value: '5' })).text, 'Scan "main" refined (decreased_by): 1 results remaining\n  0x00400100 = 80');
});

test('unknown initial value, then decreased; between', async () => {
  h.ce.exec('__fake.pid = 7');
  await setHealth(100);
  const unknown = await h.call('ce_scan_value', { scan_type: 'unknown', scan_name: 'u' });
  assert.match(unknown.text, /^Scan "u" complete \(unknown, int32\): \d+ results\nRefine with ce_scan_next/);
  await setHealth(42);
  assert.match((await h.call('ce_scan_next', { scan_type: 'decreased', scan_name: 'u' })).text, /1 results remaining\n  0x00400100 = 42/);
  assert.match((await h.call('ce_scan_value', { scan_type: 'between', value: '40', value2: '45', scan_name: 'b' })).text, /: 1 results\n  0x00400100 = 42/);
  assert.match((await h.call('ce_scan_list')).text, /^b: 1 results\nu: 1 results$/);
});

test('scan errors: missing value, invalid value (the failed scan is not kept), unknown scan', async () => {
  h.ce.exec('__fake.pid = 7');
  assert.equal((await h.call('ce_scan_value', {})).text, "Error: scan_type 'exact' needs a value");
  const invalid = await h.call('ce_scan_value', { value: 'abc', scan_name: 'bad' });
  assert.match(invalid.text, /^Error: job \d+ failed: scan error: abc is an invalid value$/);
  assert.equal((await h.call('ce_scan_list')).text, 'No scans');
  assert.match((await h.call('ce_scan_next', { scan_type: 'changed', scan_name: 'nope' })).text, /^Error: no scan named nope/);
});

test('results pagination, snapshot compare, add to the address list, reset', async () => {
  h.ce.exec('__fake.pid = 7');
  for (const a of ['0x400300', '0x400304', '0x400308']) await h.call('ce_write_memory', { address: a, type: 'int32', value: '777' });
  await h.call('ce_scan_value', { value: '777' });
  assert.equal((await h.call('ce_scan_results', { limit: 2 })).text, 'results 1-2 of 3\n[0] 0x00400300 = 777\n[1] 0x00400304 = 777\n... 1 more, next page: offset=2');
  await h.call('ce_snapshot_create', { name: 'before' });
  await h.call('ce_write_memory', { address: '0x400304', type: 'int32', value: '1' });
  assert.match((await h.call('ce_snapshot_compare', { mode: 'changed', name: 'before' })).text, /1 results remaining\n  0x00400304 = 1/);
  assert.match((await h.call('ce_snapshot_compare', { name: 'missing' })).text, /^Error: no snapshot named missing/);
  assert.match((await h.call('ce_scan_add_to_table', { index: 0, name: 'gold' })).text, /^Added 0x00400304 to the address list as record 0 \(gold = 1\)/);
  assert.match((await h.call('ce_scan_add_to_table', { index: 5 })).text, /^Error: index 5 out of range \(1 results\)/);
  assert.equal((await h.call('ce_scan_reset')).text, 'Scan main discarded');
  assert.equal((await h.call('ce_scan_reset')).text, 'No scan named main');
});

test('float scan', async () => {
  h.ce.exec('__fake.pid = 7');
  await h.call('ce_write_memory', { address: '0x400400', type: 'float', value: '3.5' });
  assert.match((await h.call('ce_scan_value', { value: '3.5', value_type: 'float' })).text, /: 1 results\n  0x00400400 = 3.5$/);
});
