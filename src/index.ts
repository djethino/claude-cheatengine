#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PIPE_PATH, Session } from './ce/session.js';
import { createServer } from './server.js';
import { allTools } from './tools/index.js';
import { logger } from './logger.js';

const session = new Session(PIPE_PATH, __CEMCP_VERSION__);
const server = createServer(session, allTools, __CEMCP_VERSION__);

process.on('SIGINT', () => {
  session.close();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
logger.info(`asymptomatik-cheatengine ${__CEMCP_VERSION__} ready (${allTools.length} tools)`);
