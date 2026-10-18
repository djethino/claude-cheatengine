import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness } from './harness.js';

const h = useHarness();

// target 0x401F00 (heap): game.exe+200 points 8 bytes before it (1 level);
// game.exe+100 -> heap object 0x401C00, whose +0x20 field points 0x10 before the target (2 levels)
const LAYOUT = `
  writeQword(0x400200, 0x401EF8)
  writeQword(0x400100, 0x401C00)
  writeQword(0x401C20, 0x401EF0)
`;

test('ce_pointer_scan: chains of one and two levels, shortest first, offsets for ce_watch_add', async () => {
  h.ce.exec('__fake.pid = 7');
  h.ce.exec(LAYOUT);
  assert.equal(
    (await h.call('ce_pointer_scan', { address: '0x401F00', max_offset: 0x100 })).text,
    '2 static pointer chain(s) to 0x401F00 (2 level(s) searched, 2 memory scans)\n' +
      '  [game.exe+200] + 0x8 = target   (offsets: 8)\n' +
      '  [[game.exe+100] + 0x20] + 0x10 = target   (offsets: 20, 10)',
  );
  assert.equal(h.ce.eval('next(_mcp.pointerScans) == nil'), true);
});

test('ce_pointer_scan: one level only, candidates capped with a note, nothing found', async () => {
  h.ce.exec('__fake.pid = 7');
  h.ce.exec(LAYOUT);
  assert.equal(
    (await h.call('ce_pointer_scan', { address: '0x401F00', max_offset: 0x100, max_level: 1 })).text,
    '1 static pointer chain(s) to 0x401F00 (1 level(s) searched, 1 memory scans)\n  [game.exe+200] + 0x8 = target   (offsets: 8)',
  );
  h.ce.exec('writeQword(0x401D00, 0x401EE0)');
  assert.match(
    (await h.call('ce_pointer_scan', { address: '0x401F00', max_offset: 0x100, max_candidates: 1 })).text,
    /\n  \[\[game\.exe\+100\] \+ 0x20\] \+ 0x10 = target {3}\(offsets: 20, 10\)\nNote: level 2: followed the 1 closest of 2 heap pointers \(raise max_candidates\)$/,
  );
  assert.equal(
    (await h.call('ce_pointer_scan', { address: '0x401A00', max_offset: 0x10 })).text,
    '0 static pointer chain(s) to 0x401A00 (1 level(s) searched, 1 memory scans)\nNone found: raise max_level, max_offset or max_candidates',
  );
});
