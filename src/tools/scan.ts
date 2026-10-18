/**
 * Value scans on dedicated memscan objects (createMemScan), the way CE's own AITools extension
 * scans: options set by name (no GUI combobox index, no GUI error dialog), errors read from
 * ErrorString, results from FoundCount / a FoundList. Scans run as jobs: CE stays responsive and
 * shows a progress window. Several named scans can coexist; they never touch the scan the user
 * runs in CE's main window.
 */

import { z } from 'zod';
import { lua, type LuaCode } from '../lua/lit.js';
import { defineTool } from './registry.js';
import { runJob, waitSchema } from './jobs.js';

const VAR_TYPES = {
  byte: 'vtByte',
  int16: 'vtWord',
  int32: 'vtDword',
  int64: 'vtQword',
  float: 'vtSingle',
  double: 'vtDouble',
  string: 'vtString',
  aob: 'vtByteArray',
  binary: 'vtBinary',
  all: 'vtAll',
} as const;

/** Memory record types for the same value types (ce_scan_add_to_table). */
export const RECORD_TYPES = { ...VAR_TYPES, aob: 'vtByteArray', all: 'vtDword' } as const;

const FIRST_SCAN_TYPES = {
  exact: 'soExactValue',
  greater: 'soBiggerThan',
  less: 'soSmallerThan',
  between: 'soValueBetween',
  unknown: 'soUnknownValue',
} as const;

const NEXT_SCAN_TYPES = {
  exact: 'soExactValue',
  greater: 'soBiggerThan',
  less: 'soSmallerThan',
  between: 'soValueBetween',
  increased: 'soIncreasedValue',
  increased_by: 'soIncreasedValueBy',
  decreased: 'soDecreasedValue',
  decreased_by: 'soDecreasedValueBy',
  changed: 'soChanged',
  unchanged: 'soUnchanged',
} as const;

/** Scan options that compare with the previous values and take no value. */
const NO_VALUE = new Set(['unknown', 'increased', 'decreased', 'changed', 'unchanged']);

const scanName = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/)
  .default('main')
  .describe('Name of the scan, to run several scans side by side (default "main")');

/**
 * Lua: the scan named `name` into locals `s` (state) and `ms` (memscan), or report and return.
 * `ready` also requires its results to be readable (no scan of it running).
 */
function existingScan(name: string, ready = false): LuaCode {
  return lua`
    local s = _mcp.scans[${name}]
    if not s then _mcp_str = 'Error: no scan named ' .. ${name} .. ': start one with ce_scan_value' return end
    if ${ready} and not s.ready then _mcp_str = 'Error: scan ' .. ${name} .. ' is still running (see ce_job_list)' return end
    local ms = s.ms`;
}

/**
 * Job spec for a scan already started on `s` (main thread): a CE thread waits for it, progress
 * comes from getProgress(), the result summarises FoundCount and lists the first results.
 * A failed first scan is dropped; a failed refinement keeps the scan.
 */
function scanJob(kind: string, name: string, first: boolean, summary: LuaCode): LuaCode {
  return lua`{
    kind = ${kind}, window = true,
    run = function(job) ms.waitTillDone() end,
    update = function(job)
      local p = ms.getProgress()
      if p and p.TotalAddressesToScan and p.TotalAddressesToScan > 0 then
        job.total, job.done = p.TotalAddressesToScan, p.CurrentlyScanned
        job.message = string.format('%s: %d found', ${kind}, p.ResultsFound or 0)
      end
    end,
    finish = function(job)
      if ms.ErrorString and ms.ErrorString ~= '' then
        local err = ms.ErrorString
        if ${first} then _mcp.dropScan(${name}) else pcall(_mcp.scanEnd, s) end
        error('scan error: ' .. err, 0)
      end
      _mcp.scanEnd(s)
      local count = ms.FoundCount
      local lines = { string.format(${summary}, count) }
      if count > 0 and count <= 10 then
        for i = 0, s.fl.Count - 1 do lines[#lines + 1] = string.format('  0x%s = %s', s.fl.Address[i], s.fl.Value[i]) end
      elseif count > 10 then
        lines[#lines + 1] = 'Refine with ce_scan_next, or list them with ce_scan_results'
      end
      return table.concat(lines, '\n')
    end,
  }`;
}

type MemoryPref = 'yes' | 'no' | 'any';

interface FirstScan {
  name: string;
  kind: string;
  /** Lua that sets the locals `start` and `stop` (MAX_ADDRESS is defined), or reports and returns. */
  range: LuaCode;
  varType: string;
  option: string;
  value: string;
  value2: string;
  hexadecimal: boolean;
  memory: { writable: MemoryPref; executable: MemoryPref; copy_on_write: MemoryPref };
  alignment: number;
  /** string.format pattern of the result's first line, with %d for the result count. */
  summary: string;
}

/** Job spec expression that starts a first scan on a new memscan named `name`. */
function firstScan(spec: FirstScan): LuaCode {
  const pref = { yes: 'scanInclude', no: 'scanExclude', any: 'scanDontCare' } as const;
  const aligned = spec.alignment > 1;
  return lua`(function()
    if _mcp.scans[${spec.name}] and not _mcp.scans[${spec.name}].ready then
      _mcp_str = 'Error: scan ' .. ${spec.name} .. ' is still running (see ce_job_list)' return
    end
    local MAX_ADDRESS = targetIs64Bit() and 0x7FFFFFFFFFFFFFFF or 0xFFFFFFFF
    ${spec.range}
    _mcp.dropScan(${spec.name})
    local ms = createMemScan()
    ms.VarType = ${spec.varType}
    ms.ScanOption = ${spec.option}
    ms.Scanvalue1 = ${spec.value}
    ms.Scanvalue2 = ${spec.value2}
    ms.Hexadecimal = ${spec.hexadecimal}
    ms.Startaddress = start
    ms.Stopaddress = stop
    ms.ScanWritable = ${pref[spec.memory.writable]}
    ms.ScanExecutable = ${pref[spec.memory.executable]}
    ms.ScanCopyOnWrite = ${pref[spec.memory.copy_on_write]}
    ms.Fastscanmethod = ${aligned ? 'fsmAligned' : 'fsmNotAligned'}
    ms.Fastscanparameter = ${String(aligned ? spec.alignment : 1)}
    local s = { ms = ms, ready = false }
    _mcp.scans[${spec.name}] = s
    ms.firstScan()
    return ${scanJob(spec.kind, spec.name, true, lua`${spec.summary}`)}
  end)()`;
}

export const scanTools = [
  defineTool({
    name: 'ce_scan_value',
    description: `Start a new memory scan for a value. This is the first step in finding memory addresses.

RECOMMENDED FIRST APPROACH: Use this before trying ce_mono_* functions.
For finding game values (health, gold, ammo, strings), scanning is simpler than
reverse engineering class structures.

The scan runs in the background (CE shows its progress); up to 10 results are listed directly.
Then: change the value in the game and refine with ce_scan_next.

ERROR HANDLING:
- If scan hangs or returns no results after 2-3 attempts, STOP and ask user`,
    schema: {
      value: z.string().default('').describe("Value to search for, e.g. '100' or '3.14' (not needed for scan_type 'unknown')"),
      value_type: z.enum(Object.keys(VAR_TYPES) as [keyof typeof VAR_TYPES]).default('int32').describe("Value type; 'all' = int32, float and double at once"),
      scan_type: z.enum(Object.keys(FIRST_SCAN_TYPES) as [keyof typeof FIRST_SCAN_TYPES]).default('exact').describe("'unknown' takes a snapshot of every value, to refine with changed/increased/... later"),
      value2: z.string().default('').describe("Upper bound for scan_type 'between'"),
      hexadecimal: z.boolean().default(false).describe('The value is hexadecimal'),
      start_address: z.string().default('').describe('Only scan from this address (default: everything)'),
      stop_address: z.string().default('').describe('Only scan up to this address'),
      writable: z.enum(['yes', 'no', 'any']).default('yes').describe('Writable memory only (yes, default), excluded (no) or both (any)'),
      executable: z.enum(['yes', 'no', 'any']).default('any').describe('Executable memory'),
      copy_on_write: z.enum(['yes', 'no', 'any']).default('no').describe('Copy-on-write memory'),
      alignment: z.number().int().min(0).max(64).default(4).describe('Only addresses that are a multiple of this (fast scan); 0 or 1 = every address'),
      scan_name: scanName,
      ...waitSchema,
    },
    writes: false,
    requiresProcess: true,
    async run(args, ctx) {
      const { value, value_type, scan_type, value2, hexadecimal, start_address, stop_address, scan_name, wait } = args;
      if (!NO_VALUE.has(scan_type) && !value.trim()) return `Error: scan_type '${scan_type}' needs a value`;
      if (scan_type === 'between' && !value2.trim()) return "Error: scan_type 'between' needs value2";
      const range = lua`
        local function addressOf(text, default)
          if text == '' then return default end
          local a = getAddressSafe(text)
          if not a then error('invalid address: ' .. text, 0) end
          return a
        end
        local start, stop = addressOf(${start_address}, 0), addressOf(${stop_address}, MAX_ADDRESS)`;
      const kind = `${scan_type} ${value_type} scan`;
      return runJob(
        ctx,
        kind,
        firstScan({
          name: scan_name,
          kind,
          range,
          varType: VAR_TYPES[value_type],
          option: FIRST_SCAN_TYPES[scan_type],
          value,
          value2,
          hexadecimal,
          memory: args,
          alignment: args.alignment,
          summary: `Scan "${scan_name}" complete (${scan_type}, ${value_type}): %d results`,
        }),
        wait,
      );
    },
  }),

  defineTool({
    name: 'ce_aob_scan',
    description: `Scan memory for an array of bytes pattern, in the background (CE shows its progress). Up to 10 matches are listed directly; the matches stay a named scan: page through them with ce_scan_results(scan_name="aob").

The pattern is hex bytes with ?? (or ?) wildcards, e.g. '89 45 ?? 8B 4D'.`,
    schema: {
      pattern: z.string().describe("Byte pattern with wildcards, e.g. '89 45 ?? 8B 4D'"),
      module: z.string().default('').describe('Only scan this module (e.g. "game.exe"); default: all memory'),
      writable: z.enum(['yes', 'no', 'any']).default('any').describe('Writable memory'),
      executable: z.enum(['yes', 'no', 'any']).default('any').describe('Executable memory ("yes" with writable "no" = code only)'),
      copy_on_write: z.enum(['yes', 'no', 'any']).default('any').describe('Copy-on-write memory'),
      scan_name: scanName.default('aob'),
      ...waitSchema,
    },
    writes: false,
    requiresProcess: true,
    async run({ pattern, module, scan_name, wait, ...memory }, ctx) {
      const tokens = pattern.trim().split(/\s+/);
      if (!tokens.every((t) => /^([0-9a-f]{2}|\?\??)$/i.test(t))) {
        return `Error: invalid pattern "${pattern}": expected hex bytes and ?? wildcards separated by spaces`;
      }
      const range = module
        ? lua`
          local start = getAddressSafe(${module})
          local size = start and getModuleSize(${module})
          if not start or not size then _mcp_str = 'Error: module not found: ' .. ${module} return end
          local stop = start + size`
        : lua`local start, stop = 0, MAX_ADDRESS`;
      const kind = 'AOB scan';
      return runJob(
        ctx,
        kind,
        firstScan({
          name: scan_name,
          kind,
          range,
          varType: 'vtByteArray',
          option: 'soExactValue',
          value: tokens.map((t) => (t.startsWith('?') ? '??' : t.toUpperCase())).join(' '),
          value2: '',
          hexadecimal: true,
          memory,
          alignment: 1,
          summary: `AOB scan "${scan_name}"${module ? ` in ${module}` : ''} complete: %d matches`,
        }),
        wait,
      );
    },
  }),

  defineTool({
    name: 'ce_scan_next',
    description: `Refine the results of a scan with a new value or condition (the game value must have changed first).

scan_type changed, unchanged, increased, decreased compare with the previous scan and take no value;
exact, greater, less, between, increased_by, decreased_by need one.`,
    schema: {
      value: z.string().default('').describe('New value (or the amount for increased_by / decreased_by)'),
      scan_type: z.enum(Object.keys(NEXT_SCAN_TYPES) as [keyof typeof NEXT_SCAN_TYPES]).default('exact').describe('How to refine'),
      value2: z.string().default('').describe("Upper bound for scan_type 'between'"),
      scan_name: scanName,
      ...waitSchema,
    },
    writes: false,
    requiresProcess: true,
    async run({ value, scan_type, value2, scan_name, wait }, ctx) {
      if (!NO_VALUE.has(scan_type) && !value.trim()) {
        return `Error: scan_type '${scan_type}' needs a value (changed, unchanged, increased and decreased do not)`;
      }
      const kind = `${scan_type} next scan`;
      return runJob(
        ctx,
        kind,
        lua`(function()
          ${existingScan(scan_name, true)}
          _mcp.scanBegin(s)
          ms.ScanOption = ${NEXT_SCAN_TYPES[scan_type]}
          ms.Scanvalue1 = ${value}
          ms.Scanvalue2 = ${value2}
          ms.CompareToSavedScan = false
          ms.nextScan()
          return ${scanJob(kind, scan_name, false, lua`${`Scan "${scan_name}" refined (${scan_type}): %d results remaining`}`)}
        end)()`,
        wait,
      );
    },
  }),

  defineTool({
    name: 'ce_scan_results',
    description: 'List the results of a scan with their current values (paginated).',
    schema: {
      scan_name: scanName,
      offset: z.number().int().min(0).default(0).describe('Index of the first result to return'),
      limit: z.number().int().min(1).max(1000).default(20).describe('Maximum number of results'),
    },
    writes: false,
    requiresProcess: true,
    async run({ scan_name, offset, limit }, ctx) {
      const text = await ctx.run(lua`
        ${existingScan(scan_name, true)}
        local fl = s.fl
        local total = fl.Count
        local out = {}
        if total == 0 then
          out[1] = 'No results in scan ' .. ${scan_name}
        elseif ${offset} >= total then
          out[1] = string.format('offset=%d is past the end: %d results', ${offset}, total)
        else
          local last = math.min(total, ${offset} + ${limit})
          out[1] = string.format('results %d-%d of %d', ${offset} + 1, last, total)
          for i = ${offset}, last - 1 do out[#out + 1] = string.format('[%d] 0x%s = %s', i, fl.Address[i], fl.Value[i]) end
          if last < total then out[#out + 1] = string.format('... %d more, next page: offset=%d', total - last, last) end
        end
        _mcp_str = table.concat(out, '\n')`);
      return text ?? 'No results';
    },
  }),

  defineTool({
    name: 'ce_scan_reset',
    antiCheatExempt: true,
    description: 'Discard a scan and its results (frees the memory and files CE keeps for it).',
    schema: { scan_name: scanName },
    writes: false,
    async run({ scan_name }, ctx) {
      const text = await ctx.run(lua`
        local s = _mcp.scans[${scan_name}]
        if s and not s.ready then _mcp_str = 'Error: scan ' .. ${scan_name} .. ' is still running: cancel its job first' return end
        _mcp_str = _mcp.dropScan(${scan_name}) and ('Scan ' .. ${scan_name} .. ' discarded') or ('No scan named ' .. ${scan_name})`);
      return text ?? 'Scan reset';
    },
  }),

  defineTool({
    name: 'ce_scan_list',
    antiCheatExempt: true,
    description: 'List the scans kept by the server, with their result counts.',
    schema: {},
    writes: false,
    async run(_args, ctx) {
      const text = await ctx.run(lua`
        local lines = {}
        for name, s in pairs(_mcp.scans) do
          lines[#lines + 1] = s.ready and string.format('%s: %d results', name, s.ms.FoundCount) or (name .. ': running')
        end
        table.sort(lines)
        _mcp_str = #lines > 0 and table.concat(lines, '\n') or 'No scans'`);
      return text ?? 'No scans';
    },
  }),

  defineTool({
    name: 'ce_scan_add_to_table',
    description: "Add a scan result to CE's address list (cheat table), optionally frozen.",
    schema: {
      index: z.number().int().min(0).default(0).describe('Index of the result (as shown by ce_scan_results)'),
      name: z.string().default('').describe('Description of the entry'),
      value_type: z.enum(Object.keys(RECORD_TYPES) as [keyof typeof RECORD_TYPES]).default('int32').describe('Type of the entry (normally the scan type)'),
      freeze: z.boolean().default(false).describe('Freeze the value immediately'),
      scan_name: scanName,
    },
    writes: ({ freeze }) => freeze,
    requiresProcess: true,
    async run({ index, name, value_type, freeze, scan_name }, ctx) {
      const text = await ctx.run(lua`
        ${existingScan(scan_name, true)}
        local count = s.fl.Count
        local address = ${index} < count and s.fl.Address[${index}] or nil
        if not address then _mcp_str = string.format('Error: index %d out of range (%d results)', ${index}, count) return end
        local mr = getAddressList().createMemoryRecord()
        mr.Address = address
        mr.VarType = ${RECORD_TYPES[value_type]}
        mr.Description = ${name} ~= '' and ${name} or ('Scan result ' .. address)
        if ${freeze} then mr.Active = true end
        _mcp_str = string.format('Added 0x%s to the address list as record %d (%s = %s)%s', address, mr.ID, mr.Description,
          tostring(mr.Value), ${freeze} and ' (FROZEN)' or '')`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_snapshot_create',
    description: "Save a scan's current results and values under a name, to compare against later with ce_snapshot_compare.",
    schema: {
      name: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('snapshot').describe('Snapshot name'),
      scan_name: scanName,
    },
    writes: false,
    requiresProcess: true,
    async run({ name, scan_name }, ctx) {
      const text = await ctx.run(lua`
        ${existingScan(scan_name, true)}
        ms.saveCurrentResults(${name})
        _mcp_str = string.format('Snapshot "%s" saved (%d results of scan %s)', ${name}, ms.FoundCount, ${scan_name})`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_snapshot_compare',
    description: "Refine a scan by comparing current values with a saved snapshot instead of the previous scan.",
    schema: {
      mode: z.enum(['changed', 'unchanged', 'increased', 'decreased']).default('changed').describe('Keep the values that ... since the snapshot'),
      name: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).default('snapshot').describe('Snapshot name'),
      scan_name: scanName,
      ...waitSchema,
    },
    writes: false,
    requiresProcess: true,
    async run({ mode, name, scan_name, wait }, ctx) {
      const kind = `compare to snapshot ${name}`;
      return runJob(
        ctx,
        kind,
        lua`(function()
          ${existingScan(scan_name, true)}
          local known = false
          for _, saved in ipairs(ms.getSavedResultList() or {}) do if saved == ${name} then known = true end end
          if not known then _mcp_str = 'Error: no snapshot named ' .. ${name} .. ' in scan ' .. ${scan_name} return end
          _mcp.scanBegin(s)
          ms.ScanOption = ${NEXT_SCAN_TYPES[mode]}
          ms.CompareToSavedScan = true
          ms.SavedScanName = ${name}
          ms.nextScan()
          return ${scanJob(kind, scan_name, false, lua`${`Compared with snapshot "${name}" (${mode}): %d results remaining`}`)}
        end)()`,
        wait,
      );
    },
  }),
];
