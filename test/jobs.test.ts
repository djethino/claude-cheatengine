import { test } from 'node:test';
import assert from 'node:assert/strict';
import { useHarness } from './harness.js';
import { defineTool } from '../src/tools/registry.js';
import { runJob, waitSchema } from '../src/tools/jobs.js';
import { lua } from '../src/lua/lit.js';
import { z } from 'zod';

// A job whose thread advances one step per pipe script (see the fake CE's threads)
const testJob = defineTool({
  name: 'test_job',
  description: 'test',
  schema: { ...waitSchema, steps: z.number().int().default(3), fail: z.boolean().default(false) },
  writes: false,
  run({ wait, steps, fail }, ctx) {
    return runJob(
      ctx,
      'test job',
      lua`{
        kind = 'test job', window = true,
        run = function(job)
          job.total = ${steps}
          for i = 1, ${steps} do
            if job.cancelled then return end
            if ${fail} and i == 2 then error('exploded') end
            job.done = i
            job.message = 'step ' .. i
            __fake.yield()
          end
        end,
        finish = function(job) return 'finished after ' .. job.done .. ' steps' end,
      }`,
      wait,
    );
  },
});

const h = useHarness({}, [testJob]);

test('waiting job: progress notifications, result, window closed, job forgotten', async () => {
  const progress: string[] = [];
  const { text } = await h.call('test_job', { steps: 3 }, (message) => progress.push(message));
  assert.equal(text, 'finished after 3 steps');
  assert.ok(progress.length >= 1, 'progress was reported');
  assert.ok(progress.every((m) => /^(step \d|test job\.\.\.)$/.test(m)), progress.join(', '));
  assert.equal(h.ce.eval('__fake.windows'), 0);
  assert.equal(h.ce.eval('next(_mcp.jobs) == nil'), true);
});

test('wait=false: job id at once, status while running, result read once', async () => {
  const started = (await h.call('test_job', { steps: 50, wait: false })).text;
  const id = Number(/^Job (\d+) started/.exec(started)?.[1]);
  assert.ok(id > 0, started);
  assert.match((await h.call('ce_job_status', { job_id: id })).text, new RegExp(`^Job ${id}: running \\d+% - step \\d+$`));
  assert.match((await h.call('ce_job_list')).text, new RegExp(`^${id}: test job - running`));
  assert.equal((await h.call('ce_job_status', { job_id: id, wait: true })).text, 'finished after 50 steps');
  assert.match((await h.call('ce_job_status', { job_id: id })).text, /^Error: no job/);
});

test('cancel: from the tool, the job stops and reports it', async () => {
  const id = Number(/^Job (\d+)/.exec((await h.call('test_job', { steps: 50, wait: false })).text)?.[1]);
  assert.equal((await h.call('ce_job_cancel', { job_id: id })).text, `Job ${id}: cancellation requested`);
  assert.equal((await h.call('ce_job_status', { job_id: id, wait: true })).text, `Job ${id} was cancelled`);
});

test('a failing job is an error with its message', async () => {
  const { text, isError } = await h.call('test_job', { fail: true });
  assert.match(text, /^Error: job \d+ failed: .*exploded/);
  assert.equal(isError, true);
});

test('other tools run while a job is waited for', async () => {
  const job = h.call('test_job', { steps: 30 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const status = await h.call('ce_status');
  assert.match(status.text, /^Connected/);
  assert.equal((await job).text, 'finished after 30 steps');
});
