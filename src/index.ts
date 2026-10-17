#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PIPE_PATH, Session } from './ce/session.js';
import { createServer } from './server.js';
import { allTools } from './tools/index.js';
import { logger } from './logger.js';

const session = new Session(PIPE_PATH, __CEMCP_VERSION__);
const server = createServer(session, allTools, __CEMCP_VERSION__);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // A tool call stuck on CE must not keep the process alive: give the release 3 s at most
  await Promise.race([session.release(), new Promise((resolve) => setTimeout(resolve, 3000))]);
  process.exit(0);
}

// Claude Code closes stdin when the session ends; signals cover a terminal stop
process.stdin.on('end', () => void stop());
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

await server.connect(new StdioServerTransport());
logger.info(`asymptomatik-cheatengine ${__CEMCP_VERSION__} ready (${allTools.length} tools)`);
