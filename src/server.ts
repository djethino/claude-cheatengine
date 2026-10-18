/**
 * MCP server: registers every tool with its gates (see tools/registry.ts) and runs each call with
 * exclusive access to Cheat Engine.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { CEPipeError } from './ce/pipe.js';
import { OwnershipError, type Session } from './ce/session.js';
import { readOnly } from './options.js';
import { isErrorText, resolveFlag, type Args, type ImageResult, type ToolContext, type ToolDef } from './tools/registry.js';
import { logger } from './logger.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export const BLOCKED_READ_ONLY =
  'BLOCKED: read-only mode is on (plugin option read_only): this tool changes the game or writes a file. The user can turn it off with /plugin configure asymptomatik-cheatengine.';

function summarize(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ');
}

export async function callTool(session: Session, tool: ToolDef, args: Args<ToolDef['schema']>, extra: Extra): Promise<string | ImageResult> {
  if (resolveFlag(tool.writes, args) && readOnly()) return BLOCKED_READ_ONLY;
  const dangerous = resolveFlag(tool.dangerous, args);
  const call = { tool: tool.name, args: summarize(args) };
  const progressToken = extra._meta?.progressToken;

  try {
    return await session.exclusive(call, (scope) => {
      const ctx: ToolContext = {
        scope,
        signal: extra.signal,
        run: (body, options) =>
          scope.run(body, { ...options, dangerous, requiresProcess: tool.requiresProcess ?? false, antiCheatGate: !tool.antiCheatExempt }),
        async progress(done, total, message) {
          if (progressToken === undefined) return;
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: done, ...(total !== undefined && { total }), message },
          });
        },
      };
      return tool.run(args, ctx);
    });
  } catch (err) {
    if (err instanceof OwnershipError) return `BLOCKED: ${err.message}`;
    if (err instanceof CEPipeError) return `Error: ${err.message}`;
    throw err;
  }
}

export function createServer(session: Session, tools: ToolDef[], version: string): McpServer {
  const server = new McpServer({ name: 'cheatengine', version });

  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema }, async (args: Args<ToolDef['schema']>, extra: Extra) => {
      try {
        const result = await callTool(session, tool, args, extra);
        if (typeof result === 'string') {
          return { content: [{ type: 'text' as const, text: result }], ...(isErrorText(result) && { isError: true }) };
        }
        return {
          content: [
            { type: 'image' as const, data: result.image.data, mimeType: result.image.mimeType },
            { type: 'text' as const, text: result.text },
          ],
        };
      } catch (err) {
        // A bug in the server, not a CE failure: keep the stack in the log
        logger.error(`${tool.name} failed:`, err);
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
      }
    });
  }
  return server;
}
