// SPDX-License-Identifier: Apache-2.0
import type { NativeSource } from './native-source.js';
import type { DownloadPin } from './blob-download-format.js';
import { physicalArchivePageSchema, type PhysicalArchiveEntry } from './physical-source-archive-format.js';
import { physicalManifestSchema, type PhysicalManifest } from './physical-manifest.js';
import { decodePhysicalRoot } from './physical-manifest-root.js';
import { physicalKey } from './physical-manifest-binary.js';
import { digest } from './hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { invariant } from './errors.js';

/** One whole immutable object per key, not the covering ranges used for reads. */
export function physicalArchiveObjects(root: PhysicalManifest) {
  const objects = new Map<string, { sha256: string; size: number; nonce?: string }>();
  for (const chunk of root.chunks) {
    const object = chunk.pack
      ? {
          sha256: chunk.pack.digest,
          size: chunk.pack.size,
          ...(chunk.pack.nonce === undefined ? {} : { nonce: chunk.pack.nonce }),
        }
      : { sha256: chunk.sha256, size: chunk.size };
    const key = physicalKey(object.sha256, object.nonce),
      prior = objects.get(key);
    invariant(
      !prior || prior.size === object.size,
      'INVALID_WORK_BACKUP',
      'Archived metadata key has different sizes.',
    );
    objects.set(key, object);
  }
  return [...objects.values()].sort((a, b) =>
    physicalKey(a.sha256, a.nonce).localeCompare(physicalKey(b.sha256, b.nonce)),
  );
}
function bytes(source: NativeSource, pin: DownloadPin) {
  const value = source.object(pin.sha256);
  invariant(value.length === pin.size, 'INVALID_WORK_BACKUP', 'Archived physical metadata size differs.');
  return value;
}
export function* physicalArchiveEntries(
  source: NativeSource,
  selected?: DownloadPin,
): Generator<PhysicalArchiveEntry> {
  const seen = new Set<string>();
  let pin = selected;
  while (pin) {
    invariant(
      !seen.has(pin.sha256),
      'INVALID_WORK_BACKUP',
      'Archived physical metadata repeats an inventory page.',
    );
    seen.add(pin.sha256);
    const page = physicalArchivePageSchema.parse(JSON.parse(bytes(source, pin).toString('utf8')));
    yield* page.entries;
    pin = page.previous ?? undefined;
  }
}
/** Verify every root and complete metadata body once. Collect unique chunk pins
 * while walking bounded inventory pages, then read each pack once. Memory holds
 * pins, never all roots/packs or source file bodies. */
export function* physicalArchiveClosure(source: NativeSource, selected?: DownloadPin): Generator<string> {
  if (!selected) return;
  const ids = new Set<string>(),
    packs = new Map<
      string,
      { size: number; chunks: Map<string, { sha256: string; size: number; offset: number }> }
    >();
  let page: DownloadPin | undefined = selected;
  while (page) {
    invariant(
      !ids.has(page.sha256),
      'INVALID_WORK_BACKUP',
      'Archived physical metadata repeats an inventory page.',
    );
    ids.add(page.sha256);
    const value = physicalArchivePageSchema.parse(JSON.parse(bytes(source, page).toString('utf8')));
    page = value.previous ?? undefined;
  }
  for (const entry of physicalArchiveEntries(source, selected)) {
    bytes(source, entry.state);
    ids.add(entry.state.sha256);
    if (entry.unavailable && !entry.rootRetained) continue;
    ids.add(entry.root.sha256);
    const value = bytes(source, entry.root),
      root = physicalManifestSchema.parse(
        value[0] === 70 ? decodePhysicalRoot(value) : JSON.parse(value.toString('utf8')),
      );
    invariant(
      root.state === entry.state.sha256,
      'INVALID_WORK_BACKUP',
      'Archived root selects a different State.',
    );
    invariant(
      canonicalPayload(physicalArchiveObjects(root)) === canonicalPayload(entry.objects),
      'INVALID_WORK_BACKUP',
      'Archive must retain every whole metadata key named by its root.',
    );
    if (entry.unavailable) continue;
    for (const chunk of root.chunks) {
      const id = chunk.pack?.digest ?? chunk.sha256,
        size = chunk.pack?.size ?? chunk.size;
      let group = packs.get(id);
      invariant(!group || group.size === size, 'INVALID_WORK_BACKUP', 'Archived metadata body size changed.');
      if (!group) packs.set(id, (group = { size, chunks: new Map() }));
      group.chunks.set(`${chunk.sha256}:${chunk.pack?.offset ?? 0}`, {
        sha256: chunk.sha256,
        size: chunk.size,
        offset: chunk.pack?.offset ?? 0,
      });
    }
  }
  for (const [id, group] of packs) {
    const body = bytes(source, { sha256: id, size: group.size });
    for (const chunk of group.chunks.values()) {
      const part = body.subarray(chunk.offset, chunk.offset + chunk.size);
      invariant(
        part.length === chunk.size && digest(part) === chunk.sha256,
        'INVALID_WORK_BACKUP',
        'Archived metadata chunk differs from its root pin.',
      );
    }
    ids.add(id);
  }
  yield* ids;
}
/** A source release carries only metadata belonging to its selected ancestry;
 * unrelated Work, Lane roots and inventory pages do not enter its new owner. */
export function selectPhysicalArchive(
  source: NativeSource,
  selected: DownloadPin | undefined,
  states: ReadonlySet<string>,
): DownloadPin | undefined {
  let previous: DownloadPin | null = null;
  for (const entry of physicalArchiveEntries(source, selected)) {
    if (!states.has(entry.state.sha256)) continue;
    const value: Buffer = Buffer.from(
      canonicalPayload({ kind: 'forge-source-physical-archive', schema: 1, previous, entries: [entry] }),
    );
    previous = { sha256: source.put(value), size: value.length };
  }
  return previous ?? undefined;
}
