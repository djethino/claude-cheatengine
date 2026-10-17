/**
 * A fake Cheat Engine for offline tests: a named-pipe server speaking CE's Lua server protocol,
 * running every script in a real Lua state (test/lua-vm.ts).
 *
 * Like CE, a script runs as a function body and its result goes back as lua_tointeger() of the
 * returned value: integers as is (64-bit exact), integral floats converted, numeric strings
 * parsed, anything else 0.
 */

import { createServer, type Server, type Socket } from 'net';
import { initLua, LuaVM, type LuaResult } from './lua-vm.js';

const CE_STUBS = `
__fake = { pid = 0, logs = {}, prints = {} }
function getCEVersion() return 7.6 end
function getOpenedProcessID() return __fake.pid end
function openProcess(p) __fake.pid = type(p) == 'number' and p or 4242 return true end
function print(...) local t = table.pack(...) for i = 1, t.n do t[i] = tostring(t[i]) end __fake.prints[#__fake.prints + 1] = table.concat(t, ' ') end
function CEMCP_logCommand(tool, args) __fake.logs[#__fake.logs + 1] = tool .. ' ' .. tostring(args) end
function updateMenuState() end
`;

// lua_tointeger() of the script's result, as a decimal string (exact on 64 bits)
const RUNNER = `
local f, e = load(__script, '=pipe')
if not f then __fake.lastError = e return '0' end
local ok, r = pcall(f)
if not ok then __fake.lastError = r return '0' end
if type(r) == 'string' then r = tonumber(r) end
local i = type(r) == 'number' and math.tointeger(r) or nil
return string.format('%d', i or 0)
`;

export interface FakeCEOptions {
  /** Deliver each reply in two writes (tests reassembly of split chunks). */
  splitReplies?: boolean;
}

export class FakeCE {
  readonly scripts: string[] = [];
  /** Delay before answering the next script (ms), consumed once. */
  delayNext = 0;
  private readonly sockets = new Set<Socket>();
  private vm!: LuaVM;
  private server!: Server;

  private constructor(
    readonly path: string,
    private readonly options: FakeCEOptions,
  ) {}

  static async start(options: FakeCEOptions = {}): Promise<FakeCE> {
    const path = `\\\\.\\pipe\\ce-mcp-test-${process.pid}-${Math.random().toString(16).slice(2)}`;
    await initLua();
    const fake = new FakeCE(path, options);
    fake.resetLuaState();
    fake.server = createServer((socket) => fake.serve(socket));
    await new Promise<void>((resolve) => fake.server.listen(path, resolve));
    return fake;
  }

  /** A fresh Lua state, as after a CE restart. */
  resetLuaState(): void {
    this.vm?.close();
    this.vm = new LuaVM();
    this.vm.run(CE_STUBS);
  }

  /** Evaluate a Lua expression in the fake CE's state (test assertions). */
  eval(expression: string): LuaResult {
    return this.vm.run(`return ${expression}`);
  }

  exec(code: string): void {
    this.vm.run(code);
  }

  /** Drop every client connection (CE's Lua server stopped). */
  dropConnections(): void {
    for (const socket of this.sockets) socket.destroy();
  }

  async stop(): Promise<void> {
    this.dropConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.vm.close();
  }

  private serve(socket: Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    // Like CE, scripts of one connection run one after the other
    let busy = Promise.resolve();
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const length = buffer.readUInt32LE(1);
        const frame = 1 + 4 + length + 8;
        if (buffer.length < frame) break;
        const script = buffer.subarray(5, 5 + length).toString('utf8');
        buffer = buffer.subarray(frame);
        busy = busy.then(() => this.answer(socket, script));
      }
    });
  }

  private async answer(socket: Socket, script: string): Promise<void> {
    this.scripts.push(script);
    this.vm.setGlobalString('__script', script);
    const result = BigInt.asUintN(64, BigInt(this.vm.run(RUNNER) as string));
    if (this.delayNext) {
      const delay = this.delayNext;
      this.delayNext = 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (socket.destroyed) return;
    const reply = Buffer.alloc(8);
    reply.writeBigUInt64LE(result);
    if (this.options.splitReplies) {
      socket.write(reply.subarray(0, 3));
      await new Promise((resolve) => setTimeout(resolve, 2));
      socket.write(reply.subarray(3));
    } else {
      socket.write(reply);
    }
  }
}
