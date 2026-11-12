// SPDX-License-Identifier: Apache-2.0
import { sha256Hex } from './verified-blob.js';
import { invariant } from './errors.js';
import {
  physicalBucket,
  encodePhysicalEntries,
  type PhysicalEntry,
  type PhysicalPin,
} from './physical-manifest-codec.js';
import { physicalKey } from './physical-manifest-binary.js';
import { packRunMaxBytes } from './object-pack-range.js';
import { encodePhysicalRoot } from './physical-manifest-root.js';
import type { PhysicalManifestReader, PhysicalManifest } from './physical-manifest.js';
/** Extend only the changed membership buckets. A seed is the same encoder with
 * no parent; its caller must explicitly select the one-time compose seed step.
 * State membership comes from verified State bytes, never a descriptor inventory. */
export async function writePhysicalManifest({
  state,
  members,
  parent,
  parentMembers,
  describe,
  put,
}: {
  state: string;
  members: readonly string[];
  parent: PhysicalManifestReader | null;
  parentMembers?: readonly string[];
  describe: (ids: string[]) => Promise<(PhysicalEntry | null)[]>;
  put: (bytes: Uint8Array) => Promise<PhysicalPin>;
}) {
  const store = async (bytes: Uint8Array) => {
    const pin = await put(bytes);
    invariant(
      !pin.pack && pin.size === bytes.length && pin.sha256 === (await sha256Hex(bytes)),
      'SOURCE_HASH_MISMATCH',
      'Physical manifest publication changed its hash or size.',
    );
    return { sha256: pin.sha256, size: pin.size };
  };
  // Only verified State membership proves a bucket unchanged, including FPR1 parents.
  if (parent && !parentMembers) return null;
  const group = (values: readonly string[]) => {
    const buckets = new Map<number, string[]>();
    for (const id of values) {
      const bucket = physicalBucket(id),
        ids = buckets.get(bucket) ?? [];
      ids.push(id);
      buckets.set(bucket, ids);
    }
    for (const ids of buckets.values()) {
      ids.sort();
      let kept = 0;
      for (const id of ids) if (!kept || ids[kept - 1] !== id) ids[kept++] = id;
      ids.length = kept;
    }
    return new Map([...buckets].sort(([a], [b]) => a - b));
  };
  const buckets = group(members),
    before = group(parentMembers ?? []);
  const chunks: PhysicalManifest['chunks'] = [],
    changed: { bucket: number; ids: string[]; entries: (PhysicalEntry | null)[] }[] = [];
  const prior = new Map(parent?.root.chunks.map(chunk => [chunk.bucket, chunk]) ?? []);
  for (const [bucket, ids] of buckets) {
    const old = prior.get(bucket),
      previous = before.get(bucket);
    if (old && previous?.length === ids.length && ids.every((id, index) => previous[index] === id)) {
      const pin = { ...old };
      delete pin.members;
      chunks.push(pin);
    } else {
      // Verified parent membership already proves which digests are new. Read
      // parent bindings only for survivors; a replaced bucket needs no old bytes.
      let at = 0;
      const survivors = ids.filter(id => {
        while (previous?.[at] && previous[at]! < id) at++;
        return previous?.[at] === id;
      });
      const bindings = parent && survivors.length ? await parent.lookup(survivors) : [];
      const known = new Map(survivors.map((id, index) => [id, bindings[index] ?? null]));
      changed.push({ bucket, ids, entries: ids.map(id => known.get(id) ?? null) });
    }
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
  const groups = new Map<string, typeof chunks>();
  for (const chunk of chunks) {
    const key = physicalKey(chunk.pack?.digest ?? chunk.sha256, chunk.pack?.nonce),
      pins = groups.get(key) ?? [];
    pins.push(chunk);
    groups.set(key, pins);
  }
  const carryBudget = Math.ceil((parent?.root.chunks.reduce((sum, chunk) => sum + chunk.size, 0) ?? 0) / 63);
  let carriedBytes = 0;
  const carries: { bucket: number; bytes: Uint8Array }[] = [];
  const newPack = changed.length > 0 || groups.size > 63;
  const candidates = [...groups]
    .map(([key, pins]) => ({ key, pins, size: pins.reduce((sum, pin) => sum + pin.size, 0) }))
    .sort((a, b) => a.size - b.size || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const candidate of candidates) {
    if (groups.size + Number(newPack) <= 63 || carriedBytes + candidate.size > carryBudget) break;
    for (const chunk of candidate.pins)
      carries.push({ bucket: chunk.bucket, bytes: await parent!.readChunk(chunk.bucket) });
    carriedBytes += candidate.size;
    groups.delete(candidate.key);
  }
  chunks.length = 0;
  for (const pins of groups.values()) chunks.push(...pins);
  const pending = [...encoded, ...carries].sort((a, b) => a.bucket - b.bucket);
  for (let start = 0; start < pending.length;) {
    let end = start,
      size = 0;
    while (end < pending.length && size + pending[end]!.bytes.length <= packRunMaxBytes)
      size += pending[end++]!.bytes.length;
    invariant(end > start, 'SOURCE_HASH_MISMATCH', 'Physical manifest bucket exceeds its pack.');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (let index = start; index < end; index++) {
      bytes.set(pending[index]!.bytes, offset);
      offset += pending[index]!.bytes.length;
    }
    const pack = await store(bytes);
    offset = 0;
    for (let index = start; index < end; index++) {
      const chunk = pending[index]!;
      chunks.push({
        bucket: chunk.bucket,
        sha256: await sha256Hex(chunk.bytes),
        size: chunk.bytes.length,
        pack: { digest: pack.sha256, size: pack.size, offset },
      });
      offset += chunk.bytes.length;
    }
    start = end;
  }
  chunks.sort((a, b) => a.bucket - b.bucket);
  const root: PhysicalManifest = { schema: 1, kind: 'forge-physical-manifest', state, chunks };
  return {
    pin: await store(encodePhysicalRoot(root)),
    root,
    described: missing.length,
    changedChunks: encoded.length,
    carriedBytes,
    carryBudget,
  };
}

/** Compose alone repairs working roots before they become Candidate roots.
 * Unchanged pins and every live bucket's exact bytes survive the repair. */
export async function repairPhysicalRoot({
  state,
  head,
  main,
  put,
}: {
  state: string;
  head: PhysicalManifestReader;
  main: PhysicalManifest;
  put: (bytes: Uint8Array) => Promise<PhysicalPin>;
}) {
  invariant(state === head.root.state, 'SOURCE_HASH_MISMATCH', 'Repair selects another State.');
  const key = (pin: PhysicalManifest['chunks'][number]) =>
    physicalKey(pin.pack?.digest ?? pin.sha256, pin.pack?.nonce);
  const accepted = new Set(main.chunks.map(key)),
    groups = new Map<string, PhysicalManifest['chunks']>();
  for (const chunk of head.root.chunks) groups.set(key(chunk), [...(groups.get(key(chunk)) ?? []), chunk]);
  const failing = [...groups].filter(
    ([id, pins]) =>
      !accepted.has(id) &&
      pins[0]!.pack &&
      pins.reduce((sum, pin) => sum + pin.size, 0) !== pins[0]!.pack!.size,
  );
  if (!failing.length) return null;
  const moved = failing.flatMap(([, pins]) => pins).sort((a, b) => a.bucket - b.bucket);
  const bytes = await head.readChunks(moved.map(pin => pin.bucket));
  const gone = new Set(moved.map(pin => pin.bucket)),
    chunks = head.root.chunks.filter(pin => !gone.has(pin.bucket));
  const store = async (body: Uint8Array) => {
    const pin = await put(body);
    invariant(
      !pin.pack && pin.size === body.length && pin.sha256 === (await sha256Hex(body)),
      'SOURCE_HASH_MISMATCH',
      'Physical manifest publication changed its hash or size.',
    );
    return { sha256: pin.sha256, size: pin.size };
  };
  let movedBytes = 0;
  for (let start = 0; start < moved.length;) {
    let end = start,
      size = 0;
    while (end < moved.length && size + moved[end]!.size <= packRunMaxBytes) size += moved[end++]!.size;
    invariant(end > start, 'SOURCE_HASH_MISMATCH', 'Physical manifest bucket exceeds its pack.');
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of moved.slice(start, end)) {
      body.set(bytes.get(chunk.bucket)!, offset);
      offset += chunk.size;
    }
    const pack = await store(body);
    offset = 0;
    for (const chunk of moved.slice(start, end)) {
      chunks.push({
        bucket: chunk.bucket,
        sha256: chunk.sha256,
        size: chunk.size,
        pack: { digest: pack.sha256, size: pack.size, offset },
      });
      offset += chunk.size;
    }
    movedBytes += size;
    start = end;
  }
  chunks.sort((a, b) => a.bucket - b.bucket);
  const root: PhysicalManifest = { schema: 1, kind: 'forge-physical-manifest', state, chunks };
  return { root, pin: await store(encodePhysicalRoot(root)), movedBytes, failingKeys: failing.length };
}
