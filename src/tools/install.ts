/**
 * /ce-install: the CE-side loader (see src/install.ts).
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { defineTool } from './registry.js';
import { describeInstall, findCeDirs, install } from '../install.js';

let syncError: string | null = null;

/** Startup failure of the per-user script sync, reported by ce_status. */
export function setSyncError(message: string): void {
  syncError = message;
}

export function installState(): Promise<string> {
  return describeInstall(syncError);
}

export const installTools = [
  defineTool({
    name: 'ce_install_plugin',
    description: `Install the CE-side plugin: a loader in Cheat Engine's autorun folder that runs the auto-updated plugin script. May show a Windows administrator prompt.

IMPORTANT: Do NOT call this tool unless the user explicitly requests it (e.g., by running /ce-install). It writes into the Cheat Engine install folder.`,
    schema: {
      confirm: z.string().default('').describe('Must be "USER_CONFIRMED". This is set by the /ce-install command.'),
      ce_dir: z.string().default('').describe('Cheat Engine install folder; detected from the registry when empty'),
    },
    writes: true,
    async run({ confirm, ce_dir }) {
      if (confirm !== 'USER_CONFIRMED') return 'BLOCKED: Use the /ce-install command to install the CE plugin.';
      let dirs: string[];
      if (ce_dir) {
        if (!existsSync(join(ce_dir, 'autorun'))) return `Error: ${ce_dir} has no autorun folder, is it a Cheat Engine install folder?`;
        dirs = [ce_dir];
      } else {
        dirs = await findCeDirs();
        if (!dirs.length) return 'Error: Cheat Engine install not found, pass its folder as ce_dir';
      }
      return install(dirs, process.argv[1]);
    },
  }),
];
