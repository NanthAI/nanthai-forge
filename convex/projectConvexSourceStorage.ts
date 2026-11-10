// SPDX-License-Identifier: Apache-2.0
import { convexFetch, networkTimeout } from './networkFetch';
import type { ActionCtx } from './server';
import type { Id } from './_generated/dataModel';
import { makeFunctionReference } from 'convex/server';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
import { r2Config, r2Key, presignGet } from './r2';
import { storeSourceBytes } from './projectSourceBytes';
import { SourceIoError, transientSourceStatus } from '../src/hosted-source-io-error';
import { retryR2Lag } from '../src/hosted-r2-retry';

/** Durable cursor/task data. Project-scoped R2 references carry exact byte pins
 * and need no per-object RPC. Legacy Convex references require an ownership
 * query against a live project row before any byte read. */
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
        const owned = await ctx.runQuery(
          makeFunctionReference<'query'>('projectConvexSourceOwnership:owns'),
          { projectId, ref },
        );
        invariant(
          owned,
          'SOURCE_REF_UNOWNED',
          'Durable source reference has no owner in this project, so this saved continuation cannot resume. ' +
            'Start the operation again from its input; Forge never reads an unowned legacy reference.',
        );
        const blob = await ctx.storage.get(ref as Id<'_storage'>);
        invariant(blob, 'SOURCE_UNAVAILABLE', 'Durable source data is absent.');
        return new Uint8Array(await blob.arrayBuffer());
      }
      const url = await presignGet(r2Config(), r2Key(projectId, pin.sha256));
      let response: Response;
      try {
        // A pinned durable object that answers 404 may be read-after-write lag;
        // the shared bound retries it, then the exact SOURCE_UNAVAILABLE stands.
        response = await retryR2Lag(
          () =>
            convexFetch(url, {
              headers: { 'accept-encoding': 'identity' },
              redirect: 'error',
              signal: networkTimeout(20_000),
            }),
          lagged => lagged.status === 404,
          lagged => lagged.body?.cancel().catch(() => {}),
        );
      } catch (error) {
        throw new SourceIoError(error, 'durable-headers', pin.sha256);
      }
      if (transientSourceStatus(response.status)) {
        await response.body?.cancel().catch(() => {});
        throw new SourceIoError(null, 'durable-headers', pin.sha256, response.status);
      }
      invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Durable source download failed.');
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        throw new SourceIoError(error, 'durable-body', pin.sha256, response.status);
      }
      invariant(
        bytes.length === pin.size && digest(bytes) === pin.sha256,
        'SOURCE_HASH_MISMATCH',
        'Durable source data changed.',
      );
      return bytes;
    },
  };
}
