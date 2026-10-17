/**
 * Debugger watchpoints, auto assembler code, speedhack.
 *
 * Code changes are auto assembler entries of CE's address list: CE runs their [ENABLE] and
 * [DISABLE] sections with its own disable information (allocations, symbols), so disabling really
 * restores the code (the Python version wrote 5 NOPs and its enable=False re-enabled the script).
 *
 * Watchpoints follow CE's AITools: hits are grouped by instruction with a count, and for access /
 * write watchpoints the reported instruction is the one before the instruction pointer (the CPU
 * reports the instruction after the one that touched the memory).
 */

import { z } from 'zod';
import { lua, raw } from '../lua/lit.js';
import { defineTool } from './registry.js';
import { resolveAddress } from './memory.js';

const watchId = z.number().int().min(1).describe('Watchpoint ID returned by ce_breakpoint');

/**
 * Lua: create an auto assembler record from local `script` after a syntax check of [ENABLE].
 * [DISABLE] cannot be checked alone: it runs without the allocations [ENABLE] made, so a valid
 * dealloc() fails with "Access violation" (CE 7.7); CE checks it when the entry is disabled.
 */
const CREATE_SCRIPT_RECORD = raw(`
  local ok, err = autoAssembleCheck(script, true, false)
  if not ok then _mcp_str = 'Error: [ENABLE] section: ' .. tostring(err) return end
  local mr = getAddressList().createMemoryRecord()
  mr.Description = description
  mr.VarType = 'vtAutoAssembler'
  mr.Script = script
  if active then mr.Active = true end
  local state = active and (mr.Active and 'enabled' or 'NOT enabled: CE refused it (see the CE window)') or 'disabled'
  _mcp_str = string.format('Auto assembler entry #%d "%s" created, %s. Toggle it with ce_record_activate(record=%d).', mr.ID, mr.Description, state, mr.ID)
  if active and not mr.Active then _mcp_str = 'Error: ' .. _mcp_str end`);

export const codeTools = [
  defineTool({
    name: 'ce_breakpoint',
    description: `Watch what accesses, writes or executes an address (CE's "find out what accesses this address"): every instruction that triggers it is recorded with a hit count, without pausing the game. Read them with ce_breakpoint_results.

Starts CE's debugger on the process if needed (some games detect debuggers).`,
    schema: {
      address: z.string().describe('Address to watch'),
      bp_type: z.enum(['access', 'write', 'execute']).default('access').describe('access = read or write; execute = when the code at the address runs'),
      size: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).default(4).describe('Bytes watched (ignored for execute)'),
    },
    writes: true,
    dangerous: true,
    requiresProcess: true,
    async run({ address, bp_type, size }, ctx) {
      const trigger = { access: 'bptAccess', write: 'bptWrite', execute: 'bptExecute' }[bp_type];
      const text = await ctx.run(lua`
        ${resolveAddress(address)}
        _mcp.watches = _mcp.watches or {}
        _mcp.nextWatch = (_mcp.nextWatch or 0) + 1
        local w = { id = _mcp.nextWatch, address = addr, kind = ${bp_type}, hits = {}, order = {}, total = 0 }
        local execute = ${bp_type === 'execute'}
        local ok, bpid = debug_setBreakpoint(addr, ${size}, ${raw(trigger)}, function()
          local ctxt = debug_getCurrentContextTable()
          if not ctxt then return 0 end
          local ip = targetIs64Bit() and ctxt.RIP or ctxt.EIP
          w.total = w.total + 1
          local hit = w.hits[ip]
          if hit then hit.count = hit.count + 1 return 0 end
          local actual = execute and ip or getPreviousOpcode(ip)
          hit = { count = 1, ip = actual, opcode = disassemble(actual), name = getNameFromAddress(actual) }
          local regs = {}
          for _, r in ipairs(targetIs64Bit() and { 'RAX', 'RBX', 'RCX', 'RDX', 'RSI', 'RDI', 'RBP', 'RSP' } or { 'EAX', 'EBX', 'ECX', 'EDX', 'ESI', 'EDI', 'EBP', 'ESP' }) do
            if ctxt[r] then regs[#regs + 1] = string.format('%s=%X', r, ctxt[r]) end
          end
          hit.regs = table.concat(regs, ' ')
          local start, stop = getFunctionRange(actual)
          if start then hit.func = string.format('%s - %s', getNameFromAddress(start), getNameFromAddress(stop)) end
          w.hits[ip] = hit
          w.order[#w.order + 1] = ip
          return 0
        end)
        if not ok then _mcp_str = 'Error: CE could not set the breakpoint: ' .. tostring(bpid) return end
        w.bpid = bpid
        _mcp.watches[w.id] = w
        _mcp_str = string.format('Watchpoint %d set on 0x%X (%s, %d bytes). Trigger it in the game, then call ce_breakpoint_results(id=%d).',
          w.id, addr, ${bp_type}, ${size}, w.id)`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_breakpoint_results',
    description: 'Instructions that triggered a watchpoint, with hit counts, registers at the first hit and the function range.',
    schema: {
      id: watchId.optional().describe('Watchpoint ID (default: every watchpoint)'),
    },
    writes: false,
    async run({ id }, ctx) {
      const text = await ctx.run(lua`
        local out = {}
        local ids = {}
        for wid in pairs(_mcp.watches or {}) do if ${id ?? 0} == 0 or wid == ${id ?? 0} then ids[#ids + 1] = wid end end
        table.sort(ids)
        if #ids == 0 then _mcp_str = ${id ? `Error: no watchpoint ${id}` : 'No watchpoints'} return end
        for _, wid in ipairs(ids) do
          local w = _mcp.watches[wid]
          out[#out + 1] = string.format('Watchpoint %d on 0x%X (%s)%s: %d hits from %d instructions', w.id, w.address, w.kind,
            w.removed and ' [removed]' or '', w.total, #w.order)
          for i, ip in ipairs(w.order) do
            local h = w.hits[ip]
            out[#out + 1] = string.format('  %d. %dx  %s  (%s)', i, h.count, h.opcode, h.name)
            out[#out + 1] = '     ' .. h.regs
            if h.func then out[#out + 1] = '     function: ' .. h.func end
          end
        end
        _mcp_str = table.concat(out, '\n')`);
      return text ?? 'No watchpoints';
    },
  }),

  defineTool({
    name: 'ce_breakpoint_remove',
    description: 'Remove a watchpoint (its results stay readable until removed again), or every watchpoint.',
    schema: {
      id: watchId.optional().describe('Watchpoint ID (default: all of them)'),
      forget: z.boolean().default(false).describe('Also delete the recorded results'),
    },
    writes: false,
    async run({ id, forget }, ctx) {
      const text = await ctx.run(lua`
        local count = 0
        for wid, w in pairs(_mcp.watches or {}) do
          if ${id ?? 0} == 0 or wid == ${id ?? 0} then
            if not w.removed then debug_removeBreakpointByID(w.bpid) w.removed = true end
            if ${forget} then _mcp.watches[wid] = nil end
            count = count + 1
          end
        end
        if count == 0 then _mcp_str = ${id ? `Error: no watchpoint ${id}` : 'No watchpoints'} return end
        _mcp_str = string.format('Removed %d watchpoint(s)%s', count, ${forget} and ' and their results' or '')`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_asm_inject',
    description: `Inject assembly code at an address: a jump to newly allocated code that runs asm_code, then the original instructions (unless keep_original is false), then jumps back.

Created as an auto assembler entry of the address list: disable it (ce_record_activate) to restore the original code. The script is syntax-checked first.`,
    schema: {
      address: z.string().describe("Address of the instruction to hook, e.g. 'game.exe+1A2B'"),
      asm_code: z.string().describe('Assembly to run (CE auto assembler syntax, x86/x64)'),
      description: z.string().default('').describe('Name of the address list entry'),
      keep_original: z.boolean().default(true).describe('Run the overwritten original instructions after asm_code'),
      active: z.boolean().default(true).describe('Enable it immediately'),
    },
    writes: true,
    dangerous: true,
    requiresProcess: true,
    async run({ address, asm_code, description, keep_original, active }, ctx) {
      const text = await ctx.run(lua`
        ${resolveAddress(address)}
        -- The jump needs 5 bytes: take whole instructions until at least 5 are covered
        local size, original = 0, {}
        while size < 5 do
          local _, _, opcode = splitDisassembledString(disassemble(addr + size))
          original[#original + 1] = opcode
          local n = getInstructionSize(addr + size)
          if not n or n == 0 then _mcp_str = string.format('Error: cannot disassemble at 0x%X', addr + size) return end
          size = size + n
        end
        local bytes = {}
        for i, b in ipairs(readBytes(addr, size, true)) do bytes[i] = string.format('%02X', b) end
        local target = string.format('%X', addr)
        local lines = {
          '[ENABLE]', 'alloc(cemcp_newmem, 2048, ' .. target .. ')', 'label(cemcp_return)', '', 'cemcp_newmem:', ${asm_code},
        }
        if ${keep_original} then
          lines[#lines + 1] = '// original code'
          for _, op in ipairs(original) do lines[#lines + 1] = op end
        end
        for _, l in ipairs({ 'jmp cemcp_return', '', target .. ':', 'jmp cemcp_newmem' }) do lines[#lines + 1] = l end
        if size > 5 then lines[#lines + 1] = 'nop ' .. (size - 5) end
        for _, l in ipairs({ 'cemcp_return:', '', '[DISABLE]', target .. ':', 'db ' .. table.concat(bytes, ' '), 'dealloc(cemcp_newmem)' }) do
          lines[#lines + 1] = l
        end
        local script = table.concat(lines, '\n')
        local description = ${description} ~= '' and ${description} or ('Injection at ' .. getNameFromAddress(addr))
        local active = ${active}
        ${CREATE_SCRIPT_RECORD}`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_asm_script',
    description: `Add a complete auto assembler script (with [ENABLE] and [DISABLE] sections) to the address list and enable it. The [ENABLE] section is syntax-checked first; check_only only reports the check.`,
    schema: {
      script: z.string().describe('Auto assembler script with [ENABLE] and [DISABLE] sections'),
      description: z.string().default('MCP script').describe('Name of the address list entry'),
      active: z.boolean().default(true).describe('Enable it immediately'),
      check_only: z.boolean().default(false).describe('Only check the syntax, add nothing'),
    },
    writes: ({ check_only }) => !check_only,
    dangerous: ({ check_only }) => !check_only,
    async run({ script, description, active, check_only }, ctx) {
      if (!/\[ENABLE\]/i.test(script) || !/\[DISABLE\]/i.test(script)) {
        return 'Error: the script needs an [ENABLE] and a [DISABLE] section (the [DISABLE] section restores what [ENABLE] changed)';
      }
      const text = await ctx.run(
        check_only
          ? lua`
            local ok, err = autoAssembleCheck(${script}, true, false)
            _mcp_str = ok and 'Syntax OK ([ENABLE] section; [DISABLE] is checked by CE when the entry is disabled)'
              or ('Error: [ENABLE] section: ' .. tostring(err))`
          : lua`
            local script, description, active = ${script}, ${description}, ${active}
            ${CREATE_SCRIPT_RECORD}`,
      );
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_record_activate',
    description: 'Enable or disable an entry of the address list (an auto assembler script, or freeze/unfreeze a value), like its checkbox in CE.',
    schema: {
      record: z.number().int().min(0).describe('Record ID, as shown by ce_watch_list'),
      active: z.boolean().describe('true = enable / freeze, false = disable / unfreeze'),
    },
    writes: ({ active }) => active,
    requiresProcess: true,
    async run({ record, active }, ctx) {
      const text = await ctx.run(lua`
        local mr = getAddressList().getMemoryRecordByID(${record})
        if not mr then _mcp_str = 'Error: no record with ID ' .. ${record} .. ' (see ce_watch_list)' return end
        mr.Active = ${active}
        if mr.Active ~= ${active} then
          _mcp_str = string.format('Error: CE could not %s record #%d "%s" (see the CE window)', ${active ? 'enable' : 'disable'}, mr.ID, mr.Description)
          return
        end
        _mcp_str = string.format('Record #%d "%s" %s', mr.ID, mr.Description, ${active ? 'enabled' : 'disabled'})`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_speedhack',
    description: "Set the game's speed with CE's speedhack (injects CE's speedhack DLL). 1.0 = normal, 2.0 = double, 0.5 = half.",
    schema: {
      speed: z.number().min(0.01).max(100).describe('Speed multiplier; 1.0 restores normal speed'),
    },
    writes: true,
    dangerous: true,
    requiresProcess: true,
    async run({ speed }, ctx) {
      const text = await ctx.run(lua`
        local ok, err = pcall(speedhack_setSpeed, ${speed})
        if not ok then _mcp_str = 'Error: speedhack failed: ' .. tostring(err) return end
        _mcp_str = string.format('Speedhack set to %.2fx (now %.2fx)', ${speed}, speedhack_getSpeed())`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),
];
