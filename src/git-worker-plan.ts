// SPDX-License-Identifier: Apache-2.0
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/** Large-pack byte path (Issue 09367fb2): a Git session whose clone pack is over the
 * Convex response limit is redirected to a Cloudflare Worker that streams R2 bytes.
 * Pure and portable (Convex V8 and Node): signed session tokens, R2 part ranges and the
 * plan the Worker executes. The Worker never holds R2 credentials or a signing key. */

/** Content type of a byte plan; only Convex sends it, only the Worker reads it. */
export const bytePlanType = 'application/x-forge-git-byte-plan';
/** Set by the Worker on requests it forwards to the direct /git/ route (git cloned the
 * Worker's address). It only selects a byte plan instead of a streamed pack for a large
 * fetch; access is checked from the presented login exactly as without it. */
export const workerViaHeader = 'x-forge-git-worker';
/** A redirected session token lives 5 minutes; every request rechecks current access. */
export const workerTokenMs = 5 * 60_000;
/** The Worker makes at most this many R2 reads per pack (Workers Free: 1,000 reads of
 * Cloudflare services per request). */
export const maxPlanParts = 900;

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
const unb64url = (text: string) =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));

/** Signing key for session tokens, derived from a backend secret with its own domain. */
export const workerTokenKey = (secret: string) =>
  hmac(sha256, utf8ToBytes(secret), utf8ToBytes('forge-git-worker-token-v1'));

/** `p` project id, `c` Forge CLI credential id ('' anonymous), `e` expiry (ms). */
export type WorkerSession = { p: string; c: string; e: number };
export function signWorkerToken(session: WorkerSession, key: Uint8Array) {
  const body = b64url(utf8ToBytes(JSON.stringify(session)));
  return `${body}.${b64url(hmac(sha256, key, utf8ToBytes(body)))}`;
}
/** The session, or null for a forged, malformed or expired token. */
export function verifyWorkerToken(token: string, key: Uint8Array, now = Date.now()): WorkerSession | null {
  if (token.length > 1024) return null;
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  let given: Uint8Array;
  try {
    given = unb64url(mac);
  } catch {
    return null;
  }
  const expected = hmac(sha256, key, utf8ToBytes(body));
  let difference = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) difference |= (given[i] ?? 0) ^ expected[i]!;
  if (difference) return null;
  try {
    const session = JSON.parse(new TextDecoder().decode(unb64url(body))) as WorkerSession;
    if (typeof session.p !== 'string' || typeof session.c !== 'string' || typeof session.e !== 'number')
      return null;
    return session.e > now ? session : null;
  } catch {
    return null;
  }
}

/** One R2 read: a whole chunk, or bytes [start, end) of it. */
export type ChunkPart = { chunk: number; start: number; end: number; whole: boolean };
/** R2 reads for bytes [from, to) of a pack stored as consecutive chunks. */
export function chunkParts(sizes: number[], from: number, to: number): ChunkPart[] {
  const parts: ChunkPart[] = [];
  let offset = 0;
  sizes.forEach((size, chunk) => {
    const start = Math.max(from, offset) - offset,
      end = Math.min(to, offset + size) - offset;
    if (end > start) parts.push({ chunk, start, end, whole: start === 0 && end === size });
    offset += size;
  });
  return parts;
}

/** What the Worker streams: `head`, then each part's bytes in order (whole object, or
 * `length` bytes from `offset`), then `tail`. Keys are stored-object keys of the project. */
export type BytePlan = {
  head: string;
  parts: { key: string; offset?: number; length?: number }[];
  tail: string;
  bytes: number;
};
export const planBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Protocol v2 sends pack bytes as side-band pkt-lines (band 1), which the Worker cannot
 * write within its CPU limit, so a pack served over v2 is framed once into its own R2 copy
 * (Issue 7c36abfb). The first frame holds exactly the 12-byte pack header and the last
 * exactly the 20-byte trailer: a joined set drops both by byte range, like raw packs. */
export const framedHead = 4 + 1 + 12;
export const framedTail = 4 + 1 + 20;
/** Side-band data bytes per frame (a 65,520-byte pkt-line). */
const frameData = 65515;
export const framedBytes = (bytes: number) => {
  const body = bytes - 32;
  return framedHead + framedTail + body + Math.ceil(body / frameData) * 5;
};
/** Frames one pack's bytes, pushed in order in parts of any size, into band-1 pkt-lines.
 * Holds one frame (at most 65,520 bytes) between pushes. */
export class PackFramer {
  private start = 0;
  private filled = 0;
  private frame = new Uint8Array(0);
  constructor(private bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 32) throw new Error('A Git pack is at least 32 bytes.');
    this.open();
  }
  private open() {
    const end =
      this.start < 12
        ? 12
        : this.start >= this.bytes - 20
          ? this.bytes
          : Math.min(this.start + frameData, this.bytes - 20);
    const size = end - this.start + 5;
    this.frame = new Uint8Array(size);
    for (let i = 0; i < 4; i++) this.frame[i] = size.toString(16).padStart(4, '0').charCodeAt(i);
    this.frame[4] = 1;
    this.filled = 0;
  }
  /** Complete frames for these bytes, in order. */
  push(part: Uint8Array): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let at = 0; at < part.length;) {
      if (this.start >= this.bytes) throw new Error('A stored pack is longer than its record.');
      const take = Math.min(part.length - at, this.frame.length - 5 - this.filled);
      this.frame.set(part.subarray(at, at + take), 5 + this.filled);
      this.filled += take;
      at += take;
      if (this.filled === this.frame.length - 5) {
        out.push(this.frame);
        this.start += this.filled;
        if (this.start < this.bytes) this.open();
      }
    }
    return out;
  }
  /** Throws unless every byte of the pack was pushed. */
  end() {
    if (this.start !== this.bytes) throw new Error('A stored pack is shorter than its record.');
  }
}
