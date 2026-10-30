// SPDX-License-Identifier: Apache-2.0
'use node';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { r2Config, r2Key, presignGet } from './r2';
import { storeSourceBytes } from './projectSourceBytes';

/** Internal, project-bound content references for durable cursor/task data. The
 * reference carries exact byte pins, so neither storage nor reads need an RPC
 * per object. Existing Convex references remain readable after the cutover. */
export function sourceR2Pin(ref: string) {
  const match = /^r2source:([a-f0-9]{64}):(0|[1-9][0-9]*)$/.exec(ref);
  if (!match) return null;
  const size = Number(match[2]);
  invariant(Number.isSafeInteger(size), 'SOURCE_HASH_MISMATCH', 'Source storage size changed.');
  return { sha256: match[1]!, size };
}
export function sourceStorage(ctx: ActionCtx, projectId: Id<'hostedProjects'>) {
  return {
    async store(bytes: Uint8Array): Promise<string> {
      const pin = { sha256: digest(bytes), size: bytes.length };
      const stored = await storeSourceBytes(ctx, projectId, bytes, pin);
      return 'r2Key' in stored ? `r2source:${pin.sha256}:${pin.size}` : stored.storageId;
    },
    async read(ref: string): Promise<Uint8Array> {
      const pin = sourceR2Pin(ref);
      if (!pin) {
        invariant(!ref.startsWith('r2source:'), 'SOURCE_HASH_MISMATCH', 'Source storage reference changed.');
        const blob = await ctx.storage.get(ref as Id<'_storage'>);
        invariant(blob, 'SOURCE_UNAVAILABLE', 'Durable source data is absent.');
        return new Uint8Array(await blob.arrayBuffer());
      }
      const response = await fetch(await presignGet(r2Config(), r2Key(projectId, pin.sha256)), {
        headers: { 'accept-encoding': 'identity' },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Durable source download failed.');
      const bytes = new Uint8Array(await response.arrayBuffer());
      invariant(
        bytes.length === pin.size && digest(bytes) === pin.sha256,
        'SOURCE_HASH_MISMATCH',
        'Durable source data changed.',
      );
      return bytes;
    },
  };
}
