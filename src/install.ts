/**
 * Install the Cheat Engine side and keep it up to date.
 *
 * CE only auto-runs Lua files from <CE install dir>\autorun\. Copying the plugin there would need
 * admin rights on every update, so a small fixed loader is installed once instead. The loader runs
 * the real plugin from a per-user folder that the MCP server re-syncs on every start.
 *
 * Folder and loader are the same as the Python cheatengine-mcp's, byte for byte, so an existing
 * install keeps working without a new administrator prompt.
 *
 * Elevated step: `node dist/index.js write-loader <ce_dir>` (see index.ts), run through a UAC
 * prompt by PowerShell's Start-Process -Verb RunAs.
 */

import { execFile } from 'child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { promisify } from 'util';
import pluginScript from '../ce-plugin/ce-mcp-server.lua';
import { powershellPath } from './win/helper.js';

const run = promisify(execFile);

const USER_DIR = join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local'), 'cheatengine-mcp');
export const USER_SCRIPT = join(USER_DIR, 'ce-mcp-server.lua');

const LOADER_NAME = 'ce-mcp-loader.lua';
/** Name used by the former manual install (copy or symlink of the plugin itself). */
const LEGACY_NAME = 'ce-mcp-server.lua';
const LEGACY_MARKER = 'Cheat Engine MCP Server Plugin';

export const LOADER = `-- cheatengine-mcp loader, installed by /ce-install. Overwritten on reinstall.
-- Runs the CE-MCP plugin from the per-user copy kept up to date by the MCP server.
local path = os.getenv('LOCALAPPDATA') .. [[\\cheatengine-mcp\\ce-mcp-server.lua]]
local f = io.open(path, 'r')
if f then
  f:close()
  dofile(path)
else
  print('[CE-MCP] Plugin not found: ' .. path .. ' - start Claude Code with the cheatengine-mcp plugin, then restart CE')
end
`;

const ELEVATION_TIMEOUT_MS = 120_000;

function regPath(): string {
  return join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'reg.exe');
}

/** Values of one registry key, or {} when it cannot be read. */
async function regValues(key: string, view: '/reg:64' | '/reg:32'): Promise<Record<string, string>> {
  try {
    const { stdout } = await run(regPath(), ['query', key, view], { windowsHide: true });
    const values: Record<string, string> = {};
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s{4}(.+?)\s{4}REG_\w+\s{4}(.*)$/.exec(line);
      if (match) values[match[1]] = match[2];
    }
    return values;
  } catch {
    return {}; // key absent in this hive/view: normal
  }
}

/** Uninstall subkeys whose name starts with "Cheat Engine". */
async function ceUninstallKeys(root: string, view: '/reg:64' | '/reg:32'): Promise<string[]> {
  try {
    const { stdout } = await run(regPath(), ['query', root, '/f', 'Cheat Engine', '/k', view], { windowsHide: true });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('HKEY_') && basename(line).startsWith('Cheat Engine'));
  } catch {
    return [];
  }
}

/** Existing Cheat Engine install folders, from the registry and the default locations. */
export async function findCeDirs(): Promise<string[]> {
  const found: string[] = [];
  const add = (path: string | undefined) => {
    if (!path) return;
    const clean = path.replace(/[\\/]+$/, '');
    if (existsSync(join(clean, 'autorun')) && !found.some((p) => p.toLowerCase() === clean.toLowerCase())) found.push(clean);
  };

  for (const hive of ['HKLM', 'HKCU']) {
    for (const view of ['/reg:64', '/reg:32'] as const) {
      for (const key of await ceUninstallKeys(`${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, view)) {
        const values = await regValues(key, view);
        add(values.InstallLocation);
        add(values['Inno Setup: App Path']);
      }
    }
  }
  for (const env of ['ProgramFiles', 'ProgramFiles(x86)']) {
    const base = process.env[env];
    if (!base || !existsSync(base)) continue;
    for (const name of readdirSync(base)) if (name.startsWith('Cheat Engine')) add(join(base, name));
  }
  return found;
}

/** FNV-1a (32-bit) of the shipped plugin script, as the plugin computes it on its own file in CE. */
export function pluginScriptHash(): number {
  let h = 2166136261;
  for (const byte of Buffer.from(pluginScript, 'utf8')) h = Math.imul(h ^ byte, 16777619) >>> 0;
  return h;
}

/** Copy the plugin's Lua script to the per-user folder when it differs. Returns true if written. */
export function syncUserScript(): boolean {
  if (existsSync(USER_SCRIPT) && readFileSync(USER_SCRIPT, 'utf8') === pluginScript) return false;
  mkdirSync(USER_DIR, { recursive: true });
  const tmp = `${USER_SCRIPT}.tmp`;
  writeFileSync(tmp, pluginScript, 'utf8');
  renameSync(tmp, USER_SCRIPT);
  return true;
}

/** The former manual install of the plugin in autorun, if it is ours. */
function legacyInstall(autorun: string): string | null {
  const legacy = join(autorun, LEGACY_NAME);
  if (!existsSync(legacy) && !isLink(legacy)) return null;
  if (isLink(legacy)) return basename(readlinkSync(legacy)) === LEGACY_NAME ? legacy : null;
  return statSync(legacy).isFile() && readFileSync(legacy, 'utf8').slice(0, 512).includes(LEGACY_MARKER) ? legacy : null;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** One-line state of the CE side for an install folder. */
export function loaderStatus(ceDir: string): string {
  const autorun = join(ceDir, 'autorun');
  const loader = join(autorun, LOADER_NAME);
  const legacy = legacyInstall(autorun);
  let state: string;
  if (existsSync(loader)) {
    state = readFileSync(loader, 'utf8') === LOADER ? 'loader installed' : 'loader outdated, run /ce-install';
    if (legacy) state += ` (legacy ${LEGACY_NAME} still present, run /ce-install to remove it)`;
  } else if (legacy) {
    state = `legacy manual install (${isLink(legacy) ? 'symlink' : 'copy'} of ${LEGACY_NAME}), run /ce-install to switch to the auto-updated loader`;
  } else {
    state = 'not installed, run /ce-install';
  }
  return `${ceDir}: ${state}`;
}

/** Write the loader into autorun and remove the legacy install. Throws EPERM/EACCES without rights. */
export function writeLoader(ceDir: string): string[] {
  const autorun = join(ceDir, 'autorun');
  writeFileSync(join(autorun, LOADER_NAME), LOADER, 'utf8');
  const done = [`wrote ${join(autorun, LOADER_NAME)}`];
  const legacy = legacyInstall(autorun);
  if (legacy) {
    unlinkSync(legacy);
    done.push(`removed legacy ${legacy}`);
  }
  return done;
}

/** Run `node <this server> write-loader <ceDir>` through a UAC prompt and wait for it. */
async function writeLoaderElevated(ceDir: string, serverScript: string): Promise<void> {
  // Arguments travel base64-encoded: no quoting issue with spaces or quotes in paths
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const command = `
$ErrorActionPreference = 'Stop'
$d = { param($s) [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }
$node = & $d '${b64(process.execPath)}'
$script = & $d '${b64(serverScript)}'
$dir = & $d '${b64(ceDir)}'
try {
  $p = Start-Process -FilePath $node -ArgumentList @('"' + $script + '"', 'write-loader', '"' + $dir + '"') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
} catch [System.InvalidOperationException] {
  [Console]::Out.Write('DECLINED'); exit 0
}
[Console]::Out.Write('EXIT ' + $p.ExitCode)`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const { stdout } = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    timeout: ELEVATION_TIMEOUT_MS,
    windowsHide: true,
  });
  const out = stdout.trim();
  if (out === 'DECLINED') throw new Error('the administrator prompt was declined');
  if (out !== 'EXIT 0') throw new Error(`the elevated install failed (${out || 'no output'})`);
}

/** Sync the per-user script and install the loader in each CE folder; return a report. */
export async function install(ceDirs: string[], serverScript: string): Promise<string> {
  const lines = [`${syncUserScript() ? 'updated' : 'up to date'}: ${USER_SCRIPT}`];
  for (const ceDir of ceDirs) {
    try {
      lines.push(...writeLoader(ceDir));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES') {
        lines.push(`FAILED for ${ceDir}: ${(err as Error).message}`);
        continue;
      }
      try {
        await writeLoaderElevated(ceDir, serverScript);
        lines.push(`installed with administrator rights in ${join(ceDir, 'autorun')}`);
      } catch (elevated) {
        lines.push(`FAILED for ${ceDir}: ${(elevated as Error).message}`);
        continue;
      }
    }
    lines.push(loaderStatus(ceDir));
  }
  lines.push('Restart Cheat Engine to load the plugin.');
  return lines.join('\n');
}

/** State of the CE side for ce_status. */
export async function describeInstall(syncError: string | null): Promise<string> {
  const lines = ['CE plugin:'];
  if (syncError) lines.push(`  per-user script sync FAILED at startup: ${syncError}`);
  const dirs = await findCeDirs();
  if (!dirs.length) lines.push('  Cheat Engine install not found (pass ce_dir to ce_install_plugin)');
  for (const dir of dirs) lines.push(`  ${loaderStatus(dir)}`);
  return lines.join('\n');
}
