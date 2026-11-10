// SPDX-License-Identifier: Apache-2.0
import { convexFetch, networkTimeout } from './networkFetch';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { r2Config, r2Key, presignGet } from './r2';
import { storeSourceBytes } from './projectSourceBytes';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';
import { retryR2Lag } from '../src/hosted-r2-retry';
import type { SegmentStore } from '../src/state-tree-store';

/** Tree segments in R2 under the project's own prefix, read by their deterministic key: a tree
 * walk makes no Convex call. One store serves one action. Whole segments it fetched from R2 are
 * kept for that action (they are immutable and content-addressed); bytes it only wrote are not,
 * so a read-back always sees what R2 holds. */
export function r2SegmentStore(ctx: Pick<ActionCtx, 'storage'>, projectId: Id<'hostedProjects'>) {
  const config = r2Config(),
    fetched = new Map<string, Promise<Uint8Array>>(),
    written: { sha256: string; size: number; r2Key: string }[] = [],
    stats = { gets: 0, getBytes: 0, puts: 0, putBytes: 0 };
  const read = async (id: string, range?: { offset: number; length: number }) => {
    invariant(/^[a-f0-9]{64}$/.test(id), 'SOURCE_HASH_MISMATCH', 'A tree segment id is invalid.');
    const headers: Record<string, string> = range
        ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` }
        : {},
      url = await presignGet(config, r2Key(projectId, id), headers);
    // A segment this project just wrote may answer 404 once (read-after-write lag).
    const response = await retryR2Lag(
      () =>
        convexFetch(url, {
          headers: { 'accept-encoding': 'identity', ...headers },
          redirect: 'error',
          signal: networkTimeout(15_000),
        }),
      lagged => lagged.status === 404,
      lagged => lagged.body?.cancel().catch(() => {}),
    );
    if (response.status !== (range ? 206 : 200)) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    stats.gets++;
    stats.getBytes += bytes.length;
    return bytes;
  };
  const whole = (id: string) => {
    let bytes = fetched.get(id);
    if (!bytes) {
      bytes = read(id).then(found => {
        invariant(found, 'SOURCE_UNAVAILABLE', 'A stored source tree segment is unavailable.');
        return found;
      });
      fetched.set(id, bytes);
      bytes.catch(() => fetched.delete(id));
    }
    return bytes;
  };
  const store: SegmentStore = {
    get: whole,
    async getRange(id, offset, length) {
      const held = fetched.get(id);
      if (held) return (await held).subarray(offset, offset + length);
      const bytes = await read(id, { offset, length });
      invariant(
        bytes?.length === length,
        'SOURCE_UNAVAILABLE',
        'A stored source tree segment is unavailable.',
      );
      return bytes;
    },
    async put(bytes) {
      const pin = { sha256: digest(bytes), size: bytes.length },
        stored = await storeSourceBytes(ctx, projectId, bytes, pin);
      invariant('r2Key' in stored, 'SOURCE_JOB_INVALID', 'Tree segments are stored in R2.');
      stats.puts++;
      stats.putBytes += bytes.length;
      written.push({ ...pin, r2Key: stored.r2Key });
      return pin.sha256;
    },
  };
  return {
    store,
    /** Segments this action wrote: each needs its object row (an output of the step's commit). */
    written,
    stats,
    /** A raw object under the project's own key, digest-checked; undefined when it is not stored
     * that way (an upload-pack member or a recipe has no key of its own). */
    async direct(pin: { sha256: string; size: number }): Promise<Uint8Array | undefined> {
      const bytes = await read(pin.sha256).catch(() => null);
      return bytes && bytes.length === pin.size && digest(bytes) === pin.sha256 ? bytes : undefined;
    },
  };
}
