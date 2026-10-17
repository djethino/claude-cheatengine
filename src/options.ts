/**
 * Plugin options (userConfig in .claude-plugin/plugin.json), passed by .mcp.json as
 * CLAUDE_PLUGIN_OPTION_<KEY> environment variables. An option the user never set is "".
 */

/** Read-only mode: every tool that changes the game or writes a file is refused. Off by default. */
export function readOnly(): boolean {
  const value = (process.env.CLAUDE_PLUGIN_OPTION_READ_ONLY ?? '').trim().toLowerCase();
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`Invalid read_only option "${value}": expected true or false`);
}
