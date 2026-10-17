#!/usr/bin/env node

/**
 * Build the file Claude Code runs: dist/index.js (MCP server).
 *
 * Claude Code installs plugins from git and runs npm with --ignore-scripts, so dist/ is committed
 * and bundles every npm dependency and the Lua sources: the plugin needs no node_modules and no
 * native code at runtime.
 *
 * Type errors fail the build (esbuild strips types without checking them).
 */

import { execSync } from 'child_process';
import { readFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// package.json is the single source of the version; Claude Code reads plugin.json, which must match
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pluginVersion = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
if (pluginVersion !== version) {
  console.error(`Version mismatch: package.json ${version}, .claude-plugin/plugin.json ${pluginVersion}`);
  process.exit(1);
}

execSync('npx tsc --noEmit', { cwd: root, stdio: 'inherit' });

rmSync(join(root, 'dist'), { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: { index: 'src/index.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Readable output: this file is committed and debugged from users' stack traces
  minify: false,
  legalComments: 'inline',
  loader: { '.lua': 'text' },
  define: { __CEMCP_VERSION__: JSON.stringify(version) },
  // Bundled CommonJS dependencies call require(); ESM has none unless it is created
  banner: { js: "import { createRequire as __cemcpCreateRequire } from 'module';\nconst require = __cemcpCreateRequire(import.meta.url);" },
  logLevel: 'info',
});
