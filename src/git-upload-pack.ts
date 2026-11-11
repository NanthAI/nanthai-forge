// SPDX-License-Identifier: Apache-2.0
import { createHash, type Hash } from 'node:crypto';
import { ForgeError, invariant } from './errors.js';
import { networkFetch } from './network-fetch.js';

/** Git smart-HTTP protocol v2 `fetch` client for one pack: no Git binary, no
 * repository, no ref discovery. The pack bytes reach `consume` exactly as the
 * server sent them, so commit and object ids stay the host's own. */
export type PackFetch = {
  /** Repository HTTPS URL without `.git`, e.g. https://github.com/OWNER/NAME. */
  url: string;
  want: string;
  /** Additional objects in the same fetch (for a bounded page of source blobs). */
  wants?: string[];
  haves?: string[];
  /** Read token, sent only as HTTP Basic credentials. */
  token?: string | null;
  /** Abort once the pack exceeds this many bytes. */
  limitBytes: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Whole-response budget; default 8 minutes, inside the 10-minute action limit. */
  totalTimeoutMs?: number;
};
export type PackReceipt = { bytes: number; objects: number; packSha1: string };

const oid = /^[0-9a-f]{40}$/;
const encoder = new TextEncoder();
export function pktLine(text: string): Uint8Array {
  const body = encoder.encode(text);
  invariant(body.length + 4 <= 65520, 'BAD_ARGUMENT', 'A Git protocol line is too long.');
  return encoder.encode((body.length + 4).toString(16).padStart(4, '0') + text);
}
export function fetchRequest(want: string, haves: string[], wants: string[] = []): Uint8Array {
  invariant(
    [want, ...wants, ...haves].every(id => oid.test(id)),
    'BAD_ARGUMENT',
    'Select full Git commit ids.',
  );
  const lines = [
    pktLine('command=fetch\n'),
    pktLine('agent=forge\n'),
    encoder.encode('0001'),
    pktLine('ofs-delta\n'),
    pktLine('no-progress\n'),
    ...[...new Set([want, ...wants])].map(id => pktLine(`want ${id}\n`)),
    ...[...new Set(haves)].filter(id => ![want, ...wants].includes(id)).map(id => pktLine(`have ${id}\n`)),
    pktLine('done\n'),
    encoder.encode('0000'),
  ];
  const out = new Uint8Array(lines.reduce((sum, line) => sum + line.length, 0));
  let at = 0;
  for (const line of lines) {
    out.set(line, at);
    at += line.length;
  }
  return out;
}

/** Verifies a version 2/3 pack stream: header, object count and SHA-1 trailer. */
export class PackVerifier {
  private hash: Hash = createHash('sha1');
  private tail = Buffer.alloc(0);
  private header = Buffer.alloc(0);
  bytes = 0;
  objects = -1;
  update(part: Buffer) {
    this.bytes += part.length;
    if (this.header.length < 12) {
      this.header = Buffer.concat([this.header, part.subarray(0, 12 - this.header.length)]);
      if (this.header.length === 12) {
        const version = this.header.readUInt32BE(4);
        invariant(
          this.header.toString('latin1', 0, 4) === 'PACK' && (version === 2 || version === 3),
          'GIT_PACK_INVALID',
          'The Git host returned something other than a pack.',
        );
        this.objects = this.header.readUInt32BE(8);
      }
    }
    // Hash everything except the final 20 bytes, which are the trailer.
    const joined = Buffer.concat([this.tail, part]);
    const keep = Math.min(20, joined.length);
    this.hash.update(joined.subarray(0, joined.length - keep));
    this.tail = Buffer.from(joined.subarray(joined.length - keep));
  }
  finish(): PackReceipt {
    invariant(this.objects >= 0 && this.tail.length === 20, 'GIT_PACK_INVALID', 'The Git pack is truncated.');
    const sha = this.hash.digest();
    invariant(sha.equals(this.tail), 'GIT_PACK_INVALID', 'The Git pack trailer does not match its bytes.');
    return { bytes: this.bytes, objects: this.objects, packSha1: sha.toString('hex') };
  }
}

/** Demultiplexes a v2 fetch response: pkt-lines, a `packfile` section, side-band
 * channel 1 data, 2 progress (ignored), 3 a fatal message. */
export class FetchResponseParser {
  private buffer = Buffer.alloc(0);
  private section: string | null = null;
  done = false;
  constructor(private data: (part: Buffer) => void) {}
  push(chunk: Uint8Array) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (this.done || this.buffer.length < 4) return;
      const text = this.buffer.toString('latin1', 0, 4);
      invariant(/^[0-9a-f]{4}$/.test(text), 'GIT_PROTOCOL', 'The Git host sent an invalid protocol line.');
      const length = parseInt(text, 16);
      if (length === 0) {
        invariant(this.section === 'packfile', 'GIT_PROTOCOL', 'The Git host returned no pack.');
        this.done = true;
        this.buffer = this.buffer.subarray(4);
        return;
      }
      if (length === 1 || length === 2) {
        // Delimiter or response-end between sections.
        this.buffer = this.buffer.subarray(4);
        continue;
      }
      invariant(length > 4, 'GIT_PROTOCOL', 'The Git host sent an invalid protocol line.');
      if (this.buffer.length < length) return;
      const payload = this.buffer.subarray(4, length);
      this.buffer = this.buffer.subarray(length);
      if (this.section !== 'packfile') {
        const line = payload.toString('utf8').replace(/\n$/, '');
        if (line.startsWith('ERR '))
          throw new ForgeError('GIT_FETCH_REFUSED', `The Git host refused the fetch: ${line.slice(4, 200)}`);
        // Sections before the pack (acknowledgments, shallow-info) carry no bytes we keep.
        if (['packfile', 'acknowledgments', 'shallow-info', 'wanted-refs'].includes(line))
          this.section = line;
        continue;
      }
      const band = payload[0];
      if (band === 1) this.data(Buffer.from(payload.subarray(1)));
      else if (band === 3)
        throw new ForgeError(
          'GIT_FETCH_REFUSED',
          `The Git host stopped the fetch: ${payload.subarray(1).toString('utf8').slice(0, 200)}`,
        );
      else invariant(band === 2, 'GIT_PROTOCOL', 'The Git host sent an unknown side band.');
    }
  }
  end() {
    invariant(this.done, 'GIT_PROTOCOL', 'The Git fetch response ended early.');
  }
}

export class PackLimitError extends ForgeError {
  constructor(limitBytes: number) {
    super(
      'HISTORY_OVER_LIMIT',
      `The repository history is larger than this project's history limit of ${limitBytes} bytes.`,
    );
  }
}

/** One POST; `consume` receives verified-on-finish pack bytes in arrival order and
 * may apply backpressure. Throws PackLimitError past `limitBytes`. */
export async function fetchGitPack(
  input: PackFetch,
  consume: (part: Buffer) => Promise<void>,
): Promise<PackReceipt> {
  invariant(/^https:\/\/[^/@\s]+\/[^@\s]+$/.test(input.url), 'BAD_ARGUMENT', 'Select an HTTPS Git URL.');
  const verifier = new PackVerifier();
  const pending: Buffer[] = [];
  // Packets are verified, limit-checked and consumed one at a time, in order.
  const parser = new FetchResponseParser(part => void pending.push(part));
  const headers: Record<string, string> = {
    'content-type': 'application/x-git-upload-pack-request',
    accept: 'application/x-git-upload-pack-result',
    'git-protocol': 'version=2',
    'user-agent': 'git/forge',
  };
  if (input.token)
    headers.authorization = `Basic ${Buffer.from(`x-access-token:${input.token}`).toString('base64')}`;
  const response = await networkFetch(
    `${input.url}.git/git-upload-pack`,
    {
      method: 'POST',
      headers,
      body: Buffer.from(fetchRequest(input.want, input.haves ?? [], input.wants)),
      redirect: 'error',
      ...(input.signal ? { signal: input.signal } : {}),
    },
    { request: input.fetch, retries: 0, totalTimeoutMs: input.totalTimeoutMs ?? 8 * 60_000 },
  );
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new ForgeError(
      response.status === 401 || response.status === 403 || response.status === 404
        ? 'GIT_FETCH_UNAUTHORIZED'
        : 'GIT_FETCH_FAILED',
      `The Git host answered ${response.status} to the Git fetch.`,
    );
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(value);
      while (pending.length) {
        const part = pending.shift()!;
        verifier.update(part);
        if (verifier.bytes > input.limitBytes) throw new PackLimitError(input.limitBytes);
        await consume(part);
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  parser.end();
  return verifier.finish();
}
