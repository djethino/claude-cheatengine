/**
 * CE's address list (cheat table): watched addresses, freezes, hotkeys, code entries, .CT files.
 *
 * Records are designated by their ID (shown by ce_watch_list, returned when created), which never
 * changes; the Python version matched addresses by substring or Lua pattern and could act on the
 * wrong record.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { z } from 'zod';
import { lua, raw, type LuaCode } from '../lua/lit.js';
import { defineTool } from './registry.js';
import { listBody, pageSchema } from './list.js';
import { parseBytes } from './memory.js';

export const RECORD_VAR_TYPES = {
  byte: 'vtByte',
  int16: 'vtWord',
  int32: 'vtDword',
  int64: 'vtQword',
  float: 'vtSingle',
  double: 'vtDouble',
  string: 'vtString',
  string_utf16: 'vtUnicodeString',
  aob: 'vtByteArray',
} as const;
const recordType = z.enum(Object.keys(RECORD_VAR_TYPES) as [keyof typeof RECORD_VAR_TYPES]);

const recordId = z.number().int().min(0).describe('Record ID, as shown by ce_watch_list');

/** Lua: the record with this ID into local `mr`, or report and return. */
function recordById(id: number): LuaCode {
  return lua`
    local mr = getAddressList().getMemoryRecordByID(${id})
    if not mr then _mcp_str = 'Error: no record with ID ' .. ${id} .. ' (see ce_watch_list)' return end`;
}

/** Lua: one display line for record `mr`. */
const RECORD_LINE = raw(`string.format('#%d [%s] %s = %s%s', mr.ID, mr.Address or '', mr.Description or '',
  tostring(mr.Value or '?'), mr.Active and (mr.Script and ' [ENABLED]' or ' [FROZEN]') or '')`);

/** Virtual-key codes (defines.lua) for hotkey names. */
const KEYS: Record<string, number> = {
  CTRL: 17, CONTROL: 17, ALT: 18, SHIFT: 16, SPACE: 32, ENTER: 13, RETURN: 13, ESC: 27, ESCAPE: 27, TAB: 9,
  BACKSPACE: 8, INSERT: 45, INS: 45, DELETE: 46, DEL: 46, HOME: 36, END: 35, PAGEUP: 33, PGUP: 33,
  PAGEDOWN: 34, PGDN: 34, UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39,
};
for (let i = 1; i <= 24; i++) KEYS[`F${i}`] = 111 + i;
for (let i = 0; i <= 9; i++) {
  KEYS[String(i)] = 48 + i;
  KEYS[`NUMPAD${i}`] = 96 + i;
}
for (let c = 65; c <= 90; c++) KEYS[String.fromCharCode(c)] = c;

export function parseHotkey(text: string): number[] {
  const names = text.split('+').map((part) => part.trim().toUpperCase());
  const codes = names.map((name) => {
    const code = KEYS[name];
    if (code === undefined) throw new Error(`unknown key "${name}" in "${text}" (e.g. Ctrl+Shift+F1, Alt+X, Numpad5)`);
    return code;
  });
  if (codes.length > 5) throw new Error('a hotkey has at most 5 keys');
  return codes;
}

const HOTKEY_ACTIONS = {
  toggle: 0, // mrhToggleActivation: freeze / unfreeze (enable / disable for scripts)
  activate: 3,
  deactivate: 4,
  set: 5,
  increase: 6,
  decrease: 7,
} as const;

/** Absolute .CT path from a file name and an optional directory (default: the server's working directory). */
function tablePath(filename: string, directory: string): string {
  const name = /\.(ct|cetrainer)$/i.test(filename) ? filename : `${filename}.CT`;
  return isAbsolute(name) ? name : resolve(directory ? directory : process.cwd(), name);
}

export const tableTools = [
  defineTool({
    name: 'ce_watch_add',
    description: "Add an address to CE's address list (watch list). Returns the record ID used by the other ce_watch_* tools.",
    schema: {
      address: z.string().describe("Address or symbol, e.g. '0x1234ABCD' or 'game.exe+1234'; with offsets, the pointer base"),
      name: z.string().default('').describe('Description of the entry'),
      value_type: recordType.default('int32').describe('Value type'),
      offsets: z.array(z.string()).default([]).describe('Pointer offsets from the base, outermost first, e.g. ["10", "4"] for [[base]+10]+4'),
      string_length: z.number().int().min(1).max(4096).default(32).describe('Length for string types'),
    },
    writes: false,
    async run({ address, name, value_type, offsets, string_length }, ctx) {
      const offsetLines = offsets.map((offset, i) => lua`mr.OffsetText[${i}] = ${offset}`);
      const text = await ctx.run(lua`
        local mr = getAddressList().createMemoryRecord()
        mr.Address = ${address}
        mr.OffsetCount = ${offsets.length}
        ${raw(offsetLines.map((l) => l.code).join('\n'))}
        mr.VarType = ${RECORD_VAR_TYPES[value_type]}
        if mr.VarType == 'vtString' or mr.VarType == 'vtUnicodeString' then mr.String.Size = ${string_length} end
        mr.Description = ${name} ~= '' and ${name} or ${address}
        _mcp_str = 'Added ' .. ${RECORD_LINE}`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_watch_list',
    description: "List the entries of CE's address list with their IDs and current values (paginated).",
    schema: pageSchema(100),
    writes: false,
    async run(page, ctx) {
      const collect = lua`
        local al = getAddressList()
        for i = 0, al.Count - 1 do
          local mr = al.getMemoryRecord(i)
          items[#items + 1] = ${RECORD_LINE}
        end`;
      return (await ctx.run(listBody(collect, 'records', page))) ?? 'No records';
    },
  }),

  defineTool({
    name: 'ce_watch_modify',
    description: 'Modify an entry of the address list: value, description, type or address. Only the given fields change.',
    schema: {
      record: recordId,
      value: z.string().optional().describe('New value written to the game'),
      description: z.string().optional().describe('New description'),
      value_type: recordType.optional().describe('New value type'),
      address: z.string().optional().describe('New address'),
    },
    writes: ({ value }) => value !== undefined,
    async run({ record, value, description, value_type, address }, ctx) {
      const changes: LuaCode[] = [];
      if (description !== undefined) changes.push(lua`mr.Description = ${description}`);
      if (value_type !== undefined) changes.push(lua`mr.VarType = ${RECORD_VAR_TYPES[value_type]}`);
      if (address !== undefined) changes.push(lua`mr.Address = ${address}`);
      if (value !== undefined) changes.push(lua`mr.Value = ${value}`);
      if (!changes.length) return 'Error: nothing to change (give value, description, value_type or address)';
      const text = await ctx.run(lua`
        ${recordById(record)}
        ${raw(changes.map((c) => c.code).join('\n'))}
        _mcp_str = 'Modified ' .. ${RECORD_LINE}`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_watch_remove',
    description: 'Remove an entry from the address list (an enabled script is disabled first, which restores the code).',
    schema: { record: recordId },
    writes: false,
    async run({ record }, ctx) {
      const text = await ctx.run(lua`
        ${recordById(record)}
        local line = ${RECORD_LINE}
        if mr.Active then mr.Active = false end
        mr.destroy()
        _mcp_str = 'Removed ' .. line`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_watch_clear',
    description: 'Remove every entry from the address list (enabled scripts are disabled first).',
    schema: {},
    writes: false,
    async run(_args, ctx) {
      const text = await ctx.run(lua`
        local al = getAddressList()
        local count = al.Count
        for i = count - 1, 0, -1 do
          local mr = al.getMemoryRecord(i)
          if mr.Active then mr.Active = false end
        end
        al.clear()
        _mcp_str = string.format('Address list cleared (%d entries)', count)`);
      return text ?? 'Address list cleared';
    },
  }),

  defineTool({
    name: 'ce_freeze',
    description: `Freeze a value: CE keeps writing it so the game cannot change it.

Either an existing record (record) or an address (a new record is created). The value is the current one unless given.`,
    schema: {
      record: recordId.optional(),
      address: z.string().optional().describe('Address to freeze when no record is given'),
      value: z.string().optional().describe('Value to freeze at (default: the current value)'),
      value_type: recordType.default('int32').describe('Value type for a new record'),
      name: z.string().default('').describe('Description for a new record'),
    },
    writes: true,
    requiresProcess: true,
    async run({ record, address, value, value_type, name }, ctx) {
      if ((record === undefined) === (address === undefined)) return 'Error: give either record or address';
      const find =
        record !== undefined
          ? recordById(record)
          : lua`
            local mr = getAddressList().createMemoryRecord()
            mr.Address = ${address!}
            mr.VarType = ${RECORD_VAR_TYPES[value_type]}
            mr.Description = ${name} ~= '' and ${name} or ('Frozen: ' .. ${address!})`;
      const text = await ctx.run(lua`
        ${find}
        if mr.Script then _mcp_str = 'Error: record ' .. mr.ID .. ' is a script: enable it with ce_watch_modify or the CE window' return end
        ${value !== undefined ? lua`mr.Value = ${value}` : raw('')}
        mr.Active = true
        if not mr.Active then _mcp_str = 'Error: CE refused to freeze ' .. ${RECORD_LINE} return end
        _mcp_str = 'Frozen ' .. ${RECORD_LINE}`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_unfreeze',
    antiCheatExempt: true,
    description: 'Unfreeze a record (or every frozen value when no record is given). Scripts are left as they are.',
    schema: { record: recordId.optional() },
    writes: false,
    async run({ record }, ctx) {
      const text = await ctx.run(
        record !== undefined
          ? lua`
            ${recordById(record)}
            mr.Active = false
            _mcp_str = 'Unfrozen ' .. ${RECORD_LINE}`
          : lua`
            local al, count = getAddressList(), 0
            for i = 0, al.Count - 1 do
              local mr = al.getMemoryRecord(i)
              if mr.Active and not mr.Script then mr.Active = false count = count + 1 end
            end
            _mcp_str = string.format('Unfrozen %d entries', count)`,
      );
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_freeze_list',
    description: 'List the frozen values and enabled scripts of the address list.',
    schema: {},
    writes: false,
    async run(_args, ctx) {
      const text = await ctx.run(lua`
        local al, lines = getAddressList(), {}
        for i = 0, al.Count - 1 do
          local mr = al.getMemoryRecord(i)
          if mr.Active then lines[#lines + 1] = ${RECORD_LINE} end
        end
        _mcp_str = #lines > 0 and table.concat(lines, '\n') or 'No frozen entries'`);
      return text ?? 'No frozen entries';
    },
  }),

  defineTool({
    name: 'ce_hotkey_add',
    description: `Attach a keyboard hotkey to a record of the address list (works while the game has focus; saved with the table).

Actions: toggle (freeze/unfreeze, or enable/disable a script), activate, deactivate, set (to value), increase / decrease (by value).`,
    schema: {
      record: recordId,
      keys: z.string().describe("Key combination, e.g. 'F1', 'Ctrl+F1', 'Alt+Shift+X', 'Numpad5'"),
      action: z.enum(Object.keys(HOTKEY_ACTIONS) as [keyof typeof HOTKEY_ACTIONS]).default('toggle').describe('What the hotkey does'),
      value: z.string().default('').describe('Value for set / increase / decrease'),
    },
    writes: true,
    async run({ record, keys, action, value }, ctx) {
      let codes: number[];
      try {
        codes = parseHotkey(keys);
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
      if (['set', 'increase', 'decrease'].includes(action) && !value.trim()) return `Error: action '${action}' needs a value`;
      const text = await ctx.run(lua`
        ${recordById(record)}
        local hk = mr.createHotkey({ ${raw(codes.join(', '))} }, ${HOTKEY_ACTIONS[action]}, ${value}, ${`${action} ${value}`.trim()})
        if not hk then _mcp_str = 'Error: CE could not create the hotkey' return end
        _mcp_str = string.format('Hotkey %s (%s) added to record #%d %s', hk.HotkeyString, ${action}, mr.ID, mr.Description)`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_code_entry',
    description: `Add a code patch to the address list as a toggleable auto assembler entry: enabling writes enable_bytes at the address, disabling restores disable_bytes.

When disable_bytes is omitted, the bytes currently at the address are read and used (the original code).`,
    schema: {
      address: z.string().describe("Address of the code to patch, e.g. 'game.exe+1A2B'"),
      description: z.string().describe('Name of the cheat entry'),
      enable_bytes: z.string().describe("Bytes written when enabled, e.g. '90 90 90'"),
      disable_bytes: z.string().default('').describe('Original bytes restored when disabled (default: read from memory now)'),
      active: z.boolean().default(true).describe('Enable it immediately'),
    },
    writes: true,
    dangerous: true,
    requiresProcess: true,
    async run({ address, description, enable_bytes, disable_bytes, active }, ctx) {
      let enable: number[];
      let disable: number[] | null = null;
      try {
        enable = parseBytes(enable_bytes);
        if (disable_bytes.trim()) disable = parseBytes(disable_bytes);
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
      if (disable && disable.length !== enable.length) {
        return `Error: enable_bytes has ${enable.length} bytes and disable_bytes ${disable.length}: they must patch the same range`;
      }
      const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
      const text = await ctx.run(lua`
        local addr = getAddressSafe(${address})
        if not addr then _mcp_str = 'Error: invalid address: ' .. ${address} return end
        local disable = ${disable ? hex(disable) : ''}
        if disable == '' then
          local original = readBytes(addr, ${enable.length}, true)
          if not original then _mcp_str = string.format('Error: cannot read the original bytes at 0x%X', addr) return end
          local parts = {}
          for i, b in ipairs(original) do parts[i] = string.format('%02X', b) end
          disable = table.concat(parts, ' ')
        end
        local mr = getAddressList().createMemoryRecord()
        mr.Description = ${description}
        mr.VarType = 'vtAutoAssembler'
        mr.Script = string.format('[ENABLE]\n%X:\ndb %s\n\n[DISABLE]\n%X:\ndb %s\n', addr, ${hex(enable)}, addr, disable)
        if ${active} then mr.Active = true end
        _mcp_str = string.format('Code entry #%d "%s" at 0x%X (%s): enable %s / disable %s', mr.ID, mr.Description, addr,
          mr.Active and 'enabled' or 'disabled', ${hex(enable)}, disable)
        if ${active} and not mr.Active then _mcp_str = 'Error: CE could not enable it. ' .. _mcp_str end`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_table_save',
    description: 'Save the address list to a CE table file (.CT).',
    schema: {
      filename: z.string().describe('File name (".CT" is added) or absolute path'),
      directory: z.string().default('').describe("Folder for a relative file name (default: the MCP server's working directory)"),
      save_active_states: z
        .boolean()
        .default(false)
        .describe('Also save which entries are frozen/enabled, so they activate when the table is loaded (risky with dynamic addresses)'),
    },
    writes: true,
    async run({ filename, directory, save_active_states }, ctx) {
      const path = tablePath(filename, directory);
      const text = await ctx.run(lua`
        local al = getAddressList()
        local active = {}
        for i = 0, al.Count - 1 do
          local mr = al.getMemoryRecord(i)
          if mr.Active then active[#active + 1] = tostring(mr.ID) end
        end
        local ok, err = pcall(saveTable, ${path})
        if not ok then _mcp_str = 'Error: cannot save ' .. ${path} .. ': ' .. tostring(err) return end
        _mcp_str = al.Count .. '|' .. table.concat(active, ',')`);
      if (!text || text.startsWith('Error:')) return text ?? 'Error: no answer from Cheat Engine';
      if (!existsSync(path)) return `Error: CE reported success but ${path} does not exist`;
      const [count, activeList] = text.split('|');
      if (!save_active_states || !activeList) return `Table saved to ${path} (${count} entries)`;
      // CE does not store activation states in a .CT: mark the active entries so loading re-enables them
      const active = new Set(activeList.split(','));
      const xml = readFileSync(path, 'utf8').replace(/<ID>(\d+)<\/ID>/g, (match, id: string) =>
        active.has(id) ? `${match}\n      <Active>1</Active>` : match,
      );
      writeFileSync(path, xml, 'utf8');
      return `Table saved to ${path} (${count} entries, ${active.size} marked active)`;
    },
  }),

  defineTool({
    name: 'ce_table_load',
    description: 'Load a CE table file (.CT). A table can contain Lua and auto assembler scripts that CE runs, hence locked in SAFE mode.',
    schema: {
      filename: z.string().describe('File name (".CT" is added) or absolute path'),
      directory: z.string().default('').describe("Folder for a relative file name (default: the MCP server's working directory)"),
      merge: z.boolean().default(false).describe('Add to the current address list instead of replacing it'),
    },
    writes: true,
    dangerous: true,
    async run({ filename, directory, merge }, ctx) {
      const path = tablePath(filename, directory);
      if (!existsSync(path)) return `Error: no such file: ${path}`;
      const text = await ctx.run(lua`
        local ok, err = pcall(loadTable, ${path}, ${merge})
        if not ok then _mcp_str = 'Error: cannot load ' .. ${path} .. ': ' .. tostring(err) return end
        _mcp_str = string.format('Table loaded: %s (%d entries in the address list)', ${path}, getAddressList().Count)`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),
];
