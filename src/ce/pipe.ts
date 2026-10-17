/**
 * Client for Cheat Engine's Lua server pipe (openLuaServer, see celua.txt).
 *
 * Protocol (byte-mode named pipe):
 * - request: u8 command (1 = run a Lua script) | u32le script length | UTF-8 script | u64le parameter
 * - reply: exactly 8 bytes, u64le = lua_tointeger() of the script's return value
 *   (non-integral numbers, strings, nil and booleans give 0; negatives come back as 2^64 - n)
 *
 * CE runs every script on its main Lua state, so callers must never have two requests in flight
 * (see Session). A request that times out leaves its reply on its way: the socket is destroyed so
 * a late reply can never be taken for the answer to the next request.
 */

import { connect, type Socket } from 'net';

const CMD_RUN_SCRIPT = 1;
const REPLY_BYTES = 8;
const CONNECT_TIMEOUT_MS = 3000;

export class CEPipeError extends Error {}

interface Pending {
  resolve: (value: bigint) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class CEPipe {
  private socket: Socket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private pending: Pending | null = null;
  /** Incremented on every new connection, so callers can detect a reconnect (CE restarted). */
  connectionId = 0;

  constructor(readonly path: string) {}

  get connected(): boolean {
    return this.socket !== null;
  }

  /** Run a Lua script and return its integer result as the raw unsigned 64-bit value. */
  async exec(script: string, timeoutMs: number): Promise<bigint> {
    if (this.pending) throw new Error('CEPipe.exec called while a request is in flight');
    const socket = this.socket ?? (await this.open());

    const code = Buffer.from(script, 'utf8');
    const packet = Buffer.alloc(1 + 4 + code.length + 8);
    packet.writeUInt8(CMD_RUN_SCRIPT, 0);
    packet.writeUInt32LE(code.length, 1);
    code.copy(packet, 5);
    packet.writeBigUInt64LE(0n, 5 + code.length);

    return new Promise<bigint>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(
          new CEPipeError(
            `Cheat Engine did not answer within ${timeoutMs / 1000} s (a dialog may be open in CE, or the operation is still running there)`,
          ),
        );
      }, timeoutMs);
      this.pending = { resolve, reject, timer };
      socket.write(packet);
    });
  }

  close(): void {
    this.fail(new CEPipeError('Pipe closed'));
  }

  private open(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.path);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new CEPipeError(`Timed out connecting to ${this.path}`));
      }, CONNECT_TIMEOUT_MS);

      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.connectionId++;
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('error', (err) => this.fail(new CEPipeError(`Pipe error: ${err.message}`)));
        socket.on('close', () => this.fail(new CEPipeError('Cheat Engine closed the pipe (CE exited or its Lua server stopped)')));
        resolve(socket);
      });
      socket.once('error', (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        const hint =
          err.code === 'ENOENT'
            ? 'Cheat Engine is not running, or its MCP plugin is not loaded (run /ce-install, then restart CE)'
            : err.message;
        reject(new CEPipeError(`Cannot connect to ${this.path}: ${hint}`));
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    if (!this.pending) {
      // Nothing was asked: the stream is out of sync, never guess which request this belongs to
      this.fail(new CEPipeError(`Unexpected ${this.buffer.length} bytes from Cheat Engine`));
      return;
    }
    if (this.buffer.length < REPLY_BYTES) return;
    if (this.buffer.length > REPLY_BYTES) {
      this.fail(new CEPipeError(`Cheat Engine sent ${this.buffer.length} bytes for one 8-byte reply`));
      return;
    }
    const value = this.buffer.readBigUInt64LE(0);
    this.buffer = Buffer.alloc(0);
    const { resolve, timer } = this.pending;
    clearTimeout(timer);
    this.pending = null;
    resolve(value);
  }

  /** Reject the request in flight (if any) and drop the connection; the next exec reconnects. */
  private fail(err: Error): void {
    const socket = this.socket;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    if (socket) {
      socket.removeAllListeners();
      socket.on('error', () => {}); // a destroyed socket may still report the original error
      socket.destroy();
    }
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }
}

/** Interpret a raw reply as the signed Lua integer it was. */
export function toSigned(value: bigint): bigint {
  return BigInt.asIntN(64, value);
}
