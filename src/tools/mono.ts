/**
 * Mono / IL2CPP (Unity) inspection through CE's Mono data collector (monoscript.lua).
 *
 * Crash history (souvenir, Jan 2026): find_instances walked the whole managed heap through the
 * collector (minutes, then a crash as the GC moved objects) and repeated static field accesses
 * through the collector crashed games. Here:
 * - instances are found by a plain memory scan for the class's vtable pointer (an object starts
 *   with it; with IL2CPP the class pointer itself): read-only, never touches the collector or GC
 * - statics: one collector call for the static data address, then plain memory reads
 * Values are read with CE's .NET value readers (dotnetinfo.lua) for the field's real type.
 */

import { z } from 'zod';
import { lua, raw, type LuaCode } from '../lua/lit.js';
import { defineTool } from './registry.js';
import { listBody, pageSchema } from './list.js';
import { runJob, waitSchema } from './jobs.js';

const assemblyArg = z.string().default('').describe('Assembly name, e.g. "Assembly-CSharp" (".dll" optional). Empty: search every assembly');
const classArg = z.string().describe('Class name, with its namespace if it has one, e.g. "Game.PlayerStats"');

/**
 * Lua helpers shared by the Mono tools: collector check, assembly lookup, class lookup (into
 * `klass`), field lookup, typed value read.
 */
const MONO_HELPERS = raw(`
  if not (mono_isValid and mono_isValid()) then _mcp_str = 'Error: Mono is not initialized: run ce_mono_init first' return end
  -- Mono type codes of reference fields: string, class, array, object, single-dimension array
  local REF_TYPES = { [0x0E] = true, [0x12] = true, [0x14] = true, [0x1C] = true, [0x1D] = true }
  local function normName(s) return ((s or ''):lower():gsub('%.dll$', '')) end
  local function findImage(asm)
    for _, a in ipairs(mono_enumAssemblies() or {}) do
      local img = mono_getImageFromAssembly(a)
      if normName(mono_image_get_name(img)) == normName(asm) then return img end
    end
  end
  local function findClass(full, asm)
    local ns, name = full:match('^(.*)%.([^%.]+)$')
    if not ns then ns, name = '', full end
    if asm == '' then
      local k = mono_findClass(ns, name)
      if not k or k == 0 then return nil, 'class not found: ' .. full end
      return k
    end
    local img = findImage(asm)
    if not img then return nil, 'no assembly named ' .. asm .. ' (see ce_mono_assemblies)' end
    for _, c in ipairs(mono_image_enumClasses(img) or {}) do
      if c.classname == name and (c.namespace or '') == ns then return c.class end
    end
    return nil, 'class ' .. full .. ' not found in ' .. asm
  end
  local function fieldsOf(klass) return mono_class_enumFields(klass, true) or {} end
  local function readValue(address, field)
    -- References as 0x pointers (CE's readers give bare hex, sometimes zero-padded)
    if REF_TYPES[field.monotype] or field.monotype == 0x18 then
      local p = readPointer(address)
      return p and string.format('0x%X', p) or '??'
    end
    local reader = getDotNetValueReader and getDotNetValueReader(field.monotype)
    if reader then
      local ok, v = pcall(reader, address, field)
      if ok and v ~= nil then return tostring(v) end
    end
    local p = readPointer(address)
    return p and string.format('0x%X', p) or '??'
  end
  -- A static field's value. Mono: the class's static data address + the field offset, read from
  -- memory. IL2CPP: the collector gives no static data address, so it reads each field (8 raw bytes)
  local function rawValue(v, typename)
    local t = (typename or ''):gsub('^System%.', '')
    if v == nil then return '??' end
    if t == 'Boolean' then return tostring(v & 0xFF ~= 0) end
    if t == 'Byte' then return tostring(v & 0xFF) end
    if t == 'SByte' then return tostring(string.unpack('<i1', string.pack('<I1', v & 0xFF))) end
    if t == 'Int16' then return tostring(string.unpack('<i2', string.pack('<I2', v & 0xFFFF))) end
    if t == 'UInt16' or t == 'Char' then return tostring(v & 0xFFFF) end
    if t == 'Int32' then return tostring(string.unpack('<i4', string.pack('<I4', v & 0xFFFFFFFF))) end
    if t == 'UInt32' then return tostring(v & 0xFFFFFFFF) end
    if t == 'Int64' then return tostring(v) end
    if t == 'UInt64' then return string.format('%u', v) end
    if t == 'Single' then return string.format('%.9g', string.unpack('<f', string.pack('<I4', v & 0xFFFFFFFF))) end
    if t == 'Double' then return string.format('%.17g', string.unpack('<d', string.pack('<i8', v))) end
    return string.format('0x%X', v)
  end
  local staticBase
  local function staticValue(klass, field)
    if mono_isil2cpp() then return rawValue(mono_getStaticFieldValue(klass, field.field), field.typename) end
    if staticBase == nil then staticBase = mono_class_getStaticFieldAddress(0, klass) or false end
    if not staticBase then return '?? (no static data: class not initialized yet?)' end
    return readValue(staticBase + field.offset, field)
  end
`);

/** Lua: resolve `className` (and `asm`) into local `klass`, or report and return. */
function classLookup(className: string, assembly: string): LuaCode {
  return lua`
    local klass, why = findClass(${className}, ${assembly})
    if not klass then _mcp_str = 'Error: ' .. why return end`;
}

export const monoTools = [
  defineTool({
    name: 'ce_mono_init',
    description: `Start CE's Mono data collector in the game (Mono and IL2CPP Unity games). Required by the other ce_mono_* tools.

Injects CE's collector DLL into the game (can take 10-60 s). Use when you know class/field names (from ILSpy/dnSpy/Il2CppDumper);
for finding a value without knowing the structure, ce_scan_value is simpler.`,
    schema: {},
    writes: true,
    dangerous: true,
    requiresProcess: true,
    async run(_args, ctx) {
      const text = await ctx.run(
        lua`
          if not (mono_isValid and mono_isValid()) then
            local ok, err = pcall(LaunchMonoDataCollector)
            if not ok then _mcp_str = 'Error: the Mono data collector failed to start: ' .. tostring(err) return end
          end
          if not mono_isValid() then _mcp_str = 'Error: the collector started but found no Mono/IL2CPP runtime (not a .NET/Unity game?)' return end
          _mcp_str = string.format('Mono data collector ready (%s), %d assemblies loaded', mono_isil2cpp() and 'IL2CPP' or 'Mono',
            #(mono_enumAssemblies() or {}))`,
        { timeoutMs: 180_000 },
      );
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_mono_assemblies',
    description: 'List the .NET assemblies loaded in the game (paginated).',
    schema: pageSchema(100),
    writes: false,
    requiresProcess: true,
    async run(page, ctx) {
      const collect = lua`
        ${MONO_HELPERS}
        for _, a in ipairs(mono_enumAssemblies() or {}) do items[#items + 1] = mono_image_get_name(mono_getImageFromAssembly(a)) end`;
      return (await ctx.run(listBody(collect, 'assemblies', page), { timeoutMs: 60_000 })) ?? 'No assemblies';
    },
  }),

  defineTool({
    name: 'ce_mono_classes',
    description: 'List the classes of an assembly (paginated, filter on "Namespace.Class").',
    schema: {
      assembly: z.string().default('Assembly-CSharp').describe('Assembly name (".dll" optional); the game code is usually Assembly-CSharp'),
      ...pageSchema(100),
    },
    writes: false,
    requiresProcess: true,
    async run({ assembly, ...page }, ctx) {
      const collect = lua`
        ${MONO_HELPERS}
        local img = findImage(${assembly})
        if not img then _mcp_str = 'Error: no assembly named ' .. ${assembly} .. ' (see ce_mono_assemblies)' return end
        for _, c in ipairs(mono_image_enumClasses(img) or {}) do
          local ns = c.namespace or ''
          items[#items + 1] = ns ~= '' and (ns .. '.' .. c.classname) or c.classname
        end
        table.sort(items)`;
      return (await ctx.run(listBody(collect, 'classes', page), { timeoutMs: 120_000 })) ?? 'No classes';
    },
  }),

  defineTool({
    name: 'ce_mono_fields',
    description: 'List the fields of a class (inherited ones included): offset, type, name, static/const.',
    schema: { class_name: classArg, assembly: assemblyArg },
    writes: false,
    requiresProcess: true,
    async run({ class_name, assembly }, ctx) {
      const text = await ctx.run(
        lua`
          ${MONO_HELPERS}
          ${classLookup(class_name, assembly)}
          local fields = fieldsOf(klass)
          local out = { string.format('=== Fields of %s (%d) ===', ${class_name}, #fields) }
          for _, f in ipairs(fields) do
            out[#out + 1] = string.format('+0x%X: %s %s%s%s', f.offset or 0, f.typename or '?', f.name or '?',
              f.isStatic and ' [static]' or '', f.isConst and ' [const]' or '')
          end
          _mcp_str = table.concat(out, '\n')`,
        { timeoutMs: 60_000 },
      );
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_mono_methods',
    description: 'List the methods of a class with their signatures (paginated).',
    schema: { class_name: classArg, assembly: assemblyArg, ...pageSchema(100) },
    writes: false,
    requiresProcess: true,
    async run({ class_name, assembly, ...page }, ctx) {
      const collect = lua`
        ${MONO_HELPERS}
        ${classLookup(class_name, assembly)}
        for _, m in ipairs(mono_class_enumMethods(klass) or {}) do
          local sig = mono_method_getSignature and select(1, mono_method_getSignature(m.method)) or nil
          items[#items + 1] = m.name .. (sig and ('(' .. sig .. ')') or '')
        end`;
      return (await ctx.run(listBody(collect, 'methods', page), { timeoutMs: 60_000 })) ?? 'No methods';
    },
  }),

  defineTool({
    name: 'ce_mono_read_field',
    description: 'Read a field of an object (instance_address from ce_mono_find_instances, or a static field) with its real .NET type.',
    schema: {
      class_name: classArg,
      field_name: z.string().describe('Field name'),
      instance_address: z.string().default('').describe('Object address (not needed for a static field)'),
      assembly: assemblyArg,
    },
    writes: false,
    requiresProcess: true,
    dangerous: ({ instance_address }) => instance_address === '',
    async run({ class_name, field_name, instance_address, assembly }, ctx) {
      const text = await ctx.run(
        lua`
          ${MONO_HELPERS}
          ${classLookup(class_name, assembly)}
          local field
          for _, f in ipairs(fieldsOf(klass)) do if f.name == ${field_name} then field = f end end
          if not field then _mcp_str = 'Error: no field ' .. ${field_name} .. ' in ' .. ${class_name} .. ' (see ce_mono_fields)' return end
          if field.isStatic then
            _mcp_str = string.format('%s.%s (%s, static) = %s', ${class_name}, field.name, field.typename or '?', staticValue(klass, field))
            return
          end
          if ${instance_address} == '' then _mcp_str = 'Error: ' .. ${field_name} .. ' is an instance field: give instance_address' return end
          local base = getAddressSafe(${instance_address})
          if not base then _mcp_str = 'Error: invalid address: ' .. ${instance_address} return end
          local address = base + field.offset
          _mcp_str = string.format('%s.%s (%s) at 0x%X = %s', ${class_name}, field.name, field.typename or '?', address, readValue(address, field))`,
        { timeoutMs: 60_000 },
      );
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_mono_static',
    description: `Read the static fields of a class (singletons like Player.Instance, game managers): one call to the collector for the static data address, then plain memory reads.`,
    schema: {
      class_name: classArg,
      field_name: z.string().default('').describe('Only this static field (default: all of them)'),
      assembly: assemblyArg,
    },
    writes: false,
    dangerous: true,
    requiresProcess: true,
    async run({ class_name, field_name, assembly }, ctx) {
      const text = await ctx.run(
        lua`
          ${MONO_HELPERS}
          ${classLookup(class_name, assembly)}
          local out = { string.format('=== Static fields of %s ===', ${class_name}) }
          for _, f in ipairs(fieldsOf(klass)) do
            if f.isStatic and not f.isConst and (${field_name} == '' or f.name == ${field_name}) then
              out[#out + 1] = string.format('%s %s = %s', f.typename or '?', f.name, staticValue(klass, f))
            end
          end
          if #out == 1 then out[2] = ${field_name} ~= '' and ('No static field ' .. ${field_name}) or '(no static fields)' end
          _mcp_str = table.concat(out, '\n')`,
        { timeoutMs: 60_000 },
      );
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_mono_dump',
    description: 'Every field of an object with its value (instance fields; static fields too with include_statics).',
    schema: {
      class_name: classArg,
      instance_address: z.string().describe('Object address (from ce_mono_find_instances or a pointer)'),
      include_statics: z.boolean().default(false).describe('Also read the static fields (one collector call)'),
      assembly: assemblyArg,
    },
    writes: false,
    dangerous: ({ include_statics }) => include_statics,
    requiresProcess: true,
    async run({ class_name, instance_address, include_statics, assembly }, ctx) {
      const text = await ctx.run(
        lua`
          ${MONO_HELPERS}
          ${classLookup(class_name, assembly)}
          local obj = getAddressSafe(${instance_address})
          if not obj then _mcp_str = 'Error: invalid address: ' .. ${instance_address} return end
          local out = { string.format('=== %s at 0x%X ===', ${class_name}, obj) }
          for _, f in ipairs(fieldsOf(klass)) do
            if not f.isStatic then
              out[#out + 1] = string.format('+0x%X %s %s = %s', f.offset, f.typename or '?', f.name, readValue(obj + f.offset, f))
            elseif ${include_statics} and not f.isConst then
              out[#out + 1] = string.format('static %s %s = %s', f.typename or '?', f.name, staticValue(klass, f))
            end
          end
          _mcp_str = table.concat(out, '\n')`,
        { timeoutMs: 60_000 },
      );
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_mono_find_instances',
    description: `Find the objects of a class in memory: a read-only memory scan for the class's vtable pointer (every object starts with it), never a walk of the managed heap. Runs in the background with a progress window.

Recently freed objects can still match until the GC reuses their memory: check a result with ce_mono_dump.`,
    schema: {
      class_name: classArg,
      assembly: assemblyArg,
      max_results: z.number().int().min(1).max(1000).default(20).describe('Maximum number of objects listed'),
      unfiltered: z.boolean().default(false).describe('List every match of the class pointer, without checking that it is an object'),
      ...waitSchema,
    },
    writes: false,
    dangerous: true,
    requiresProcess: true,
    async run({ class_name, assembly, max_results, unfiltered, wait }, ctx) {
      const kind = `find ${class_name} instances`;
      return runJob(
        ctx,
        kind,
        lua`(function()
          ${MONO_HELPERS}
          ${classLookup(class_name, assembly)}
          local vtable = mono_isil2cpp() and klass or mono_class_getVTable(klass)
          if not vtable or vtable == 0 then _mcp_str = 'Error: no vtable for ' .. ${class_name} .. ' (no object created yet?)' return end
          local ms = createMemScan()
          ms.VarType = 'vtQword'
          ms.ScanOption = 'soExactValue'
          ms.Hexadecimal = true
          ms.Scanvalue1 = string.format('%X', vtable)
          ms.Startaddress = 0
          ms.Stopaddress = 0x7FFFFFFFFFFFFFFF
          ms.ScanWritable = 'scanInclude'
          ms.ScanExecutable = 'scanDontCare'
          ms.ScanCopyOnWrite = 'scanExclude'
          ms.Fastscanmethod = 'fsmAligned'
          ms.Fastscanparameter = '8'
          ms.firstScan()
          return {
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
              local err = ms.ErrorString
              if err and err ~= '' then ms.destroy() error('scan error: ' .. err, 0) end
              local matches = ms.Results or {}
              ms.destroy()
              -- The pointer also appears in runtime metadata (e.g. every MethodInfo of the class holds
              -- it). A real object has a null monitor word after it, and each reference field is null
              -- or points to an object that starts with a readable class pointer.
              local refs = {}
              for _, f in ipairs(fieldsOf(klass)) do
                if not f.isStatic and REF_TYPES[f.monotype] then refs[#refs + 1] = f.offset end
              end
              local function plausible(a)
                if readPointer(a + 8) ~= 0 then return false end
                for _, off in ipairs(refs) do
                  local p = readPointer(a + off)
                  if p == nil then return false end
                  if p ~= 0 then
                    local k2 = readPointer(p)
                    if not k2 or k2 == 0 or not readPointer(k2) then return false end
                  end
                end
                return true
              end
              local objects = {}
              for _, a in ipairs(matches) do if ${unfiltered} or plausible(a) then objects[#objects + 1] = a end end
              local out = { string.format('%d object(s) of %s (class pointer 0x%X found %d times%s)', #objects, ${class_name}, vtable,
                #matches, ${unfiltered} and ', unfiltered' or (', ' .. (#matches - #objects) .. ' discarded as not objects')) }
              for i = 1, math.min(#objects, ${max_results}) do out[#out + 1] = string.format('  0x%X', objects[i]) end
              if #objects > ${max_results} then out[#out + 1] = string.format('  ... %d more (raise max_results)', #objects - ${max_results}) end
              return table.concat(out, '\n')
            end,
          }
        end)()`,
        wait,
      );
    },
  }),
];
