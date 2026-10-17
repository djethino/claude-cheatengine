/**
 * A Lua state for tests, through wasmoon's low-level C API (Lua 5.4 compiled to WebAssembly,
 * 64-bit integers like CE's Lua 5.3; the code we generate relies on nothing that differs).
 *
 * Only synchronous C calls are used: wasmoon's high-level LuaEngine.doString corrupts its state
 * after a few dozen calls (wasmoon 1.16: "memory access out of bounds", then "_ENV" nil).
 */

import { LuaWasm } from 'wasmoon';

export type LuaResult = string | number | bigint | boolean | null;

// Values of LuaType (wasmoon) = Lua's LUA_T* constants
const LUA_TNIL = 0;
const LUA_TBOOLEAN = 1;
const LUA_TNUMBER = 3;
const LUA_TSTRING = 4;

let wasm: LuaWasm | null = null;

/** Load the WebAssembly module once per process (required before new LuaVM()). */
export async function initLua(): Promise<void> {
  wasm ??= await LuaWasm.initialize();
}

export class LuaVM {
  private readonly lua: LuaWasm;
  private readonly L: number;

  constructor() {
    if (!wasm) throw new Error('initLua() must be awaited first');
    this.lua = wasm;
    this.L = this.lua.luaL_newstate();
    this.lua.luaL_openlibs(this.L);
  }

  /** Run a chunk and return its first result (nil -> null, integers exact); throws on a Lua error. */
  run(code: string): LuaResult {
    const { lua, L } = this;
    try {
      if (lua.luaL_loadstring(L, code) !== 0 || lua.lua_pcallk(L, 0, 1, 0, 0, null) !== 0) {
        throw new Error(lua.lua_tolstring(L, -1, null));
      }
      switch (lua.lua_type(L, -1)) {
        case LUA_TNIL:
          return null;
        case LUA_TBOOLEAN:
          return lua.lua_toboolean(L, -1) !== 0;
        case LUA_TNUMBER: {
          if (lua.lua_isinteger(L, -1)) {
            const n = lua.lua_tointegerx(L, -1, null);
            return n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
          }
          return lua.lua_tonumberx(L, -1, null);
        }
        case LUA_TSTRING:
          return lua.lua_tolstring(L, -1, null);
        default:
          throw new Error(`Unsupported Lua result type ${lua.lua_type(L, -1)}`);
      }
    } finally {
      lua.lua_settop(L, 0);
    }
  }

  setGlobalString(name: string, value: string): void {
    this.lua.lua_pushstring(this.L, value);
    this.lua.lua_setglobal(this.L, name);
  }

  close(): void {
    this.lua.lua_close(this.L);
  }
}
