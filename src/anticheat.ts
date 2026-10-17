/**
 * Anti-cheat detection. Using Cheat Engine on a process protected by an anti-cheat can get the
 * player's account banned, so every tool that touches such a process is refused until the user
 * unlocks UNSAFE mode, and the refusal tells Claude to explain why (src/ce/session.ts applies it).
 *
 * Detected from the modules loaded in the process (most anti-cheats load a DLL into the game) and,
 * for Unity's Anti-Cheat Toolkit (ACTk, compiled into the game), from the game's files.
 * The list is not exhaustive: kernel-only anti-cheats may load nothing into the game.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, dirname, extname, join } from 'path';

/** Lowercase substrings of module names, with the anti-cheat they belong to. */
export const MODULE_SIGNATURES: Array<[string, string]> = [
  ['easyanticheat', 'Easy Anti-Cheat'],
  ['eac_launcher', 'Easy Anti-Cheat'],
  ['beclient', 'BattlEye'],
  ['battleye', 'BattlEye'],
  ['x3.xem', 'XIGNCODE3'],
  ['xigncode', 'XIGNCODE3'],
  ['npggnt', 'nProtect GameGuard'],
  ['gameguard', 'nProtect GameGuard'],
  ['gamemon', 'nProtect GameGuard'],
  ['ace-base', 'Anti-Cheat Expert (ACE)'],
  ['ace-ats', 'Anti-Cheat Expert (ACE)'],
  ['acebase', 'Anti-Cheat Expert (ACE)'],
  ['mhyprot', 'mhyprot (HoYoverse)'],
  ['equ8', 'EQU8'],
  ['faceit', 'FACEIT'],
  ['vanguard', 'Riot Vanguard'],
  ['denuvo-anti-cheat', 'Denuvo Anti-Cheat'],
  ['wellbia', 'XIGNCODE3'],
];

const ACTK_ASSEMBLIES = ['ACTk.Runtime.dll', 'CodeStage.AntiCheat.dll'];
const ACTK_MARKER = Buffer.from('CodeStage.AntiCheat');

export function detectFromModules(moduleNames: string[]): string[] {
  const found = new Set<string>();
  for (const name of moduleNames) {
    const lower = name.toLowerCase();
    for (const [needle, label] of MODULE_SIGNATURES) if (lower.includes(needle)) found.add(label);
  }
  return [...found];
}

/**
 * Unity's Anti-Cheat Toolkit next to the game executable: Mono builds ship its assembly in
 * <name>_Data/Managed, IL2CPP builds have its namespace in the global metadata.
 */
export function detectActk(exePath: string): boolean {
  if (!exePath || !existsSync(exePath)) return false;
  const dataDir = join(dirname(exePath), `${basename(exePath, extname(exePath))}_Data`);
  const managed = join(dataDir, 'Managed');
  if (existsSync(managed)) {
    const files = readdirSync(managed);
    if (ACTK_ASSEMBLIES.some((assembly) => files.includes(assembly))) return true;
  }
  const metadata = join(dataDir, 'il2cpp_data', 'Metadata', 'global-metadata.dat');
  return existsSync(metadata) && readFileSync(metadata).includes(ACTK_MARKER);
}

export function detectAntiCheat(moduleNames: string[], exePath: string): string[] {
  const found = detectFromModules(moduleNames);
  if (detectActk(exePath)) found.push('Unity Anti-Cheat Toolkit (ACTk)');
  return found;
}

/** Refusal text for a protected process (built in Lua with the detected names: see session.ts). */
export const ANTI_CHEAT_ADVICE =
  'Using Cheat Engine on it can get the player\'s account banned (online play, leaderboards, cloud saves). ' +
  'Tell the user this reason before doing anything else. Only if they accept the risk can they run /unsafe-ce; never unlock it yourself.';
