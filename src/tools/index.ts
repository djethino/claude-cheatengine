import type { ToolDef } from './registry.js';
import { coreTools } from './core.js';
import { memoryTools } from './memory.js';

export const allTools: ToolDef[] = [...coreTools, ...memoryTools];

const names = new Set<string>();
for (const tool of allTools) {
  if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
  names.add(tool.name);
}
