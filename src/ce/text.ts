/**
 * Text coming back from Cheat Engine: Lua strings are raw bytes (memory dumps, game strings in
 * any encoding), shown as UTF-8 with every invalid byte written as \xNN.
 */

/** Length of the next valid UTF-8 sequence starting at data[i], or 0 if the byte starts none. */
function sequenceLength(data: Uint8Array, i: number): number {
  const b = data[i];
  if (b < 0x80) return 1;
  let len: number;
  let min: number;
  if (b >= 0xc2 && b <= 0xdf) [len, min] = [2, 0x80];
  else if (b >= 0xe0 && b <= 0xef) [len, min] = [3, 0x800];
  else if (b >= 0xf0 && b <= 0xf4) [len, min] = [4, 0x10000];
  else return 0;
  if (i + len > data.length) return 0;
  let cp = b & (0xff >> (len + 1));
  for (let k = 1; k < len; k++) {
    const c = data[i + k];
    if ((c & 0xc0) !== 0x80) return 0;
    cp = (cp << 6) | (c & 0x3f);
  }
  // Overlong forms, UTF-16 surrogates and code points past U+10FFFF are invalid
  if (cp < min || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return 0;
  return len;
}

/** Decode bytes as UTF-8; invalid bytes become the text \xNN (like Python's backslashreplace). */
export function decodeBytes(data: Uint8Array): string {
  const decoder = new TextDecoder('utf-8');
  let out = '';
  let start = 0;
  let i = 0;
  while (i < data.length) {
    const len = sequenceLength(data, i);
    if (len) {
      i += len;
      continue;
    }
    out += decoder.decode(data.subarray(start, i));
    out += `\\x${data[i].toString(16).padStart(2, '0')}`;
    i++;
    start = i;
  }
  return out + decoder.decode(data.subarray(start, i));
}

/** How many trailing bytes form an incomplete UTF-8 sequence (0 if none). */
export function incompleteUtf8Tail(data: Uint8Array): number {
  for (let back = 1; back <= Math.min(4, data.length); back++) {
    const byte = data[data.length - back];
    if ((byte & 0xc0) !== 0x80) {
      const expected = byte >> 5 === 0b110 ? 2 : byte >> 4 === 0b1110 ? 3 : byte >> 3 === 0b11110 ? 4 : 1;
      return back < expected ? back : 0;
    }
  }
  return 0;
}
