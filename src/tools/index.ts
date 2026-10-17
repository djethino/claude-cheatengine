import type { ToolDef } from './registry.js';
import { coreTools } from './core.js';
import { memoryTools } from './memory.js';
import { jobTools } from './jobs.js';
import { scanTools } from './scan.js';
import { tableTools } from './table.js';

export const allTools: ToolDef[] = [...coreTools, ...memoryTools, ...scanTools, ...tableTools, ...jobTools];

const names = new Set<string>();
for (const tool of allTools) {
  if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
  names.add(tool.name);
}
