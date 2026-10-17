/**
 * End-to-end test harness: fake CE + Session + MCP server + SDK client over an in-memory link.
 * Call useHarness() at the top of a test file; every test starts with a fresh CE Lua state.
 */

import { before, after, beforeEach } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FakeCE, type FakeCEOptions } from './fake-ce.js';
import { Session } from '../src/ce/session.js';
import { createServer } from '../src/server.js';
import { allTools } from '../src/tools/index.js';
import type { ToolDef } from '../src/tools/registry.js';

export interface ToolResult {
  text: string;
  isError: boolean;
}

export interface Harness {
  ce: FakeCE;
  call(name: string, args?: Record<string, unknown>, onProgress?: (message: string) => void): Promise<ToolResult>;
  /** UNSAFE mode on and a process attached (pid 7). */
  unlock(): Promise<void>;
}

export function useHarness(options: FakeCEOptions = {}, extraTools: ToolDef[] = []): Harness {
  let session: Session | undefined;
  let client: Client | undefined;

  const harness: Harness = {
    ce: undefined as unknown as FakeCE,
    async call(name, args = {}, onProgress) {
      const result = await client!.callTool(
        { name, arguments: args },
        undefined,
        onProgress ? { onprogress: (p) => onProgress(p.message ?? '') } : undefined,
      );
      const content = result.content as Array<{ type: string; text: string }>;
      return { text: content.map((c) => c.text).join(''), isError: result.isError === true };
    },
    async unlock() {
      await harness.call('ce_safety_enable_writes', { confirm: 'USER_CONFIRMED' });
      harness.ce.exec('__fake.pid = 7');
    },
  };

  before(async () => {
    harness.ce = await FakeCE.start(options);
  });
  after(async () => {
    await client?.close();
    session?.close();
    await harness.ce.stop();
  });
  beforeEach(async () => {
    await client?.close();
    session?.close();
    harness.ce.resetLuaState();
    delete process.env.CLAUDE_PLUGIN_OPTION_READ_ONLY;
    session = new Session(harness.ce.path, 'test');
    const server = createServer(session, [...allTools, ...extraTools], 'test');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    client = new Client({ name: 'test', version: '1' });
    await client.connect(clientSide);
  });

  return harness;
}
