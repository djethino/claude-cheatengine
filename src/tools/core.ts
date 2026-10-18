/**
 * Connection, logs, continuation of truncated outputs, SAFE mode and raw Lua.
 */

import { z } from 'zod';
import { lua } from '../lua/lit.js';
import { MAX_OUTPUT_BYTES, DEFAULT_MAX_BYTES } from '../ce/session.js';
import { defineTool } from './registry.js';
import { readOnly } from '../options.js';
import { CEPipeError } from '../ce/pipe.js';
import { installState } from './install.js';
import { pluginScriptHash } from '../install.js';
import { ceProcesses } from '../win/helper.js';

/** Several running Cheat Engines: only one serves Claude Code (the others stay off). */
async function instancesWarning(): Promise<string> {
  const pids = await ceProcesses();
  if (pids.length < 2) return '';
  return `Warning: ${pids.length} Cheat Engines are running (PIDs ${pids.join(', ')}): only one serves Claude Code (its MCP status label is not OFF). Make sure the user works in that one, or ask them to close the others.`;
}

export const coreTools = [
  defineTool({
    name: 'ce_status',
    antiCheatExempt: true,
    description:
      'Check if Cheat Engine is connected and responding, the SAFE mode state, and whether the CE plugin is installed.',
    schema: {
      take_over: z
        .boolean()
        .default(false)
        .describe('Take Cheat Engine over from another Claude Code session that is using it (only when ce_status or another tool reported it)'),
    },
    writes: false,
    async run({ take_over }, ctx) {
      let connection: string;
      try {
        if (take_over) await ctx.scope.takeOver();
        const reply =
          (await ctx.run(lua`
            _mcp_str = string.format('%s\nConnected: %s - CE %s (PID: %d) [%s]', CEMCP and tostring(CEMCP.scriptHash) or 'none',
              _VERSION, tostring(getCEVersion()), getOpenedProcessID() or 0, _mcp_unsafe == true and 'unsafe' or 'safe')`)) ?? '';
        const [loadedHash, ...rest] = reply.split('\n');
        connection = rest.join('\n') || 'Error: no answer from Cheat Engine';
        if (loadedHash === 'none') {
          connection += '\nCE plugin not loaded in this Cheat Engine session (the pipe was opened another way): MCP menu and logs unavailable';
        } else if (loadedHash !== String(pluginScriptHash())) {
          connection += '\nCheat Engine runs an older copy of the plugin script: restart Cheat Engine to load the updated one';
        }
      } catch (err) {
        // Still report the install state: it tells why CE may not answer
        if (!(err instanceof CEPipeError)) throw err;
        connection = `Not connected: ${err.message}`;
      }
      return [connection, readOnly() ? 'Read-only mode: on (plugin option read_only)' : '', await instancesWarning(), await installState()]
        .filter(Boolean)
        .join('\n');
    },
  }),

  defineTool({
    name: 'ce_get_logs',
    antiCheatExempt: true,
    description: "Get the CE plugin's log of recent MCP commands (useful for debugging).",
    schema: {
      clear: z.boolean().default(false).describe('Clear the log buffer after reading'),
    },
    writes: false,
    async run({ clear }, ctx) {
      const text = await ctx.run(lua`
        if CEMCP_getLogs then
          _mcp_str = CEMCP_getLogs(${clear})
          if _mcp_str == '' then _mcp_str = '(no logs)' end
        else
          _mcp_str = 'Log buffer not available: the CE plugin is not loaded (run /ce-install, then restart CE)'
        end`);
      return text ?? '(no logs)';
    },
  }),

  defineTool({
    name: 'ce_output_more',
    antiCheatExempt: true,
    description: `Read the rest of the previous tool's output when it ended with a "[truncated: ...]" line.

Must be called right after the truncated call: calling any other tool discards it.
Every 10,000 bytes cost roughly 2,500 tokens of context: read only what is needed.`,
    schema: {
      offset: z.number().int().describe('Byte offset to resume from, as given in the "[truncated: ...]" line'),
      max_bytes: z
        .number()
        .int()
        .default(DEFAULT_MAX_BYTES)
        .describe(`Maximum number of bytes to return (1-${MAX_OUTPUT_BYTES})`),
    },
    writes: false,
    run({ offset, max_bytes }, ctx) {
      return ctx.scope.readMore(offset, max_bytes);
    },
  }),

  defineTool({
    name: 'ce_safety_status',
    antiCheatExempt: true,
    description: 'Check the current safety mode: SAFE (tools that can crash the game or CE are locked) or UNSAFE.',
    schema: {},
    writes: false,
    async run(_args, ctx) {
      const mode = await ctx.run(lua`
        _mcp_str = _mcp_unsafe == true and 'UNSAFE (crash-prone tools allowed)' or 'SAFE (crash-prone tools locked)'`);
      return `Security mode: ${mode}${readOnly() ? '\nRead-only mode: on (plugin option read_only): nothing may change the game' : ''}`;
    },
  }),

  defineTool({
    name: 'ce_safety_enable_writes',
    antiCheatExempt: true,
    description: `Enable UNSAFE mode: allows the tools that can crash the game or CE (ce_lua, code injection, breakpoints, DLL injection, .CT table loading, Mono heap access).

IMPORTANT: Do NOT call this tool unless the user explicitly requests it
(e.g., by running /unsafe-ce or explicitly asking to unlock these tools).
Never enable unsafe mode proactively or without clear user consent.`,
    schema: {
      confirm: z.string().default('').describe('Must be "USER_CONFIRMED" to enable. This is set by the /unsafe-ce command.'),
    },
    writes: false,
    async run({ confirm }, ctx) {
      if (confirm !== 'USER_CONFIRMED') return 'BLOCKED: Use the /unsafe-ce command to enable unsafe mode.';
      // The token only proves the skill ran: the unlock itself needs a click in Cheat Engine,
      // which Claude cannot do. The dialog is modal on CE's main thread, hence the long timeout.
      const text = await ctx.run(
        lua`
          if _mcp_unsafe == true then _mcp_str = 'UNSAFE mode is already on' return end
          local ac = (_mcp.ac or {})[getOpenedProcessID() or 0]
          local warning = (ac and ac ~= '') and ('\n\nANTI-CHEAT DETECTED in ' .. tostring(process) .. ': ' .. ac ..
            '.\nUsing Cheat Engine on this game can get your account banned.') or ''
          local answer = messageDialog('CE MCP - unlock request',
            'Claude Code asks to unlock the tools that can crash the game or Cheat Engine: Lua, code injection, ' ..
            'breakpoints, DLL injection (speedhack, D3D, Mono), .CT tables, Mono static and instance access.' .. warning ..
            '\n\nAllow it until Claude Code or Cheat Engine restarts?', mtWarning, mbYes, mbNo)
          if answer ~= mrYes then _mcp_str = 'BLOCKED: the user declined the unlock in Cheat Engine' return end
          _mcp_unsafe = true
          if updateMenuState then pcall(updateMenuState) end
          _mcp_str = 'UNSAFE mode enabled (confirmed by the user in Cheat Engine): crash-prone tools are now allowed until /safe-ce, or until Claude Code or CE restarts.'`,
        { timeoutMs: 180_000, asksUser: true },
      );
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_safety_disable_writes',
    antiCheatExempt: true,
    description: 'Re-enable SAFE mode: locks the tools that can crash the game or CE again.',
    schema: {},
    writes: false,
    async run(_args, ctx) {
      await ctx.run(lua`_mcp_unsafe = false if updateMenuState then pcall(updateMenuState) end`);
      return 'SAFE mode enabled: crash-prone tools are locked again.';
    },
  }),

  defineTool({
    name: 'ce_lua',
    description: `Execute arbitrary Lua code in Cheat Engine (advanced).

LAST RESORT: Only use when no dedicated tool exists for your operation.
Prefer: ce_scan_value, ce_read_memory, ce_write_memory, ce_mono_*, etc.

The code runs as a function body: \`return\` its result (numbers, strings, several values are tab-separated),
or assign a string to _mcp_str. Errors are reported as LUA_ERROR / LUA_SYNTAX_ERROR.

ERROR HANDLING:
- If this hangs or fails repeatedly, STOP and ask the user to check CE
- A dialog the code opens in CE blocks it: the call then reports the dialog (see ce_dialogs)
- Don't retry more than 2-3 times - report failure to user`,
    schema: {
      code: z.string().describe('Lua code to execute in Cheat Engine'),
    },
    writes: true,
    dangerous: true,
    async run({ code }, ctx) {
      const text = await ctx.run(lua`
        local f, e = load(${code}, '=ce_lua')
        if not f then _mcp_str = 'LUA_SYNTAX_ERROR: ' .. tostring(e) return end
        local r = table.pack(f())
        if _mcp_str == nil then
          local parts = {}
          for i = 1, r.n do parts[i] = tostring(r[i]) end
          _mcp_str = r.n == 0 and '(no return value)' or table.concat(parts, '\t')
        end
        _mcp_str = tostring(_mcp_str)
        if (getOpenedProcessID() or 0) == 0 then
          _mcp_str = _mcp_str .. '\n[NUDGE: No process attached - be careful with memory operations]'
        end`);
      return text ?? '(no return value)';
    },
  }),
];
