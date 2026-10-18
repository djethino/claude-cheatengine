/**
 * Exclusive, ordered access to Cheat Engine.
 *
 * CE runs every pipe script on its main Lua state and the server passes results through Lua
 * globals (_mcp_str, _mcp_more): two tool calls must never interleave their scripts. A tool
 * call runs inside exclusive(); a long job can give CE back between polls with
 * scope.pause(), so other tools are not blocked while CE works in the background.
 *
 * Every script a tool sends is wrapped in one chunk that, in a single round trip:
 * checks this server still owns CE (another Claude Code session may be connected to it),
 * logs the call in CE, applies the SAFE gate and the attached-process check, runs the body
 * with load() + pcall() and returns the byte length of the resulting text. The gate is part
 * of the same chunk as the action, so it cannot be skipped or raced.
 */

import { randomBytes } from 'crypto';
import { CEPipe, CEPipeError } from './pipe.js';
import { decodeBytes, incompleteUtf8Tail } from './text.js';
import { lua, raw, type LuaCode } from '../lua/lit.js';
import prelude from '../lua/prelude.lua';
import { ANTI_CHEAT_ADVICE, detectAntiCheat } from '../anticheat.js';
import { describeDialogs, isInformation, listDialogs, type CEDialog } from './dialogs.js';
import { logger } from '../logger.js';

export const PIPE_PATH = '\\\\.\\pipe\\ce-mcp';

/** Default cap on the text returned by one tool call (about 2,500 tokens). */
export const DEFAULT_MAX_BYTES = 10_000;
/** Largest read ce_output_more accepts. */
export const MAX_OUTPUT_BYTES = 100_000;
/** Default limit for one round trip; long synchronous operations pass their own. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Lua global holding the full text of the last truncated output, read back by ce_output_more. */
const MORE_VAR = '_mcp_more';
/** getCEVersion() * 100: 7.7 brought memscan FoundCount, ErrorString and Results, used by the scan tools. */
const MIN_CE_VERSION = 770;
/** Another server whose last call is older than this has stopped: its claim on CE lapses. */
const OWNER_LAPSE_S = 60;

const MARK_OWNER = '\u0001OWNER';
const MARK_INIT = '\u0001INIT';
/** Followed by a PID: the process CE has open was never checked for an anti-cheat. */
const MARK_AC = '\u0001AC';

export const BLOCKED_DANGEROUS =
  'BLOCKED: this tool can crash the game or CE, and SAFE mode is on. Ask the user to run /unsafe-ce (or toggle Mode in the CE MCP menu) if they want it.';
export const BLOCKED_NO_PROCESS = 'BLOCKED: no process attached. Use ce_attach first.';

export interface RunOptions {
  /** Crash-prone tool: refused while SAFE mode is on. */
  dangerous?: boolean;
  /** Refused when CE has no process opened. */
  requiresProcess?: boolean;
  /** Refused while the process CE has open has an anti-cheat, unless UNSAFE mode is on. */
  antiCheatGate?: boolean;
  timeoutMs?: number;
  /** Cap on the returned text; the rest stays readable with ce_output_more. */
  maxBytes?: number;
  /**
   * The call asks the user a question in CE and waits for the answer (the unlock): a question
   * dialog is expected. Otherwise any dialog that blocks CE ends the wait with its description.
   */
  asksUser?: boolean;
}

export interface CallInfo {
  tool: string;
  /** Short argument summary shown in CE's MCP log. */
  args: string;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Resolves with a release function once every earlier holder has released. */
  acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const turn = this.tail.then(() => release);
    this.tail = this.tail.then(() => held);
    return turn;
  }
}

export class OwnershipError extends Error {}

/** A call given up because a dialog blocks Cheat Engine. */
export class CEDialogError extends CEPipeError {}

/** A call running longer than this starts looking for dialogs blocking CE, then again at this interval. */
const DIALOG_WATCH_MS = 1500;

export class Session {
  private readonly mutex = new Mutex();
  private readonly pipe: CEPipe;
  private readonly owner = randomBytes(8).toString('hex');
  private readyConnection = -1;
  private firstConnection = true;
  /** Byte length of _mcp_more while a continuation is pending, 0 otherwise. */
  private moreTotal = 0;
  /** PID of the CE serving the pipe, read at every connection: whose dialogs are looked for. */
  private pid: number | null = null;
  private dialogWatchFailed = false;

  constructor(
    pipePath: string = PIPE_PATH,
    private readonly version: string,
  ) {
    this.pipe = new CEPipe(pipePath);
  }

  /** Run fn with exclusive access to CE. */
  async exclusive<T>(call: CallInfo, fn: (scope: Scope) => Promise<T>): Promise<T> {
    let release = await this.mutex.acquire();
    // A new tool call makes the previous truncated output unreadable (except for ce_output_more)
    if (call.tool !== 'ce_output_more') this.moreTotal = 0;
    const scope: Scope = {
      run: (body, options) => this.run(call, body, options ?? {}),
      runInt: (code, timeoutMs) => this.runInt(code, timeoutMs),
      readMore: (offset, maxBytes) => this.readMore(offset, maxBytes),
      pause: async (ms) => {
        release();
        await new Promise((resolve) => setTimeout(resolve, ms));
        release = await this.mutex.acquire();
      },
      takeOver: () => this.takeOver(),
      antiCheatOf: (pid) => this.antiCheatOf(pid),
    };
    try {
      return await fn(scope);
    } finally {
      release();
    }
  }

  close(): void {
    this.pipe.close();
  }

  /** PID of the CE serving the pipe as of the last connection (null before any). No lock: usable while a call is blocked. */
  get cePid(): number | null {
    return this.pid;
  }

  /**
   * One pipe request, watched for dialogs. A dialog the user opens in CE's window does not block
   * the pipe (its modal loop still runs pipe scripts); one opened while the script runs does: the
   * script waits for it (an auto assembler error, a Mono failure, a confirmation). So while the
   * request runs longer than DIALOG_WATCH_MS, CE's dialogs are listed (of every running CE when the
   * one serving the pipe is not known yet); a new one (any, or an information one when the call
   * asks the user a question) ends the wait with its description instead of a timeout.
   */
  private async exec(script: string, timeoutMs: number, asksUser = false): Promise<bigint> {
    const pid = this.pid;
    if (timeoutMs <= DIALOG_WATCH_MS) return this.pipe.exec(script, timeoutMs);
    let done = false;
    const failed = (err: unknown): void => {
      // Reported once: the calls still work, they only end in a plain timeout
      if (!this.dialogWatchFailed) logger.error('cannot look for Cheat Engine dialogs:', err);
      this.dialogWatchFailed = true;
    };
    // Dialogs already open when the request starts were not opened by it
    const earlier = listDialogs(pid).then(
      (dialogs) => new Set(dialogs.map((d) => d.id)),
      (err: unknown) => {
        failed(err);
        return null;
      },
    );
    const watch = async (): Promise<void> => {
      const before = await earlier;
      if (!before) return;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, DIALOG_WATCH_MS));
        if (done) return;
        let dialogs: CEDialog[];
        try {
          dialogs = (await listDialogs(pid)).filter((d) => !before.has(d.id));
        } catch (err) {
          failed(err);
          return;
        }
        if (done) return;
        if (dialogs.length && (!asksUser || dialogs.some(isInformation))) {
          this.pipe.abort(
            new CEDialogError(
              `Cheat Engine is blocked by a dialog: this call was given up (its result is lost; check the state once the dialog is closed).\n${describeDialogs(dialogs)}`,
            ),
          );
          return;
        }
      }
    };
    void watch();
    try {
      return await this.pipe.exec(script, timeoutMs);
    } finally {
      done = true;
    }
  }

  /**
   * Give CE up when the server stops, so the next session (or a restarted one) is not refused
   * until the owner claim lapses. Best effort: CE may already be gone.
   */
  async release(): Promise<void> {
    // Nothing to give back if this server never set CE up
    if (this.readyConnection === -1 && !this.pipe.connected) return;
    // Reconnects if needed: after a timeout the connection is gone but the claim is still in CE
    const release = await this.mutex.acquire();
    try {
      await this.pipe.exec(lua`if _mcp_owner == ${this.owner} then _mcp_owner = nil end return 1`.code, 2000);
    } catch {
      // Exiting anyway: nothing to report to
    } finally {
      release();
      this.pipe.close();
    }
  }

  /** First script of every connection: claim CE, reset SAFE once, install the helpers. */
  private async ensureReady(): Promise<void> {
    if (this.pipe.connected && this.pipe.connectionId === this.readyConnection) return;
    const init = lua`
      _mcp_server = { owner = ${this.owner}, version = ${this.version}, resetSafe = ${this.firstConnection}, lapse = ${OWNER_LAPSE_S} }
      ${raw(prelude)}
      return math.floor(getCEVersion() * 100 + 0.5)`;
    // Watched with the window of the previous connection: a dialog that still blocks CE is reported
    const ceVersion = Number(await this.exec(init.code, DEFAULT_TIMEOUT_MS));
    if (ceVersion < MIN_CE_VERSION) {
      this.pipe.close();
      throw new CEPipeError(
        `Cheat Engine ${MIN_CE_VERSION / 100} or later is required (this is CE ${ceVersion / 100}): update it from https://www.cheatengine.org`,
      );
    }
    this.pid = Number(await this.exec('return getCheatEngineProcessID()', DEFAULT_TIMEOUT_MS)) || null;
    this.readyConnection = this.pipe.connectionId;
    this.firstConnection = false;
    this.moreTotal = 0;
  }

  private async takeOver(): Promise<void> {
    await this.ensureReady();
    await this.pipe.exec(lua`_mcp_owner = ${this.owner}; _mcp_owner_seen = os.time(); return 1`.code, DEFAULT_TIMEOUT_MS);
  }

  /** Raw integer result of a protocol-internal script (no gate, no text). */
  private async runInt(code: LuaCode, timeoutMs = DEFAULT_TIMEOUT_MS, asksUser = false): Promise<bigint> {
    await this.ensureReady();
    return this.exec(code.code, timeoutMs, asksUser);
  }

  private chunk(call: CallInfo | null, body: LuaCode, options: RunOptions): LuaCode {
    const log = call
      ? lua`if CEMCP_logCommand then pcall(CEMCP_logCommand, ${call.tool}, ${call.args.slice(0, 100)}) end`
      : raw('');
    return lua`
      if _mcp == nil then _mcp_str = ${MARK_INIT} return #_mcp_str end
      if _mcp_owner ~= ${this.owner} then
        if _mcp_owner ~= nil and os.time() - (_mcp_owner_seen or 0) <= ${OWNER_LAPSE_S} then
          _mcp_str = ${MARK_OWNER} return #_mcp_str
        end
        _mcp_owner = ${this.owner}
      end
      _mcp_owner_seen = os.time()
      _mcp_str = nil
      local _pid = getOpenedProcessID() or 0
      local _ac = (_mcp.ac or {})[_pid]
      if ${options.antiCheatGate ?? false} and _pid ~= 0 and _ac == nil then
        _mcp_str = ${MARK_AC} .. _pid return #_mcp_str
      end
      ${log}
      if ${options.dangerous ?? false} and _mcp_unsafe ~= true then
        _mcp_str = ${BLOCKED_DANGEROUS}
      elseif ${options.requiresProcess ?? false} and _pid == 0 then
        _mcp_str = ${BLOCKED_NO_PROCESS}
      elseif ${options.antiCheatGate ?? false} and _pid ~= 0 and _ac ~= '' and _mcp_unsafe ~= true then
        _mcp_str = 'BLOCKED: anti-cheat detected in ' .. tostring(process or _pid) .. ': ' .. _ac .. '. ' .. ${ANTI_CHEAT_ADVICE}
      else
        local f, e = load(${body.code}, ${'=' + (call?.tool ?? 'cemcp')})
        if not f then
          _mcp_str = "LUA_SYNTAX_ERROR: " .. tostring(e)
        else
          local ok, err = pcall(f)
          if not ok then _mcp_str = "LUA_ERROR: " .. tostring(err) end
        end
      end
      if _mcp_str ~= nil and type(_mcp_str) ~= "string" then _mcp_str = tostring(_mcp_str) end
      return _mcp_str and #_mcp_str or 0`;
  }

  /** Calls already logged in CE: only the first script of a call is logged. */
  private readonly logged = new WeakSet<CallInfo>();

  /**
   * Run a tool body (Lua that leaves its text result in _mcp_str) and return that text, or null
   * when the body set nothing.
   */
  private async run(call: CallInfo, body: LuaCode, options: RunOptions): Promise<string | null> {
    const firstOfCall = !this.logged.has(call);
    this.logged.add(call);
    const code = this.chunk(firstOfCall ? call : null, body, options);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

    const runOnce = async (): Promise<string | null> => {
      const length = await this.runInt(code, timeoutMs, options.asksUser ?? false);
      const connection = this.pipe.connectionId;
      const text = length ? await this.readString('_mcp_str', Number(length), maxBytes, 0) : null;
      // A reconnect during the transfer would read the globals of a fresh CE Lua state
      if (this.pipe.connectionId !== connection) throw new CEPipeError('Connection to Cheat Engine lost while reading the result');
      return text;
    };

    let text = await runOnce();
    if (text === MARK_INIT) {
      // CE restarted between our setup and this script: set up again, then run it once more
      this.readyConnection = -1;
      text = await runOnce();
    }
    if (text?.startsWith(MARK_AC)) {
      // First call on this process: look for an anti-cheat, then run the script with the verdict
      await this.antiCheatOf(Number(text.slice(MARK_AC.length)));
      text = await runOnce();
    }
    if (text === MARK_OWNER) {
      throw new OwnershipError(
        'Another Claude Code session is using Cheat Engine. Call ce_status with take_over=true to take it over (the other session will then get this message).',
      );
    }
    return text;
  }

  /**
   * Anti-cheats found in a process (empty when none), detected once per PID and kept in CE
   * (_mcp.ac) so every server and every tool sees the same verdict. Works on a process CE has not
   * opened yet (ce_attach checks before attaching).
   */
  private async antiCheatOf(pid: number): Promise<string[]> {
    const cached = await this.query(lua`local ac = (_mcp.ac or {})[${pid}] if ac then _mcp_str = '=' .. ac end`);
    if (cached !== null) return cached.slice(1) ? cached.slice(1).split(', ') : [];
    const listing = await this.query(lua`
      local mods = enumModules(${pid}) or {}
      local names = {}
      for i, m in ipairs(mods) do names[i] = m.Name end
      _mcp_str = (mods[1] and mods[1].PathToFile or '') .. '\n' .. table.concat(names, '\n')`);
    const [exePath = '', ...modules] = (listing ?? '').split('\n');
    const found = detectAntiCheat(modules, exePath);
    await this.runInt(lua`_mcp.ac = _mcp.ac or {} _mcp.ac[${pid}] = ${found.join(', ')} return 1`);
    return found;
  }

  /** Run protocol-internal Lua that leaves a text in _mcp_str (no gate, no log, no truncation). */
  private async query(body: LuaCode): Promise<string | null> {
    const length = await this.runInt(this.chunk(null, body, {}));
    return length ? this.readString('_mcp_str', Number(length), Number(length), 0) : null;
  }

  /** Read part of the text kept for continuation by the last truncated output. */
  private async readMore(offset: number, maxBytes: number): Promise<string> {
    if (!this.moreTotal) {
      return 'Nothing to continue: no truncated output is pending (it is discarded as soon as another tool is called)';
    }
    if (!Number.isInteger(offset) || offset < 0 || offset >= this.moreTotal) {
      return `Error: offset must be between 0 and ${this.moreTotal - 1}`;
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OUTPUT_BYTES) {
      return `Error: max_bytes must be between 1 and ${MAX_OUTPUT_BYTES}`;
    }
    return (await this.readString(MORE_VAR, this.moreTotal, maxBytes, offset)) ?? '';
  }

  /**
   * Transfer bytes [start, start + maxBytes) of a Lua string global, 8 bytes per round trip.
   * When bytes remain, the text ends with a "[truncated: ...]" line and the full string is kept
   * in _mcp_more for ce_output_more.
   */
  private async readString(varName: string, total: number, maxBytes: number, start: number): Promise<string | null> {
    if (start >= total) return null;
    let end = Math.min(total, start + maxBytes);
    const data = Buffer.alloc(end - start);
    const variable = raw(varName);

    for (let pos = start; pos < end; pos += 8) {
      const packed = await this.runInt(lua`
        local a, b, c, d, e, f, g, h = string.byte(${variable}, ${pos + 1}, ${pos + 8})
        return (a or 0) | ((b or 0) << 8) | ((c or 0) << 16) | ((d or 0) << 24)
          | ((e or 0) << 32) | ((f or 0) << 40) | ((g or 0) << 48) | ((h or 0) << 56)`);
      const block = Buffer.alloc(8);
      block.writeBigUInt64LE(packed);
      block.copy(data, pos - start, 0, Math.min(8, end - pos));
    }

    let bytes: Uint8Array = data;
    if (end < total) {
      // Stop before a multi-byte character cut in half; the next read starts at it
      const cut = incompleteUtf8Tail(bytes);
      if (cut < bytes.length) {
        bytes = bytes.subarray(0, bytes.length - cut);
        end -= cut;
      }
      if (varName !== MORE_VAR) {
        await this.runInt(raw(`${MORE_VAR} = ${varName}; return 1`));
        this.moreTotal = total;
      }
    }

    let text = decodeBytes(bytes);
    if (end < total) {
      text +=
        `\n[truncated: bytes ${start + 1}-${end} of ${total} shown. ` +
        `Call ce_output_more(offset=${end}) next to read the rest; calling any other tool discards it]`;
    }
    return text;
  }
}

export interface Scope {
  /** Run a tool body (gated, logged) and return the text it left in _mcp_str, or null. */
  run(body: LuaCode, options?: RunOptions): Promise<string | null>;
  /** Run protocol-internal Lua and return its raw integer result. */
  runInt(code: LuaCode, timeoutMs?: number): Promise<bigint>;
  readMore(offset: number, maxBytes: number): Promise<string>;
  /** Give CE back to other tool calls for ms milliseconds (long jobs between two polls). */
  pause(ms: number): Promise<void>;
  /** Claim CE for this server even if another session is using it. */
  takeOver(): Promise<void>;
  /** Anti-cheats found in a process, opened or not (empty when none). */
  antiCheatOf(pid: number): Promise<string[]>;
}
