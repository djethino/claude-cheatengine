/**
 * Server diagnostics on stderr (stdout carries the MCP protocol). Claude Code keeps them in its
 * MCP server log.
 */

function format(args: unknown[]): string {
  return args.map((arg) => (arg instanceof Error ? (arg.stack ?? arg.message) : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
}

export const logger = {
  info: (...args: unknown[]) => process.stderr.write(`[cheatengine] ${format(args)}\n`),
  error: (...args: unknown[]) => process.stderr.write(`[cheatengine] ERROR ${format(args)}\n`),
};
