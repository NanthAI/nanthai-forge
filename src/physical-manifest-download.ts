// SPDX-License-Identifier: Apache-2.0
import { PhysicalManifestReader } from './physical-manifest.js';
import { packHeaders, verifyPackRange } from './object-pack-range.js';
import { invariant } from './errors.js';
import type { PhysicalPin } from './physical-manifest-codec.js';
import type { PhysicalRun } from './physical-manifest-runs.js';
export type SignedPhysicalRun = PhysicalRun & { url: string };
export type PhysicalGrantPlan = {
  state: string;
  pin: PhysicalPin;
  root: string;
  chunks: SignedPhysicalRun[];
};
/** Only metadata pinned by the selected State's root is exposed by this operation-local reader. */
export async function downloadPhysicalManifest(
  plan: PhysicalGrantPlan,
  request: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const bodies = new Map<SignedPhysicalRun, Promise<Uint8Array>>();
  const root = await request(plan.root, { redirect: 'error', headers: { 'accept-encoding': 'identity' } });
  invariant(root.ok, 'SOURCE_UNAVAILABLE', 'Physical manifest root is unavailable.');
  const rootBytes = new Uint8Array(await root.arrayBuffer());
  const read = async (pin: PhysicalPin) => {
    if (pin.sha256 === plan.pin.sha256 && !pin.pack) return rootBytes;
    const run = plan.chunks.find(
      run =>
        run.digest === (pin.pack?.digest ?? pin.sha256) &&
        run.nonce === (pin.pack?.nonce ?? pin.nonce) &&
        (pin.pack
          ? !run.raw && run.offset <= pin.pack.offset && run.offset + run.length >= pin.pack.offset + pin.size
          : run.raw && run.length === pin.size),
    );
    invariant(run, 'SOURCE_HASH_MISMATCH', 'Manifest chunk grant is incomplete.');
    let body = bodies.get(run);
    if (!body) {
      body = (async () => {
        const range = run.raw ? undefined : { offset: run.offset, total: run.total };
        const response = await request(run.url, {
          redirect: 'error',
          headers: { 'accept-encoding': 'identity', ...packHeaders(range, run.length) },
        });
        invariant(response.ok, 'SOURCE_UNAVAILABLE', 'Physical manifest chunks are unavailable.');
        verifyPackRange(response, range, run.length);
        const bytes = new Uint8Array(await response.arrayBuffer());
        invariant(bytes.length === run.length, 'SOURCE_HASH_MISMATCH', 'Manifest grant length changed.');
        return bytes;
      })();
      bodies.set(run, body);
    }
    const bytes = await body;
    const offset = pin.pack ? pin.pack.offset - run.offset : 0;
    return bytes.subarray(offset, offset + pin.size);
  };
  return PhysicalManifestReader.open(plan.state, plan.pin, read);
}
