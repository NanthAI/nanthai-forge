// SPDX-License-Identifier: Apache-2.0
import { digest } from './state/hash.js';
import { invariant } from './errors.js';
import {
  physicalBucket,
  encodePhysicalEntries,
  type PhysicalEntry,
  type PhysicalPin,
} from './physical-manifest-codec.js';
import { encodePhysicalRoot } from './physical-manifest-root.js';
import type { PhysicalManifestReader, PhysicalManifest } from './physical-manifest.js';
/** Extend only the changed membership buckets. A seed is the same encoder with
 * no parent; its caller must explicitly select the one-time compose seed step.
 * State membership comes from verified State bytes, never a descriptor inventory. */
export async function writePhysicalManifest({
  state,
  members,
  parent,
  describe,
  put,
}: {
  state: string;
  members: readonly string[];
  parent: PhysicalManifestReader | null;
  describe: (ids: string[]) => Promise<(PhysicalEntry | null)[]>;
  put: (bytes: Uint8Array) => Promise<PhysicalPin>;
}) {
  const store = async (bytes: Uint8Array) => {
    const pin = await put(bytes);
    invariant(
      !pin.pack && pin.size === bytes.length && pin.sha256 === digest(bytes),
      'SOURCE_HASH_MISMATCH',
      'Physical manifest publication changed its hash or size.',
    );
    return { sha256: pin.sha256, size: pin.size };
  };
  const buckets = new Map<number, string[]>();
  for (const id of [...new Set(members)].sort()) {
    const bucket = physicalBucket(id),
      group = buckets.get(bucket) ?? [];
    group.push(id);
    buckets.set(bucket, group);
  }
  const chunks: PhysicalManifest['chunks'] = [],
    changed: { bucket: number; ids: string[]; members: string; entries: (PhysicalEntry | null)[] }[] = [];
  const prior = new Map(parent?.root.chunks.map(chunk => [chunk.bucket, chunk]) ?? []);
  for (const [bucket, ids] of buckets) {
    const fingerprint = digest(ids.join('')),
      old = prior.get(bucket);
    if (old?.members === fingerprint) chunks.push(old);
    else
      changed.push({
        bucket,
        ids,
        members: fingerprint,
        entries: parent ? await parent.lookup(ids) : ids.map(() => null),
      });
  }
  const missing = [
    ...new Set(changed.flatMap(chunk => chunk.ids.filter((_id, index) => !chunk.entries[index]))),
  ];
  const found = missing.length ? await describe(missing) : [];
  invariant(
    found.length === missing.length &&
      found.every((entry, index) => !entry || entry.sha256 === missing[index]),
    'SOURCE_HASH_MISMATCH',
    'Physical manifest descriptors changed identity or order.',
  );
  // Legacy non-R2 objects retain the catalog path, rather than blocking source
  // work or silently writing a partial physical manifest.
  if (found.some(entry => !entry)) return null;
  const entries = new Map(found.map(entry => [entry!.sha256, entry!]));
  const encoded = changed.map(chunk => ({
    ...chunk,
    bytes: encodePhysicalEntries(chunk.ids.map((id, index) => chunk.entries[index] ?? entries.get(id)!)),
  }));
  if (encoded.length) {
    const bytes = new Uint8Array(encoded.reduce((sum, chunk) => sum + chunk.bytes.length, 0));
    let offset = 0;
    for (const chunk of encoded) {
      bytes.set(chunk.bytes, offset);
      offset += chunk.bytes.length;
    }
    const pack = await store(bytes);
    offset = 0;
    for (const chunk of encoded) {
      chunks.push({
        bucket: chunk.bucket,
        members: chunk.members,
        sha256: digest(chunk.bytes),
        size: chunk.bytes.length,
        pack: { digest: pack.sha256, size: pack.size, offset },
      });
      offset += chunk.bytes.length;
    }
  }
  chunks.sort((a, b) => a.bucket - b.bucket);
  const root: PhysicalManifest = { schema: 1, kind: 'forge-physical-manifest', state, chunks };
  return {
    pin: await store(encodePhysicalRoot(root)),
    root,
    described: missing.length,
    changedChunks: encoded.length,
  };
}
