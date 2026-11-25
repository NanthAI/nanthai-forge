// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { convexFetch, networkTimeout } from './networkFetch';
import type { ActionCtx } from './server';
import type { Id } from './_generated/dataModel';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
import { r2Config, r2Key, presignGet } from './r2';
import { storeSourceBytes } from './projectSourceBytes';
import { SourceIoError, transientSourceStatus } from '../src/hosted-source-io-error';
import type { SourceStepClock } from '../src/source-step-clock';
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
export function sourceStorage(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  hash: (bytes: Uint8Array) => string = digest,
  observe?: (event: 'put' | 'refused' | 'reused', pin: { sha256: string; size: number }) => void,
  reuse = false,
  clock?: SourceStepClock,
) {
  const fetchBytes = async (pin: { sha256: string; size: number }): Promise<Uint8Array> => {
    const url = await presignGet(r2Config(), r2Key(projectId, pin.sha256));
    let response: Response;
    try {
      // A pinned durable object that answers 404 may be read-after-write lag;
      // the shared bound retries it, then the exact SOURCE_UNAVAILABLE stands.
      response = await retryR2Lag(
        () => {
          clock?.request('gets');
          return convexFetch(url, {
            headers: { 'accept-encoding': 'identity' },
            redirect: 'error',
            signal: networkTimeout(20_000),
          });
        },
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
    try {
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new SourceIoError(error, 'durable-body', pin.sha256, response.status);
    }
  };
  const read = async (ref: string): Promise<Uint8Array> => {
    const pin = sourceR2Pin(ref);
    invariant(pin, 'SOURCE_HASH_MISMATCH', 'Source storage reference changed.');
    const load = () => fetchBytes(pin);
    const bytes = await (clock ? clock.readBytes(load) : load());
    invariant(
      bytes.length === pin.size && hash(bytes) === pin.sha256,
      'SOURCE_HASH_MISMATCH',
      'Durable source data changed.',
    );
    return bytes;
  };
  return {
    // The transport already verified this pin; durable cursor callers still hash here.
    async store(bytes: Uint8Array, verified?: { sha256: string; size: number }): Promise<string> {
      const pin = verified ?? { sha256: hash(bytes), size: bytes.length };
      const put = () =>
        storeSourceBytes(ctx, projectId, bytes, pin, reuse, undefined, observe, clock?.request);
      await (clock ? clock.write(put) : put());
      return `r2source:${pin.sha256}:${pin.size}`;
    },
    read,
  };
}
