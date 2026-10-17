/**
 * Tool declarations. Each tool states what it does to the game, and the gates follow from that:
 *
 * - writes: changes the target process or writes a file -> refused in read-only mode
 *   (plugin option read_only, off by default)
 * - dangerous: can crash the game or CE (arbitrary Lua, code injection, DLL injection, debugger,
 *   .CT tables that run scripts, Mono heap access) -> refused while SAFE mode is on
 * - requiresProcess: refused while CE has no process opened
 *
 * dangerous and requiresProcess are applied inside the Lua chunk of every CE call the tool makes
 * (src/ce/session.ts); a tool cannot run CE code without them.
 */

import type { z } from 'zod';
import type { LuaCode } from '../lua/lit.js';
import type { RunOptions, Scope } from '../ce/session.js';

export type Shape = z.ZodRawShape;
export type Args<S extends Shape> = z.objectOutputType<S, z.ZodTypeAny>;

export interface ToolContext {
  /** Run a tool body in CE with this tool's gates; returns the text it left in _mcp_str. */
  run(body: LuaCode, options?: Omit<RunOptions, 'dangerous' | 'requiresProcess'>): Promise<string | null>;
  scope: Scope;
  /** Report progress to the client (shown by Claude Code for long calls). */
  progress(done: number, total: number | undefined, message: string): Promise<void>;
  signal: AbortSignal;
}

export interface ToolDef<S extends Shape = Shape> {
  name: string;
  description: string;
  schema: S;
  writes: boolean | ((args: Args<S>) => boolean);
  dangerous?: boolean | ((args: Args<S>) => boolean);
  requiresProcess?: boolean;
  run(args: Args<S>, ctx: ToolContext): Promise<string>;
}

/** Keeps each tool's argument types while collecting tools of different shapes in one list. */
export function defineTool<S extends Shape>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export function resolveFlag<S extends Shape>(flag: boolean | ((args: Args<S>) => boolean) | undefined, args: Args<S>): boolean {
  return typeof flag === 'function' ? flag(args) : (flag ?? false);
}

/** Text results that report a failure (shown as errors by the client). */
export function isErrorText(text: string): boolean {
  return /^(Error:|BLOCKED:|LUA_ERROR:|LUA_SYNTAX_ERROR:)/.test(text);
}
