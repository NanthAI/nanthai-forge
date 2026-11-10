// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { presignGet, r2Config, r2Key } from './r2';
import { packRange, packHeaders, type ObjectPack } from '../src/object-pack-range';
import type { SignedDownload } from '../src/blob-download-format';
type Pin = { sha256: string; size: number; pack?: ObjectPack };
/** A bounded projection from verified worker output, never accepted from client plans.
 * Larger/legacy recipes keep their existing tree reader; this is not a source limit. */
export function validateRecipeClosure(object: { size: number }, leaves: Pin[]) {
  const sizes = new Map(leaves.map(leaf => [leaf.sha256, leaf.size]));
  invariant(
    leaves.every(leaf => sizes.get(leaf.sha256) === leaf.size) &&
      leaves.length > 0 &&
      leaves.length <= 100 &&
      leaves.every(
        leaf =>
          /^[a-f0-9]{64}$/.test(leaf.sha256) &&
          Number.isSafeInteger(leaf.size) &&
          leaf.size >= 0 &&
          leaf.size <= 1024 * 1024,
      ) &&
      leaves.reduce((n, leaf) => n + leaf.size, 0) === object.size,
    'SOURCE_HASH_MISMATCH',
    'Recipe closure differs from its logical binding.',
  );
}
/** Authorization is owned by the enclosing current-access/job-fenced operation.
 * Every leaf is raw in this project's immutable namespace, validated on publication;
 * signing requires no per-leaf lookup or subsequent describe/sign round trip. */
export async function signRecipeClosure(row: {
  projectId: Id<'hostedProjects'>;
  size: number;
  recipeClosure?: Pin[];
}): Promise<SignedDownload[] | undefined> {
  if (!row.recipeClosure) return undefined;
  validateRecipeClosure(row, row.recipeClosure);
  const config = r2Config();
  const signed = new Map<string, Promise<SignedDownload>>();
  return Promise.all(
    row.recipeClosure.map(leaf => {
      let value = signed.get(leaf.sha256);
      if (!value) {
        const range = packRange(leaf);
        value = presignGet(
          config,
          r2Key(row.projectId, leaf.pack?.digest ?? leaf.sha256),
          packHeaders(range, leaf.size),
        ).then(url => ({
          digest: leaf.sha256,
          size: leaf.size,
          url,
          ...(range ? { range } : {}),
        }));
        signed.set(leaf.sha256, value);
      }
      return value;
    }),
  );
}
