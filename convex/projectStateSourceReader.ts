// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import { r2Config, r2Key, presignGet } from './r2';
import { convexFetch, networkTimeout } from './networkFetch';
import { digest } from '../src/state/hash';
import { physicalKey } from '../src/physical-manifest-binary';
import { invariant } from '../src/errors';
import { packHeaders, verifyPackRange } from '../src/object-pack-range';
import { PhysicalManifestReader, readPhysicalPin } from '../src/physical-manifest';
import type { PhysicalPin } from '../src/physical-manifest-codec';
import { physicalMetadataRuns, type PhysicalRun } from '../src/physical-manifest-runs';
export type SignedPhysicalRun = PhysicalRun & { url: string };
export type PhysicalGrantPlan = {
  state: string;
  pin: PhysicalPin;
  root: string;
  chunks: SignedPhysicalRun[];
};
/** Access is checked by the enclosing selector on every request. No repository URL or key enters this reader. */
export function stateSourceReader(projectId: Id<'hostedProjects'>) {
  const bodies = new Map<string, Promise<Uint8Array>>();
  const raw = (pin: { sha256: string; size: number; nonce?: string }) => {
    const key = physicalKey(pin.sha256, pin.nonce);
    let promise = bodies.get(key);
    if (!promise) {
      promise = (async () => {
        const response = await convexFetch(await presignGet(r2Config(), r2Key(projectId, key)), {
          redirect: 'error',
          signal: networkTimeout(20_000),
          headers: { 'accept-encoding': 'identity' },
        });
        invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Pinned physical source is unavailable.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        invariant(
          bytes.length === pin.size && digest(bytes) === pin.sha256,
          'SOURCE_HASH_MISMATCH',
          'Pinned physical source changed.',
        );
        return bytes;
      })();
      bodies.set(key, promise);
    }
    return promise.then(bytes => {
      invariant(bytes.length === pin.size, 'SOURCE_HASH_MISMATCH', 'Physical source size changed.');
      return bytes;
    });
  };
  const read = async (pin: PhysicalPin) => {
    if (!pin.pack) return raw(pin);
    const bytes = await raw({
      sha256: pin.pack.digest,
      size: pin.pack.size,
      ...(pin.pack.nonce === undefined ? {} : { nonce: pin.pack.nonce }),
    });
    packHeaders({ offset: pin.pack.offset, total: pin.pack.size }, pin.size);
    return bytes.subarray(pin.pack.offset, pin.pack.offset + pin.size);
  };
  const sign = (runs: readonly PhysicalRun[]) =>
    Promise.all(
      runs.map(async run => ({
        ...run,
        url: await presignGet(
          r2Config(),
          r2Key(projectId, physicalKey(run.digest, run.nonce)),
          run.raw ? {} : packHeaders({ offset: run.offset, total: run.total }, run.length),
        ),
      })),
    );
  return {
    read,
    sign,
    open: (state: string, pin: PhysicalPin) => PhysicalManifestReader.open(state, pin, read),
    async plan(state: string, pin: PhysicalPin): Promise<PhysicalGrantPlan | null> {
      const reader = await PhysicalManifestReader.open(state, pin, read),
        runs = await physicalMetadataRuns(reader.root.chunks);
      if (runs.length + 1 > 64) return null;
      return {
        state,
        pin,
        root: await presignGet(r2Config(), r2Key(projectId, pin.sha256)),
        chunks: await sign(runs),
      };
    },
  };
}
/** Downloaded metadata uses the same hash, size and exact-range verifier as source bodies. */
export async function readSignedPhysical(pin: PhysicalPin, url: string) {
  const range = pin.pack && { offset: pin.pack.offset, total: pin.pack.size };
  const response = await convexFetch(url, {
    redirect: 'error',
    signal: networkTimeout(20_000),
    headers: { 'accept-encoding': 'identity', ...packHeaders(range, pin.size) },
  });
  invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Selected State source is unavailable.');
  verifyPackRange(response, range, pin.size);
  return readPhysicalPin(pin, async () => new Uint8Array(await response.arrayBuffer()));
}
