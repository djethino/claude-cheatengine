/**
 * Safe construction of the Lua code sent to Cheat Engine.
 *
 * Tool parameters are never pasted into Lua as is: the `lua` tagged template turns every
 * interpolated value into a Lua literal of its type, so no value can close a string and run
 * code of its own (the Python server pasted ~100 parameters raw, which let any tool run
 * arbitrary Lua, SAFE mode included). Code fragments go through raw(), reserved for fixed
 * text chosen by the server (never for a value that comes from a tool argument).
 */

export class LuaCode {
  constructor(readonly code: string) {}
  toString(): string {
    return this.code;
  }
}

/** A trusted code fragment (fixed by the server, never built from tool arguments). */
export function raw(code: string): LuaCode {
  return new LuaCode(code);
}

/**
 * Encode a string as a Lua string literal. Every byte outside printable ASCII, plus quote and
 * backslash, becomes a decimal escape (\ddd), so the literal survives quotes, newlines, `]]`,
 * NUL bytes and any UTF-8 text.
 */
export function luaStr(value: string): string {
  let out = '"';
  for (const byte of Buffer.from(value, 'utf8')) {
    out += byte >= 0x20 && byte < 0x7f && byte !== 0x22 && byte !== 0x5c ? String.fromCharCode(byte) : `\\${byte.toString().padStart(3, '0')}`;
  }
  return out + '"';
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** Encode an integer as a Lua 5.3 integer literal. */
export function luaInt(value: number | bigint): string {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new RangeError(`Not a safe integer: ${value}`);
  }
  const n = BigInt(value);
  if (n < INT64_MIN || n > INT64_MAX) throw new RangeError(`Out of the 64-bit integer range: ${n}`);
  // -9223372036854775808 would be read as -(9223372036854775808), a float in Lua
  return n === INT64_MIN ? 'math.mininteger' : n.toString();
}

/** Encode a finite number: an integer literal when it is integral, a float literal otherwise. */
export function luaNum(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`Not a finite number: ${value}`);
  if (Number.isSafeInteger(value)) return value.toString();
  // Integral but beyond 2^53, or fractional: a float literal ("1e+21" and "0.5" are valid Lua)
  const text = value.toString();
  return /[.e]/.test(text) ? text : `${text}.0`;
}

export function luaBool(value: boolean): string {
  return value ? 'true' : 'false';
}

export type LuaValue = string | number | bigint | boolean | LuaCode;

export function luaLiteral(value: LuaValue): string {
  switch (typeof value) {
    case 'string':
      return luaStr(value);
    case 'number':
      return luaNum(value);
    case 'bigint':
      return luaInt(value);
    case 'boolean':
      return luaBool(value);
    default:
      if (value instanceof LuaCode) return value.code;
      throw new TypeError(`Cannot embed ${String(value)} in Lua code`);
  }
}

/**
 * Lua code with every interpolated value encoded as a literal (see the module comment).
 * The template text is taken raw: it is Lua source, so `'\n'` reaches Lua as the two characters
 * of Lua's own escape, not as a line break that would cut the string literal.
 */
export function lua(strings: TemplateStringsArray, ...values: LuaValue[]): LuaCode {
  let code = strings.raw[0];
  values.forEach((value, i) => {
    code += luaLiteral(value) + strings.raw[i + 1];
  });
  return new LuaCode(code);
}

/** Join code fragments (e.g. lines generated in a loop). */
export function joinLua(parts: LuaCode[], separator = '\n'): LuaCode {
  return new LuaCode(parts.map((part) => part.code).join(separator));
}
