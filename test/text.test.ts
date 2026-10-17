import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBytes, incompleteUtf8Tail } from '../src/ce/text.js';

test('decodeBytes: valid UTF-8 unchanged, invalid bytes as \\xNN (Python backslashreplace)', () => {
  assert.equal(decodeBytes(Buffer.from('héllo 🎮', 'utf8')), 'héllo 🎮');
  // Expected values computed with Python: bytes.decode('utf-8', errors='backslashreplace')
  assert.equal(decodeBytes(Buffer.from([0x41, 0xff, 0x42])), 'A\\xffB');
  assert.equal(decodeBytes(Buffer.from([0xc3])), '\\xc3'); // truncated 2-byte sequence
  assert.equal(decodeBytes(Buffer.from([0xc0, 0xaf])), '\\xc0\\xaf'); // overlong
  assert.equal(decodeBytes(Buffer.from([0xed, 0xa0, 0x80])), '\\xed\\xa0\\x80'); // surrogate
  assert.equal(decodeBytes(Buffer.from([0xe2, 0x82, 0x41])), '\\xe2\\x82A'); // broken 3-byte sequence
  assert.equal(decodeBytes(Buffer.from([0x00, 0x7f])), '\u0000\u007f');
});

test('incompleteUtf8Tail', () => {
  const euro = Buffer.from('€', 'utf8'); // e2 82 ac
  assert.equal(incompleteUtf8Tail(Buffer.from('abc')), 0);
  assert.equal(incompleteUtf8Tail(euro), 0);
  assert.equal(incompleteUtf8Tail(euro.subarray(0, 1)), 1);
  assert.equal(incompleteUtf8Tail(euro.subarray(0, 2)), 2);
  assert.equal(incompleteUtf8Tail(Buffer.concat([Buffer.from('a'), Buffer.from('🎮', 'utf8').subarray(0, 3)])), 3);
});
