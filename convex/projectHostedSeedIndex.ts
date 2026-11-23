// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { SeedRequest } from '../src/hosted-seed-protocol';
import type { parseNativeState } from '../src/state/format';
import { digest } from '../src/state/hash';
import { createWork } from '../src/work-create';
import { materializeWork } from '../src/work-hosted-index';
import { sourceTreeEntries } from '../src/source-tree-index';

/** Build only the initial Work we can reproduce byte for byte from the seed pins. */
export function initialSeedIndex(
  request: SeedRequest,
  state: ReturnType<typeof parseNativeState>,
  catalogSeed: boolean,
) {
  if (
    !request.serverAuthority ||
    !request.main ||
    request.revision !== 0 ||
    request.sourceHead !== request.head ||
    state.parents.length ||
    state.git ||
    request.receipt ||
    request.preview.unavailable
  )
    return undefined;
  const data = createWork(request.head);
  const work = JSON.stringify(data, null, 2);
  const utf8 = new TextEncoder();
  if (digest(work) !== request.work.sha256 || utf8.encode(work).length !== request.work.size)
    return undefined;
  const blobs = new Set([request.head, ...state.files.map(file => file.blob)]);
  if (blobs.size + 1 !== request.preview.files) return undefined;
  const manifest = {
    schema: 1 as const,
    kind: 'forge-native-work-backup' as const,
    id: request.operationId,
    head: request.head,
    revision: 0,
    files: [{ path: `objects/${request.head}`, ...request.main }],
    unavailable: [],
    coverage: 'Pinned initial State; source blobs resolve through the project catalog.',
  };
  const parents = new Map([[request.head, [] as string[]]]);
  const { entries, metadata } = materializeWork(data, manifest, [], 'objects', parents, false, false, true);
  metadata.counts.sourceBlobs = blobs.size;
  // Use the bulk import granularity for this new, immutable Code tree. Long
  // path names can fall back to the existing smaller rows on the same seed.
  const paths = sourceTreeEntries(request.head, state.files, catalogSeed ? 500 : 100);
  entries.push(
    ...(catalogSeed && paths.some(row => utf8.encode(row.value).length > 256 * 1024)
      ? sourceTreeEntries(request.head, state.files)
      : paths),
  );
  const projection = { metadata: JSON.stringify(metadata), entries };
  // Oversized projections keep the existing paged owner repair.
  return utf8.encode(JSON.stringify(projection)).length <= 4 * 1024 * 1024 ? projection : undefined;
}
