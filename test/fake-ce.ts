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
import memscanStub from './fake/memscan.lua';
import addressListStub from './fake/addresslist.lua';
import monoStub from './fake/mono.lua';

const CE_STUBS = `
__fake = { pid = 0, logs = {}, prints = {} }
function getCEVersion() return __fake.ceVersion or 7.7 end
-- CE's own process, only when a test sets it
function getCheatEngineProcessID() return __fake.cePid end
function closeCE() __fake.closed = true end
function getOpenedProcessID() return __fake.pid end
function openProcess(p) __fake.pid = type(p) == 'number' and p or 4242 return true end
function print(...) local t = table.pack(...) for i = 1, t.n do t[i] = tostring(t[i]) end __fake.prints[#__fake.prints + 1] = table.concat(t, ' ') end
function CEMCP_logCommand(tool, args) __fake.logs[#__fake.logs + 1] = tool .. ' ' .. tostring(args) end
function updateMenuState() end
-- Confirmation dialogs: the "user" answers __fake.dialogAnswer (Yes by default)
mrYes, mrNo, mtWarning, mbYes, mbNo = 6, 7, 1, 4, 8
__fake.dialogs = {}
function messageDialog(title, text, ...) __fake.dialogs[#__fake.dialogs + 1] = text return __fake.dialogAnswer or mrYes end

-- Simulated target: sparse byte memory, one module "game.exe" at 0x400000 (size 0x1000)
__fake.mem = {}
process = 'game.exe'
function targetIs64Bit() return true end
function getModuleSize(name) if name == 'game.exe' then return 0x1000 end end
-- Running processes by PID (4242 = game.exe); a test can add modules, e.g. an anti-cheat DLL
__fake.processes = { ['game.exe'] = 4242, ['protected.exe'] = 5555 }
__fake.extraModules = { [5555] = { { Name = 'EasyAntiCheat_x64.dll', Address = 0x900000, Size = 0x100 } } }
function getProcessIDFromProcessName(name) return __fake.processes[name] end
function enumModules(pid)
  local list = { { Name = 'game.exe', Address = 0x400000, Size = 0x1000, PathToFile = 'C:/nowhere/game.exe' },
                 { Name = 'other.dll', Address = 0x800000, Size = 0x100 } }
  for _, m in ipairs(__fake.extraModules[pid or __fake.pid] or {}) do list[#list + 1] = m end
  return list
end
function enumMemoryRegions() return { { BaseAddress = 0x400000, RegionSize = 0x1000, Protect = 0x20 }, { BaseAddress = 0x500000, RegionSize = 0x2000, Protect = 0x104 } } end
function getAddressSafe(s)
  if type(s) == 'number' then return s end
  if s == 'game.exe' then return 0x400000 end
  local m, off = s:match('^(game%.exe)%+(%w+)$')
  if m then return 0x400000 + tonumber(off, 16) end
  -- Like CE, a bare number is hexadecimal ('00400304', the format of FoundList addresses)
  return tonumber((s:gsub('^0[xX]', '')), 16)
end
function getNameFromAddress(a)
  if a >= 0x400000 and a < 0x401000 then return string.format('game.exe+%X', a - 0x400000) end
  return string.format('%X', a)
end
-- Mapped memory: the module (0x400000-0x401000), then heap up to 0x402000
local function mapped(a) return a >= 0x400000 and a < 0x402000 end
function inModule(a) return a >= 0x400000 and a < 0x401000 end
function readBytes(a, n, asTable)
  local t = {}
  for i = 0, n - 1 do
    if not mapped(a + i) then return nil end
    t[#t + 1] = __fake.mem[a + i] or 0
  end
  if asTable then return t end
  return table.unpack(t)
end
function writeBytes(a, t, ...)
  if type(t) ~= 'table' then t = { t, ... } end
  for i, b in ipairs(t) do
    if not mapped(a + i - 1) then return false end
    __fake.mem[a + i - 1] = b & 0xFF
  end
  return true
end
local function readFmt(fmt, n) return function(a, signed)
  local b = readBytes(a, n, true)
  if not b then return nil end
  local v = string.unpack(fmt, string.char(table.unpack(b)))
  return v
end end
local function writeFmt(fmt) return function(a, v)
  local s = string.pack(fmt, v)
  return writeBytes(a, { s:byte(1, -1) })
end end
local readU16, readU32 = readFmt('<I2', 2), readFmt('<I4', 4)
function readSmallInteger(a, signed) return (signed and readFmt('<i2', 2) or readU16)(a) end
function readInteger(a, signed) return (signed and readFmt('<i4', 4) or readU32)(a) end
readQword, readFloat, readDouble = readFmt('<i8', 8), readFmt('<f', 4), readFmt('<d', 8)
readPointer = readQword
writeSmallInteger = function(a, v) return writeFmt('<I2')(a, v & 0xFFFF) end
writeInteger = function(a, v) return writeFmt('<I4')(a, v & 0xFFFFFFFF) end
writeQword, writeFloat, writeDouble = writeFmt('<i8'), writeFmt('<f'), writeFmt('<d')
function readString(a, max, wide)
  local out = {}
  for i = 0, max - 1 do
    local c = readBytes(a + i, 1)
    if not c or c == 0 then break end
    out[#out + 1] = string.char(c)
  end
  return table.concat(out)
end
function writeString(a, s) return writeBytes(a, { s:byte(1, -1) }) end
function disassemble(a) return string.format('%X - 90 - nop', a) end
function getInstructionSize(a) return 1 end
function splitDisassembledString(s) local a, b, o = s:match('^(%x+) %- (.-) %- (.*)$') return a, b, o, '' end
local function stringlist(items)
  local o = { Count = #items, destroy = function() end }
  for i, v in ipairs(items) do o[i - 1] = v end
  return o
end
function createStringlist() return stringlist({}) end
function getProcessList(sl) sl[0], sl[1], sl.Count = '00001A2B-game.exe', '00000004-System', 2 end
-- Threads run between two pipe scripts (one step per script), like work done in the background
__fake.threads = {}
function createThread(fn)
  local t = { Name = '', Terminated = false }
  __fake.threads[#__fake.threads + 1] = coroutine.create(function() fn(t) end)
  return t
end
function __fake.stepThreads()
  local pending = {}
  for _, co in ipairs(__fake.threads) do
    local ok, err = coroutine.resume(co)
    if not ok then __fake.threadError = err end
    if coroutine.status(co) ~= 'dead' then pending[#pending + 1] = co end
  end
  __fake.threads = pending
end
-- A job's thread can call this to wait for the next step
function __fake.yield() if coroutine.isyieldable() then coroutine.yield() end end
-- Time passes only when a thread sleeps; __fake.onSleep (if set) plays the game meanwhile
__fake.tick = 0
function getTickCount() return __fake.tick end
function sleep(ms) __fake.tick = __fake.tick + ms if __fake.onSleep then __fake.onSleep(__fake.tick) end __fake.yield() end
caHide = 1
function createTimer() return { Interval = 1000, Enabled = true } end
local function control() return { destroy = function() __fake.windows = (__fake.windows or 1) - 1 end, show = function() __fake.windows = (__fake.windows or 0) + 1 end } end
function createForm() return control() end
createLabel, createProgressBar, createButton = control, control, control
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
    for (const stub of [memscanStub, addressListStub, monoStub]) this.vm.run(stub);
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
    this.vm.run('__fake.stepThreads()');
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
