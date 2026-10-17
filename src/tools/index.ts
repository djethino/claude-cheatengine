import type { ToolDef } from './registry.js';
import { coreTools } from './core.js';

export const allTools: ToolDef[] = [...coreTools];

const names = new Set<string>();
for (const tool of allTools) {
  if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
  names.add(tool.name);
}
