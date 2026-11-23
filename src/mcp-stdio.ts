// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';

// Long enough for an agent busy with a long test run; most clients never restart a dead stdio server.
export const MCP_IDLE_MS = 2 * 60 * 60_000;
const PARENT_CHECK_MS = 1000;
/** The SDK does not close on EOF or observe stdout errors. Own that lifecycle
 * here, with one sleeping deadline and no deadline while a request is active. */
export class McpStdioTransport extends StdioServerTransport {
  private readonly pending = new Set<RequestId>();
  private timer?: NodeJS.Timeout;
  private parentCheck?: NodeJS.Timeout;
  private closed = false;
  constructor(
    private readonly input: Readable = process.stdin,
    private readonly output: Writable = process.stdout,
    private readonly idleMs = Number(process.env.FORGE_MCP_IDLE_MS) || MCP_IDLE_MS,
  ) {
    super(input, output);
  }
  private readonly disconnect = () => {
    void this.close();
  };
  private readonly streamError = (error: Error) => {
    this.onerror?.(error);
    this.disconnect();
  };
  private async watchParent() {
    if (this.closed || this.input !== process.stdin || this.output !== process.stdout) return;
    // Node captures ppid at startup. Check that original pid even if a wrapper
    // elsewhere still holds both ends of the client's pipes open.
    const parent = process.ppid;
    if (parent <= 1) return;
    // Client ancestry is only needed by the stdio server, outside the CLI bundle.
    const { detectedClientProcess } = (await import(
      /* @vite-ignore */ new URL('./agent-client-process.js', import.meta.url).href
    )) as typeof import('./agent-client-process.js');
    if (this.closed) return;
    const client = Number(detectedClientProcess()?.split('@', 1)[0] ?? parent);
    const watched = parent === client ? [parent] : [parent, client];
    this.parentCheck = setInterval(() => {
      for (const pid of watched) {
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            this.disconnect();
            break;
          }
        }
      }
    }, PARENT_CHECK_MS);
    this.parentCheck.unref();
  }
  private arm() {
    clearTimeout(this.timer);
    if (!this.closed && !this.pending.size) {
      this.timer = setTimeout(this.disconnect, this.idleMs > 0 ? this.idleMs : MCP_IDLE_MS);
      this.timer.unref();
    }
  }
  override async start() {
    const message = this.onmessage;
    this.onmessage = value => {
      if ('method' in value && 'id' in value && value.id !== undefined) {
        this.pending.add(value.id);
        clearTimeout(this.timer);
      }
      message?.(value);
    };
    this.input.once('end', this.disconnect);
    this.input.once('close', this.disconnect);
    this.input.on('error', this.streamError);
    this.output.once('close', this.disconnect);
    this.output.on('error', this.streamError);
    await super.start();
    this.arm();
    if (this.input.readableEnded || this.input.destroyed || this.output.destroyed) this.disconnect();
    else await this.watchParent();
  }
  override async send(message: JSONRPCMessage) {
    if (this.closed) throw new Error('MCP_TRANSPORT_CLOSED');
    try {
      await new Promise<void>((resolve, reject) => {
        this.output.write(serializeMessage(message), error => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      this.disconnect();
      throw error;
    } finally {
      if (!('method' in message) && 'id' in message && message.id !== undefined) {
        this.pending.delete(message.id);
        this.arm();
      }
    }
  }
  override async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.parentCheck);
    this.pending.clear();
    this.input.off('end', this.disconnect);
    this.input.off('close', this.disconnect);
    this.input.off('error', this.streamError);
    this.output.off('close', this.disconnect);
    this.output.off('error', this.streamError);
    await super.close();
  }
}
