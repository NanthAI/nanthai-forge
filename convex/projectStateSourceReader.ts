// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import { r2Config, r2Key, presignGet } from './r2';
import { convexFetch, networkTimeout } from './networkFetch';
import { NetworkTransportError } from '../src/network-fetch';
import { sha256Hex } from '../src/verified-blob';
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
/** One request's storage-read budget (incident e62d834b, 2026-11-20): every read gets at most the
 * time left, so slow object storage fails the request with a storage cause before its caller's own
 * timeout, instead of several 20 s reads in a row outliving it. Without a budget, each read keeps
 * its own 20 s bound. */
export type SourceReadBudget = { readonly deadline: number };
const READ_MS = 20_000,
  READ_FLOOR_MS = 1_000;
export const sourceBudgetSpent = (budget?: SourceReadBudget) =>
  !!budget && budget.deadline - Date.now() < READ_FLOOR_MS;
function readSignal(budget?: SourceReadBudget) {
  if (sourceBudgetSpent(budget))
    throw new NetworkTransportError(
      'EXCHANGE_REQUEST_TIMEOUT',
      "Source storage reads used this request's time budget.",
    );
  return networkTimeout(budget ? Math.min(READ_MS, budget.deadline - Date.now()) : READ_MS);
}
/** Access is checked by the enclosing selector on every request. No repository URL or key enters this reader. */
export function stateSourceReader(projectId: Id<'hostedProjects'>, budget?: SourceReadBudget) {
  const bodies = new Map<string, Promise<Uint8Array>>();
  const raw = (pin: { sha256: string; size: number; nonce?: string }) => {
    const key = physicalKey(pin.sha256, pin.nonce);
    let promise = bodies.get(key);
    if (!promise) {
      promise = (async () => {
        const response = await convexFetch(await presignGet(r2Config(), r2Key(projectId, key)), {
          redirect: 'error',
          signal: readSignal(budget),
          headers: { 'accept-encoding': 'identity' },
        });
        invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Pinned physical source is unavailable.');
        const bytes = new Uint8Array(await response.arrayBuffer());
        invariant(
          bytes.length === pin.size && (await sha256Hex(bytes)) === pin.sha256,
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
export async function readSignedPhysical(pin: PhysicalPin, url: string, budget?: SourceReadBudget) {
  const range = pin.pack && { offset: pin.pack.offset, total: pin.pack.size };
  const response = await convexFetch(url, {
    redirect: 'error',
    signal: readSignal(budget),
    headers: { 'accept-encoding': 'identity', ...packHeaders(range, pin.size) },
  });
  invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Selected State source is unavailable.');
  verifyPackRange(response, range, pin.size);
  return readPhysicalPin(pin, async () => new Uint8Array(await response.arrayBuffer()));
}
