// SPDX-License-Identifier: Apache-2.0
import { presign as sign, type PresignInput } from '../src/r2-presign.js';
import { storageWritesAvailable } from './legacyStoragePause';
export type { PresignInput };

/** R2 requests this isolate has signed (Issue 3e3f9fe6): every R2 request needs a URL signed here, so
 * the signing seam is the one place that counts them with no extra call. Class A (writes and listings)
 * costs ten times class B (reads and heads); deletes are free. `put` sums the signed content lengths. A
 * function reads the counter before and after its work and keeps the difference; nothing is stored. */
export type R2Counts = { a: number; b: number; put: number };
let sequence = 0;
const signed: R2Counts = { a: 0, b: 0, put: 0 };
export const r2Counts = (): R2Counts => ({ ...signed });
function countRequest(input: PresignInput) {
  if (input.method === 'DELETE') return;
  if (input.method === 'GET' && !input.query?.['list-type']) signed.b++;
  else if (input.method === 'HEAD') signed.b++;
  else {
    signed.a++;
    const length = Number(input.headers?.['content-length']);
    if (Number.isSafeInteger(length) && length > 0) signed.put += length;
  }
}
/** Reads stay available during the approved dev pause. Already issued external
 * PUT URLs cannot be revoked; their database publication is paused separately. */
export function presign(input: PresignInput) {
  if (input.method !== 'GET' && input.method !== 'HEAD') storageWritesAvailable();
  const before = r2Counts();
  countRequest(input);
  // Durations/counters only: no URL, object path, credential or source body is logged. The
  // provider attaches the actual calling function and execution identity to this line.
  const projectId =
    (input.path.match(/\/v1\/p\/([^/]+)\//) ?? input.query?.prefix?.match(/^v1\/p\/([^/]+)\//))?.[1] ?? null;
  console.log(
    `FORGE_R2_COUNT ${JSON.stringify({
      projectId,
      sequence: ++sequence,
      a: signed.a - before.a,
      b: signed.b - before.b,
      put: signed.put - before.put,
      deletes: input.method === 'DELETE' ? 1 : 0,
    })}`,
  );
  return sign(input);
}
