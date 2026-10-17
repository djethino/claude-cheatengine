/**
 * Processes, modules, memory regions, memory reads and writes, AOB scans, addresses, disassembly.
 */

import { z } from 'zod';
import { lua, raw, type LuaCode } from '../lua/lit.js';
import { defineTool } from './registry.js';
import { listBody, pageSchema } from './list.js';
import { ANTI_CHEAT_ADVICE } from '../anticheat.js';

/** Lua that resolves an address expression into the local `addr`, or reports it and returns. */
export function resolveAddress(expression: string, local = 'addr'): LuaCode {
  return lua`
    local ${raw(local)} = getAddressSafe(${expression})
    if not ${raw(local)} then _mcp_str = 'Error: invalid address: ' .. ${expression} return end`;
}

const INT_TYPES = {
  byte: { bits: 8, read: 'readBytes(addr, 1)', write: 'writeBytes' },
  int16: { bits: 16, read: 'readSmallInteger(addr, true)', write: 'writeSmallInteger' },
  int32: { bits: 32, read: 'readInteger(addr, true)', write: 'writeInteger' },
  int64: { bits: 64, read: 'readQword(addr)', write: 'writeQword' },
} as const;
type IntType = keyof typeof INT_TYPES;

const FLOAT_TYPES = {
  float: { read: 'readFloat(addr)', write: 'writeFloat' },
  double: { read: 'readDouble(addr)', write: 'writeDouble' },
} as const;

export const VALUE_TYPES = ['byte', 'int16', 'int32', 'int64', 'float', 'double'] as const;
export type ValueType = (typeof VALUE_TYPES)[number];

/** Parse an integer written in decimal or 0x-hex, possibly negative, and check it fits `bits`. */
export function parseInteger(text: string, bits: number): bigint {
  const match = /^\s*(-)?(0x[0-9a-f]+|\d+)\s*$/i.exec(text);
  if (!match) throw new Error(`not an integer: "${text}"`);
  const magnitude = BigInt(match[2]);
  const value = match[1] ? -magnitude : magnitude;
  // Accept both the signed and the unsigned range (0xFFFFFFFF and -1 are the same int32)
  if (value < -(1n << BigInt(bits - 1)) || value >= 1n << BigInt(bits)) {
    throw new Error(`${text} does not fit in ${bits} bits`);
  }
  return BigInt.asIntN(64, value);
}

export function parseFloat64(text: string): number {
  const value = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(value)) throw new Error(`not a number: "${text}"`);
  return value;
}

/** Hex byte string ("90 90 c3", or "9090C3" without spaces) to byte values. */
export function parseBytes(text: string): number[] {
  const trimmed = text.trim();
  // With spaces every group is one byte; without, the text is cut in pairs (an odd length fails)
  const tokens = /\s/.test(trimmed) ? trimmed.split(/\s+/) : trimmed.length % 2 === 0 ? (trimmed.match(/../g) ?? []) : [trimmed];
  if (!tokens.length || !tokens.every((t) => /^[0-9a-f]{2}$/i.test(t))) {
    throw new Error(`not a hex byte string: "${text}"`);
  }
  return tokens.map((pair) => parseInt(pair, 16));
}

/** Lua expression that reads a numeric type at `addr` and formats it, or nil if unreadable. */
export function formatRead(type: ValueType): LuaCode {
  if (type in INT_TYPES) {
    const t = INT_TYPES[type as IntType];
    const mask = t.bits === 64 ? '' : ` & 0x${((1n << BigInt(t.bits)) - 1n).toString(16)}`;
    return raw(`(function() local v = ${t.read} if v == nil then return nil end
      return string.format('%d (0x%X)', v, v${mask}) end)()`);
  }
  const t = FLOAT_TYPES[type as keyof typeof FLOAT_TYPES];
  return raw(`(function() local v = ${t.read} if v == nil then return nil end return string.format('%.9g', v) end)()`);
}

/** Lua statement writing `value` (already validated) at `addr`; leaves the success flag in `ok`. */
export function writeStatement(type: ValueType, value: string): LuaCode {
  if (type in INT_TYPES) {
    const t = INT_TYPES[type as IntType];
    return lua`local ok = ${raw(t.write)}(addr, ${parseInteger(value, t.bits)})`;
  }
  const t = FLOAT_TYPES[type as keyof typeof FLOAT_TYPES];
  return lua`local ok = ${raw(t.write)}(addr, ${parseFloat64(value)})`;
}

const addressDescription = "Memory address: hex like '0x12345678', symbol like 'game.exe+0x1234', or pointer chain like '[[game.exe+10]+4]'";

export const memoryTools = [
  defineTool({
    name: 'ce_attach',
    antiCheatExempt: true,
    description: 'Attach to a process by name or PID.',
    schema: {
      process: z.string().describe("Process name (e.g., 'game.exe') or PID as a decimal string"),
    },
    writes: false,
    async run({ process }, ctx) {
      const target = /^\d+$/.test(process.trim()) ? BigInt(process.trim()) : process;
      // Check for an anti-cheat before CE even opens the process (opening it can be detected)
      const pidText = await ctx.run(lua`
        local t = ${target}
        local pid = type(t) == 'number' and t or getProcessIDFromProcessName(t)
        _mcp_str = tostring(pid or 0) .. ' ' .. tostring(_mcp_unsafe == true)`);
      const [pid, unsafe] = (pidText ?? '0 false').split(' ');
      if (!Number(pid)) return `Error: no running process named ${process} (see ce_list_processes)`;
      const antiCheats = await ctx.scope.antiCheatOf(Number(pid));
      if (antiCheats.length && unsafe !== 'true') {
        return `BLOCKED: not attached. Anti-cheat detected in ${process}: ${antiCheats.join(', ')}. ${ANTI_CHEAT_ADVICE}`;
      }
      const warning = antiCheats.length
        ? `\nWARNING: anti-cheat present (${antiCheats.join(', ')}); UNSAFE mode is on, so the user accepted the ban risk`
        : '';
      const text = await ctx.run(lua`
        openProcess(${BigInt(pid)})
        local opened = getOpenedProcessID() or 0
        if opened ~= ${BigInt(pid)} then _mcp_str = 'Error: could not open process ' .. ${process} return end
        _mcp_str = string.format('Attached to PID: %d (%s, %s)', opened, tostring(process), targetIs64Bit() and 'x64' or 'x86')`);
      return (text ?? 'Error: no answer from Cheat Engine') + (text?.startsWith('Error:') ? '' : warning);
    },
  }),

  defineTool({
    name: 'ce_list_processes',
    antiCheatExempt: true,
    description: 'List running processes (paginated).',
    schema: pageSchema(100),
    writes: false,
    async run(page, ctx) {
      const collect = lua`
        local pl = createStringlist()
        getProcessList(pl)
        for i = 0, pl.Count - 1 do items[#items + 1] = pl[i] end
        pl.destroy()`;
      return (await ctx.run(listBody(collect, 'processes', page))) ?? 'No processes';
    },
  }),

  defineTool({
    name: 'ce_list_modules',
    description: 'List modules loaded in the attached process (paginated, in load order).',
    schema: pageSchema(100),
    writes: false,
    requiresProcess: true,
    async run(page, ctx) {
      const collect = lua`
        for _, m in ipairs(enumModules() or {}) do
          items[#items + 1] = string.format('%s: 0x%X (size: 0x%X)', m.Name, m.Address, m.Size or getModuleSize(m.Name) or 0)
        end`;
      return (await ctx.run(listBody(collect, 'modules', page))) ?? 'No modules';
    },
  }),

  defineTool({
    name: 'ce_memory_regions',
    description: "List memory regions of the attached process with their protections (paginated). Filter on the line, e.g. '[RW]' or '0x7FF'.",
    schema: pageSchema(50),
    writes: false,
    requiresProcess: true,
    async run(page, ctx) {
      // Windows PAGE_* base protections (low byte); C = copy-on-write, G = PAGE_GUARD
      const collect = lua`
        local baseProt = { [0x01] = '-', [0x02] = 'R', [0x04] = 'RW', [0x08] = 'RWC',
                           [0x10] = 'X', [0x20] = 'RX', [0x40] = 'RWX', [0x80] = 'RWXC' }
        for _, r in ipairs(enumMemoryRegions() or {}) do
          local prot = ''
          if r.Protect then
            prot = baseProt[r.Protect & 0xFF] or string.format('0x%X', r.Protect)
            if r.Protect & 0x100 ~= 0 then prot = prot .. 'G' end
          end
          items[#items + 1] = string.format('0x%X - 0x%X (size: 0x%X) [%s]',
            r.BaseAddress, r.BaseAddress + r.RegionSize, r.RegionSize, prot)
        end`;
      return (await ctx.run(listBody(collect, 'regions', page))) ?? 'No regions';
    },
  }),

  defineTool({
    name: 'ce_process_info',
    description: 'Get detailed information about the attached process.',
    schema: {},
    writes: false,
    requiresProcess: true,
    async run(_args, ctx) {
      const text = await ctx.run(lua`
        local results = { '=== Process Info ===' }
        results[#results + 1] = string.format('PID: %d', getOpenedProcessID())
        results[#results + 1] = string.format('Name: %s', tostring(process or 'Unknown'))
        results[#results + 1] = string.format('Architecture: %s', targetIs64Bit() and 'x64' or 'x86')
        local modules = enumModules() or {}
        results[#results + 1] = string.format('Modules loaded: %d', #modules)
        local main = modules[1]
        if main then
          results[#results + 1] = string.format('Main module: %s', main.Name)
          results[#results + 1] = string.format('Base address: 0x%X', main.Address)
          results[#results + 1] = string.format('Size: 0x%X (%d KB)', main.Size, main.Size // 1024)
        end
        local monoActive = monopipe ~= nil
        results[#results + 1] = string.format('Mono/.NET: %s', monoActive and 'data collector active' or 'not initialized (ce_mono_init)')
        _mcp_str = table.concat(results, '\n')`);
      return text ?? 'No info';
    },
  }),

  defineTool({
    name: 'ce_read_memory',
    description: `Read memory at an address.

Integers are shown signed with their hex value (e.g. "-1 (0xFFFFFFFF)"), floats with 9 significant digits.`,
    schema: {
      address: z.string().describe(addressDescription),
      type: z.enum(['byte', 'int16', 'int32', 'int64', 'float', 'double', 'string', 'string_utf16', 'bytes']).describe('Data type'),
      size: z.number().int().min(1).max(65536).default(100).describe("Size in bytes for 'bytes', maximum length for strings"),
    },
    writes: false,
    requiresProcess: true,
    async run({ address, type, size }, ctx) {
      let read: LuaCode;
      if (type === 'bytes') {
        read = lua`
          local bytes = readBytes(addr, ${size}, true)
          if not bytes then _mcp_str = 'Error: cannot read ' .. ${address} return end
          local hex = {}
          for i, b in ipairs(bytes) do hex[i] = string.format('%02X', b) end
          value = table.concat(hex, ' ')`;
      } else if (type === 'string' || type === 'string_utf16') {
        read = lua`value = readString(addr, ${size}, ${type === 'string_utf16'})`;
      } else {
        read = lua`value = ${formatRead(type)}`;
      }
      const text = await ctx.run(lua`
        ${resolveAddress(address)}
        local value
        ${read}
        if value == nil then _mcp_str = 'Error: cannot read ' .. ${address} .. string.format(' (0x%X)', addr) return end
        _mcp_str = string.format('%s (%s): %s', ${address}, ${type}, value)`);
      return text ?? `Error: cannot read ${address}`;
    },
  }),

  defineTool({
    name: 'ce_write_memory',
    description: `Write a value to memory.

Integers accept decimal or 0x-hex, signed or unsigned. 'bytes' takes hex bytes like "90 90 C3".`,
    schema: {
      address: z.string().describe(addressDescription),
      type: z.enum(['byte', 'int16', 'int32', 'int64', 'float', 'double', 'string', 'string_utf16', 'bytes']).describe('Data type'),
      value: z.string().describe('Value to write'),
    },
    writes: true,
    requiresProcess: true,
    async run({ address, type, value }, ctx) {
      let write: LuaCode;
      try {
        if (type === 'bytes') write = lua`local ok = writeBytes(addr, { ${raw(parseBytes(value).join(', '))} })`;
        else if (type === 'string' || type === 'string_utf16') write = lua`local ok = writeString(addr, ${value}, ${type === 'string_utf16'})`;
        else write = writeStatement(type, value);
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
      const text = await ctx.run(lua`
        ${resolveAddress(address)}
        ${write}
        if not ok then _mcp_str = string.format('Error: write failed at 0x%X (not writable?)', addr) return end
        _mcp_str = string.format('Written %s (%s) to %s (0x%X)', ${value}, ${type}, ${address}, addr)`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_value_change',
    description: 'Increment or decrement a numeric value in memory by a delta.',
    schema: {
      address: z.string().describe(addressDescription),
      delta: z.string().describe('Amount to add (negative to subtract); decimal, 0x-hex, or a decimal fraction for float/double'),
      type: z.enum(VALUE_TYPES).default('int32').describe('Data type of the value'),
    },
    writes: true,
    requiresProcess: true,
    async run({ address, delta, type }, ctx) {
      const isFloat = type === 'float' || type === 'double';
      let deltaLit;
      try {
        deltaLit = isFloat ? parseFloat64(delta) : parseInteger(delta, 64);
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
      const { read, write } = isFloat ? FLOAT_TYPES[type as 'float' | 'double'] : INT_TYPES[type as IntType];
      const fmt = isFloat ? '%.9g' : '%d';
      const text = await ctx.run(lua`
        ${resolveAddress(address)}
        local current = ${raw(read)}
        if current == nil then _mcp_str = 'Error: cannot read ' .. ${address} return end
        local newVal = current + ${deltaLit}
        if not ${raw(write)}(addr, newVal) then _mcp_str = string.format('Error: write failed at 0x%X', addr) return end
        local after = ${raw(read)}
        _mcp_str = string.format('Changed 0x%X (%s): ' .. ${fmt} .. ' -> ' .. ${fmt}, addr, ${type}, current, after)`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_resolve_address',
    description: "Resolve a symbol or pointer chain to an address (e.g. 'game.exe+0x1234' or '[[base]+0x10]+0x4').",
    schema: {
      expression: z.string().describe('Address expression'),
    },
    writes: false,
    async run({ expression }, ctx) {
      const text = await ctx.run(lua`
        local addr = getAddressSafe(${expression})
        if not addr then _mcp_str = ${expression} .. ' = Not found' return end
        _mcp_str = string.format('%s = 0x%X (%s)', ${expression}, addr, getNameFromAddress(addr))`);
      return text ?? `${expression} = Not found`;
    },
  }),

  defineTool({
    name: 'ce_disassemble',
    description: 'Disassemble instructions at an address.',
    schema: {
      address: z.string().describe(addressDescription),
      count: z.number().int().min(1).max(500).default(10).describe('Number of instructions'),
    },
    writes: false,
    requiresProcess: true,
    async run({ address, count }, ctx) {
      const text = await ctx.run(lua`
        ${resolveAddress(address)}
        local result = {}
        for i = 1, ${count} do
          result[i] = disassemble(addr)
          local size = getInstructionSize(addr)
          if not size or size == 0 then break end
          addr = addr + size
        end
        _mcp_str = table.concat(result, '\n')`);
      return text ?? 'Error: failed to disassemble';
    },
  }),

  defineTool({
    name: 'ce_struct_view',
    description: 'View memory at an address with multiple interpretations per 4-byte slot (bytes, int32, float, pointer).',
    schema: {
      address: z.string().describe(addressDescription),
      size: z.number().int().min(4).max(4096).default(64).describe('Number of bytes to analyze'),
    },
    writes: false,
    requiresProcess: true,
    async run({ address, size }, ctx) {
      const text = await ctx.run(lua`
        ${resolveAddress(address)}
        local results = { string.format('=== Structure at 0x%X ===', addr) }
        local is64 = targetIs64Bit()
        for offset = 0, ${size} - 4, 4 do
          local cur = addr + offset
          local line = string.format('+0x%02X: ', offset)
          local b = readBytes(cur, 4, true)
          if not b then
            line = line .. '(unreadable)'
          else
            local hex = {}
            for i, v in ipairs(b) do hex[i] = string.format('%02X', v) end
            line = line .. string.format('%-12s', table.concat(hex, ' '))
            local i32 = readInteger(cur, true)
            line = line .. string.format('i32:%-11d ', i32 or 0)
            local f = readFloat(cur)
            if f and f == f and math.abs(f) < 1e10 and math.abs(f) > 1e-10 then
              line = line .. string.format('f:%-10.3f ', f)
            else
              line = line .. string.format('f:%-10s ', '-')
            end
            -- Pointers are 8 bytes on x64: only meaningful on 8-byte aligned slots
            local ptr = (not is64 or offset % 8 == 0) and readPointer(cur) or nil
            if ptr and ptr > 0x10000 and ptr < (is64 and 0x7FFFFFFFFFFF or 0x7FFFFFFF) and readBytes(ptr, 1) then
              line = line .. string.format('PTR->0x%X (%s)', ptr, getNameFromAddress(ptr))
            end
          end
          results[#results + 1] = line
        end
        _mcp_str = table.concat(results, '\n')`);
      return text ?? 'Error: failed to read structure';
    },
  }),
];
