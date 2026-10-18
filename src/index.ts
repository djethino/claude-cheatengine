#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PIPE_PATH, Session } from './ce/session.js';
import { createServer } from './server.js';
import { allTools } from './tools/index.js';
import { syncUserScript, writeLoader } from './install.js';
import { setSyncError } from './tools/install.js';
import { logger } from './logger.js';
import { winHelper } from './win/helper.js';

// Elevated helper started by /ce-install (through a UAC prompt) when CE's folder is not writable
if (process.argv[2] === 'write-loader') {
  try {
    writeLoader(process.argv[3]);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  }
}

// Keep the per-user copy of the CE plugin in sync with this version; CE's autorun loader runs it
// at the next CE start
try {
  if (syncUserScript()) logger.info('CE plugin script updated (restart Cheat Engine to load it)');
} catch (err) {
  setSyncError((err as Error).message);
  logger.error('CE plugin script sync failed:', err);
}

const session = new Session(PIPE_PATH, __CEMCP_VERSION__);
const server = createServer(session, allTools, __CEMCP_VERSION__);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // A tool call stuck on CE must not keep the process alive: give the release 3 s at most
  await Promise.race([session.release(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  winHelper.stop();
  process.exit(0);
}

// Claude Code closes stdin when the session ends; signals cover a terminal stop
process.stdin.on('end', () => void stop());
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

await server.connect(new StdioServerTransport());
logger.info(`asymptomatik-cheatengine ${__CEMCP_VERSION__} ready (${allTools.length} tools)`);
