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
