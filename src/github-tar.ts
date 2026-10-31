// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';

/** Exact-length reads over a provider byte stream. Memory is one provider chunk
 * plus the requested window; nothing buffers the whole archive. */
class ByteReader {
  private queue: Buffer[] = [];
  private queued = 0;
  private done = false;
  constructor(private source: AsyncIterator<Uint8Array>) {}
  private async fill(n: number) {
    while (this.queued < n && !this.done) {
      const next = await this.source.next();
      if (next.done) this.done = true;
      else if (next.value.byteLength) {
        const part = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
        this.queue.push(part);
        this.queued += part.length;
      }
    }
  }
  /** Up to `max` bytes, at least one unless the stream ended. */
  async some(max: number): Promise<Buffer> {
    await this.fill(1);
    const head = this.queue[0];
    if (!head) return Buffer.alloc(0);
    if (head.length <= max) {
      this.queue.shift();
      this.queued -= head.length;
      return head;
    }
    this.queue[0] = head.subarray(max);
    this.queued -= max;
    return head.subarray(0, max);
  }
  async exact(n: number): Promise<Buffer> {
    await this.fill(n);
    invariant(this.queued >= n, 'GITHUB_RESPONSE', 'GitHub archive ended early; main was not published.');
    const parts: Buffer[] = [];
    let left = n;
    while (left) {
      const part = await this.some(left);
      parts.push(part);
      left -= part.length;
    }
    return parts.length === 1 ? parts[0]! : Buffer.concat(parts, n);
  }
  async skip(n: number) {
    while (n) {
      const part = await this.some(n);
      invariant(part.length, 'GITHUB_RESPONSE', 'GitHub archive ended early; main was not published.');
      n -= part.length;
    }
  }
  /** One header block, or empty at a clean end of stream. */
  async block() {
    await this.fill(1);
    return this.queued ? this.exact(512) : Buffer.alloc(0);
  }
}

export type TarEntry = {
  path: string;
  type: 'file' | 'symlink' | 'directory' | 'other';
  size: number;
  linkname: string;
  /** Streams the entry body; unread bytes are skipped before the next entry. */
  read: (consume: (bytes: Buffer) => Promise<void>) => Promise<void>;
};
const text = (block: Buffer, start: number, length: number) => {
  const field = block.subarray(start, start + length),
    end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
};
function octal(block: Buffer, start: number, length: number) {
  const field = block.subarray(start, start + length);
  if (field[0]! & 0x80) {
    // GNU base-256 for sizes beyond 8 GiB. Safe-integer only.
    let value = field[0]! & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    invariant(Number.isSafeInteger(value), 'GITHUB_RESPONSE', 'GitHub archive entry is too large.');
    return value;
  }
  const digits = text(block, start, length).trim();
  invariant(/^[0-7]*$/.test(digits), 'GITHUB_RESPONSE', 'GitHub archive header is invalid.');
  return digits ? parseInt(digits, 8) : 0;
}
function checksum(block: Buffer) {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
  return sum === octal(block, 148, 8);
}
function pax(body: Buffer) {
  const values: Record<string, string> = {};
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(32, at);
    invariant(space > at, 'GITHUB_RESPONSE', 'GitHub archive metadata is invalid.');
    const length = Number(body.subarray(at, space).toString('ascii'));
    invariant(
      Number.isSafeInteger(length) && length > space - at && at + length <= body.length,
      'GITHUB_RESPONSE',
      'GitHub archive metadata is invalid.',
    );
    const record = body.subarray(space + 1, at + length - 1).toString('utf8'),
      equals = record.indexOf('=');
    if (equals > 0) values[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return values;
}
const padding = (size: number) => (512 - (size % 512)) % 512;

/** ustar/pax/GNU-longname reader for provider archives. Bytes are untrusted:
 * every header is checksummed and every path is rechecked by the caller. */
export async function* tarEntries(source: AsyncIterable<Uint8Array>): AsyncGenerator<TarEntry> {
  const reader = new ByteReader(source[Symbol.asyncIterator]());
  let next: Record<string, string> = {};
  while (true) {
    const block = await reader.block();
    if (!block.length || block.every(byte => byte === 0)) return;
    invariant(checksum(block), 'GITHUB_RESPONSE', 'GitHub archive header checksum differs.');
    const flag = String.fromCharCode(block[156]!),
      size = octal(block, 124, 12);
    if (flag === 'x' || flag === 'g' || flag === 'L' || flag === 'K') {
      invariant(size <= 1024 * 1024, 'GITHUB_RESPONSE', 'GitHub archive metadata is too large.');
      const body = await reader.exact(size);
      await reader.skip(padding(size));
      if (flag === 'x') next = { ...next, ...pax(body) };
      else if (flag === 'L') next = { ...next, path: text(body, 0, body.length) };
      else if (flag === 'K') next = { ...next, linkpath: text(body, 0, body.length) };
      continue;
    }
    const prefix = text(block, 345, 155),
      name = text(block, 0, 100);
    const path = next.path ?? (prefix ? `${prefix}/${name}` : name),
      linkname = next.linkpath ?? text(block, 157, 100),
      length = next.size !== undefined ? Number(next.size) : size;
    invariant(Number.isSafeInteger(length) && length >= 0, 'GITHUB_RESPONSE', 'GitHub archive size differs.');
    next = {};
    let left = length;
    const entry: TarEntry = {
      path,
      type:
        flag === '0' || flag === '\0' || flag === '7'
          ? 'file'
          : flag === '2'
            ? 'symlink'
            : flag === '5'
              ? 'directory'
              : 'other',
      size: length,
      linkname,
      read: async consume => {
        while (left) {
          const part = await reader.some(Math.min(left, 64 * 1024));
          invariant(part.length, 'GITHUB_RESPONSE', 'GitHub archive ended early; main was not published.');
          left -= part.length;
          await consume(part);
        }
      },
    };
    yield entry;
    await reader.skip(left);
    await reader.skip(padding(length));
  }
}
