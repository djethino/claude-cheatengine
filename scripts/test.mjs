#!/usr/bin/env node

/**
 * Bundle every test/*.test.ts with esbuild (same settings as the shipped build) and run them with
 * node --test. Tests run offline against a fake Cheat Engine (test/fake-ce.ts).
 */

import { execFileSync } from 'child_process';
import { readdirSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.test-build');
rmSync(out, { recursive: true, force: true });

const filter = process.argv[2];
const entries = readdirSync(join(root, 'test'))
  .filter((name) => name.endsWith('.test.ts') && (!filter || name.includes(filter)))
  .map((name) => join('test', name));

await build({
  absWorkingDir: root,
  entryPoints: entries,
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // wasmoon loads its .wasm file from its own package folder
  external: ['wasmoon'],
  loader: { '.lua': 'text' },
  define: { __CEMCP_VERSION__: JSON.stringify('test') },
  banner: { js: "import { createRequire as __cemcpCreateRequire } from 'module';\nconst require = __cemcpCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});

const files = readdirSync(out).filter((name) => name.endsWith('.mjs')).map((name) => join(out, name));
execFileSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
