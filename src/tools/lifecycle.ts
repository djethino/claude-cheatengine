/**
 * Cheat Engine itself: its dialogs (seen from outside CE, see src/ce/dialogs.ts), starting it and
 * restarting it (to load an updated plugin script, or after CE got stuck).
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { lua } from '../lua/lit.js';
import { defineTool, type ToolContext } from './registry.js';
import { CEPipeError } from '../ce/pipe.js';
import { closeInformationDialog, describeDialogs, listDialogs } from '../ce/dialogs.js';
import { findCeDirs, loaderStatus } from '../install.js';
import { ceProcesses } from '../win/helper.js';

const LAUNCH_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 30_000;

/** PID of the CE answering on the pipe, or the reason it does not answer. */
async function answering(ctx: ToolContext): Promise<number | string> {
  try {
    return Number(await ctx.scope.runInt(lua`return getCheatEngineProcessID()`, 3000));
  } catch (err) {
    if (err instanceof CEPipeError) return err.message;
    throw err;
  }
}

/** Start Cheat Engine and wait until its MCP plugin answers. */
async function launch(ctx: ToolContext): Promise<string> {
  const dirs = (await findCeDirs()).filter((dir) => existsSync(join(dir, 'Cheat Engine.exe')));
  if (!dirs.length) return 'Error: Cheat Engine not found (registry, Program Files): install it from https://www.cheatengine.org';
  // The installation whose autorun loads the plugin
  const dir = dirs.find((d) => loaderStatus(d) === 'loader installed') ?? dirs[0];
  const child = spawn(join(dir, 'Cheat Engine.exe'), [], { cwd: dir, detached: true, stdio: 'ignore' });
  const started = await new Promise<string | null>((resolve) => {
    child.once('spawn', () => resolve(null));
    child.once('error', (err) => resolve(err.message));
  });
  if (started) return `Error: cannot start ${join(dir, 'Cheat Engine.exe')}: ${started}`;
  child.unref();
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  let reason = '';
  while (Date.now() < deadline) {
    await ctx.scope.pause(1000);
    const pid = await answering(ctx);
    if (typeof pid === 'number') return `Cheat Engine started from ${dir} (PID ${pid}); its MCP plugin answers (SAFE mode, nothing attached)`;
    reason = pid;
    await ctx.progress(Date.now() - (deadline - LAUNCH_TIMEOUT_MS), LAUNCH_TIMEOUT_MS, 'waiting for Cheat Engine to start');
  }
  return `Error: Cheat Engine was started from ${dir} but its MCP plugin did not answer within ${LAUNCH_TIMEOUT_MS / 1000} s (${reason}). A dialog may be open in it, or the plugin is not loaded (ce_status).`;
}

export const lifecycleTools = [
  defineTool({
    name: 'ce_dialogs',
    antiCheatExempt: true,
    outsideCE: true,
    description: `Show the dialogs open in Cheat Engine (they block every other call until answered), with an image of the first one: its text is only readable there.

A dialog with one button only informs: close it with ce_dialog_close once read. One with a choice (Yes/No...) is the user's decision: tell them, never answer it.`,
    schema: {},
    writes: false,
    async run(_args, ctx) {
      const dialogs = await listDialogs(ctx.cePid(), true);
      if (!dialogs.length) return 'No dialog is open in Cheat Engine';
      const text = `${dialogs.length} dialog(s) open in Cheat Engine (image: the first one)\n${dialogs.map((d) => `id ${d.id}: ${describeDialogs([d])}`).join('\n')}`;
      const image = dialogs[0].image;
      return image ? { text, image: { data: image, mimeType: 'image/png' } } : text;
    },
  }),

  defineTool({
    name: 'ce_dialog_close',
    antiCheatExempt: true,
    outsideCE: true,
    description: 'Close an information dialog of Cheat Engine (one button: an error, a notice) after reading it with ce_dialogs. Refuses dialogs that ask a question: only the user answers those.',
    schema: {
      id: z.string().regex(/^\d+$/).describe('Dialog id, as given by ce_dialogs'),
    },
    writes: false,
    async run({ id }, ctx) {
      return closeInformationDialog(ctx.cePid(), id);
    },
  }),

  defineTool({
    name: 'ce_launch',
    antiCheatExempt: true,
    description: 'Start Cheat Engine (when it is not running) and wait until its MCP plugin answers.',
    schema: {},
    writes: false,
    async run(_args, ctx) {
      const pid = await answering(ctx);
      if (typeof pid === 'number') return `Cheat Engine is already running and answering (PID ${pid})`;
      const running = await ceProcesses();
      if (running.length) {
        return `Error: Cheat Engine is running (PID ${running.join(', ')}) but does not answer (${pid}). A dialog may be open in it (ce_dialogs), its MCP status label may say OFF (another Cheat Engine serves Claude Code, or the server was stopped in the MCP menu), or the plugin is not loaded (ce_status).`;
      }
      return launch(ctx);
    },
  }),

  defineTool({
    name: 'ce_restart',
    antiCheatExempt: true,
    description: `Restart Cheat Engine, e.g. when ce_status says it runs an older copy of the plugin script.

When the address list has entries or a job runs, the user confirms in a dialog in Cheat Engine (what would be lost is listed). Enabled scripts are disabled first, which restores the game's code; frozen values are released. CE comes back in SAFE mode with nothing attached.`,
    schema: {},
    writes: false,
    async run(_args, ctx) {
      const reply = await ctx.run(
        lua`
          local al = getAddressList()
          local entries, frozen, scripts = al.Count, 0, 0
          for i = 0, al.Count - 1 do
            local mr = al.getMemoryRecord(i)
            if mr.Active then if mr.Script then scripts = scripts + 1 else frozen = frozen + 1 end end
          end
          local jobs = 0
          for _, job in pairs(_mcp.jobs) do if job.status == 'running' or job.status == 'finishing' then jobs = jobs + 1 end end
          if entries > 0 or jobs > 0 then
            local lost = {}
            if entries > 0 then lost[#lost + 1] = string.format('- the address list (%d entries) unless you saved it', entries) end
            if scripts > 0 then lost[#lost + 1] = string.format('- %d enabled script(s): disabled first, restoring the game\'s code', scripts) end
            if frozen > 0 then lost[#lost + 1] = string.format('- %d frozen value(s): released', frozen) end
            if jobs > 0 then lost[#lost + 1] = string.format('- %d running job(s): cancelled', jobs) end
            local answer = messageDialog('CE MCP - restart request',
              'Claude Code asks to restart Cheat Engine. This ends:\n' .. table.concat(lost, '\n') .. '\n\nRestart now?', mtWarning, mbYes, mbNo)
            if answer ~= mrYes then _mcp_str = 'BLOCKED: the user declined the restart in Cheat Engine' return end
          end
          for _, job in pairs(_mcp.jobs) do _mcp.cancelJob(job.id) end
          -- Scripts last enabled first: disable in reverse order
          for i = al.Count - 1, 0, -1 do
            local mr = al.getMemoryRecord(i)
            if mr.Active then
              mr.Active = false
              if mr.Active then _mcp_str = 'Error: could not disable "' .. mr.Description .. '" (see the CE window): restart cancelled' return end
            end
          end
          -- Close once this answer is on its way
          local t = createTimer()
          t.Interval = 300
          t.OnTimer = function(timer) timer.Enabled = false closeCE() end
          _mcp_str = 'closing'`,
        { timeoutMs: 180_000, asksUser: true },
      );
      if (reply !== 'closing') return reply ?? 'Error: no answer from Cheat Engine';
      // The CE that answered (known since this call connected); wait for it to end. A question it
      // asks while closing is the user's
      const closing = ctx.cePid();
      if (!closing) return 'Error: Cheat Engine is closing but its process is unknown: start it again with ce_launch once it is closed';
      const deadline = Date.now() + EXIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await ctx.scope.pause(500);
        if (!(await ceProcesses()).includes(closing)) return launch(ctx);
        const dialogs = await listDialogs(closing);
        if (dialogs.length) return `Cheat Engine did not close yet:\n${describeDialogs(dialogs)}\nOnce it is closed, start it again with ce_launch.`;
      }
      return `Error: Cheat Engine did not exit within ${EXIT_TIMEOUT_MS / 1000} s. Check its window, then use ce_launch once it is closed.`;
    },
  }),
];
