/**
 * Long operations as CE jobs (see _mcp.startJob in src/lua/prelude.lua): CE's main thread stays
 * free, CE shows a progress window, and the tool either waits (polling with short calls, giving
 * CE back to other tool calls in between) or returns a job id at once.
 */

import { z } from 'zod';
import { lua, type LuaCode } from '../lua/lit.js';
import { defineTool, type ToolContext } from './registry.js';

const POLL_MS = 250;
/** A waiting call returns after this; the job keeps running and ce_job_status reads it later. */
const MAX_WAIT_MS = 10 * 60_000;

export const waitSchema = {
  wait: z
    .boolean()
    .default(true)
    .describe('Wait for the result (default). false returns a job id at once: read it later with ce_job_status'),
};

interface JobLine {
  status: string;
  done: number;
  total: number;
  message: string;
}

function parseLine(line: string | null): JobLine {
  const [status = 'missing', done = '0', total = '0', ...message] = (line ?? '').split('|');
  return { status, done: Number(done), total: Number(total), message: message.join('|') };
}

async function jobLine(ctx: ToolContext, id: number): Promise<JobLine> {
  return parseLine(await ctx.scope.run(lua`_mcp_str = _mcp.jobLine(${id})`));
}

/** Read a finished job's result (truncated like any output) and forget the job. */
async function takeResult(ctx: ToolContext, id: number, line: JobLine): Promise<string> {
  if (line.status === 'error') {
    await ctx.scope.run(lua`_mcp.jobs[${id}] = nil`);
    return `Error: job ${id} failed: ${line.message}`;
  }
  if (line.status === 'cancelled') {
    await ctx.scope.run(lua`_mcp.jobs[${id}] = nil`);
    return `Job ${id} was cancelled`;
  }
  const text = await ctx.scope.run(lua`local job = _mcp.jobs[${id}] _mcp_str = job and job.result _mcp.jobs[${id}] = nil`);
  return text ?? '(no result)';
}

async function waitForJob(ctx: ToolContext, id: number, kind: string): Promise<string> {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const line = await jobLine(ctx, id);
    if (line.status === 'missing') return `Error: job ${id} no longer exists (CE was restarted?)`;
    if (line.status === 'done' || line.status === 'error' || line.status === 'cancelled') return takeResult(ctx, id, line);
    await ctx.progress(line.done, line.total || undefined, line.message || `${kind}...`);
    if (ctx.signal.aborted) {
      await ctx.scope.run(lua`_mcp.cancelJob(${id})`);
      return `Job ${id} cancelled: the request was aborted`;
    }
    if (Date.now() > deadline) {
      return `Job ${id} (${kind}) is still running in CE (${line.message || 'no progress information'}). Call ce_job_status(job_id=${id}) later.`;
    }
    await ctx.scope.pause(POLL_MS);
  }
}

/**
 * Start a job. `spec` is a Lua expression giving the table for _mcp.startJob (kind, run, update,
 * finish, window), or nil after setting _mcp_str to report why it cannot start. The start goes
 * through the tool's gates like any other CE call.
 */
export async function runJob(ctx: ToolContext, kind: string, spec: LuaCode, wait: boolean): Promise<string> {
  const started = await ctx.run(lua`
    local spec = ${spec}
    if spec then _mcp_str = tostring(_mcp.startJob(spec).id) end`);
  const id = Number(started);
  if (!started || !Number.isInteger(id)) return started ?? 'Error: the job did not start';
  if (!wait) return `Job ${id} started (${kind}). Call ce_job_status(job_id=${id}) to get its progress and result.`;
  return waitForJob(ctx, id, kind);
}

export const jobTools = [
  defineTool({
    name: 'ce_job_status',
    antiCheatExempt: true,
    description: 'Progress or result of a CE job started with wait=false (or one that outlived its call). Returns the result once done.',
    schema: {
      job_id: z.number().int().min(1).describe('Job id given when the job started'),
      wait: z.boolean().default(false).describe('Wait until the job finishes'),
    },
    writes: false,
    async run({ job_id, wait }, ctx) {
      const line = await jobLine(ctx, job_id);
      if (line.status === 'missing') return `Error: no job ${job_id} (finished jobs are forgotten once their result is read)`;
      if (line.status === 'running' || line.status === 'finishing') {
        if (wait) return waitForJob(ctx, job_id, `job ${job_id}`);
        const progress = line.total ? ` ${Math.floor((100 * line.done) / line.total)}%` : '';
        return `Job ${job_id}: running${progress}${line.message ? ` - ${line.message}` : ''}`;
      }
      return takeResult(ctx, job_id, line);
    },
  }),

  defineTool({
    name: 'ce_job_cancel',
    antiCheatExempt: true,
    description: 'Cancel a running CE job (the user can also press Cancel in its progress window in CE).',
    schema: {
      job_id: z.number().int().min(1).describe('Job id'),
    },
    writes: false,
    async run({ job_id }, ctx) {
      const text = await ctx.run(lua`
        local job = _mcp.cancelJob(${job_id})
        if not job then _mcp_str = 'Error: no job ' .. ${job_id} return end
        _mcp_str = string.format('Job %d: %s', job.id, job.cancelled and 'cancellation requested' or job.status)`);
      return text ?? 'Error: no answer from Cheat Engine';
    },
  }),

  defineTool({
    name: 'ce_job_list',
    antiCheatExempt: true,
    description: 'List the CE jobs that are running or whose result has not been read yet.',
    schema: {},
    writes: false,
    async run(_args, ctx) {
      const text = await ctx.run(lua`
        local lines = {}
        for id, job in pairs(_mcp.jobs) do
          _mcp.stepJob(job)
          lines[#lines + 1] = string.format('%d: %s - %s%s (%ds)', id, job.kind, job.status,
            job.total and job.total > 0 and string.format(' %d%%', math.floor(100 * job.done / job.total)) or '',
            os.time() - job.started)
        end
        table.sort(lines)
        _mcp_str = #lines > 0 and table.concat(lines, '\n') or 'No jobs'`);
      return text ?? 'No jobs';
    },
  }),
];
