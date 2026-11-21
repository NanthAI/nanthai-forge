// SPDX-License-Identifier: Apache-2.0
import type { SeedRequest } from '../src/hosted-seed-protocol';
import type { parseNativeState } from '../src/state/format';
import { digest } from '../src/state/hash';
import { createWork } from '../src/work-create';
import { materializeWork } from '../src/work-hosted-index';

/** Build only the initial Work we can reproduce byte for byte from the seed pins. */
export function initialSeedIndex(request: SeedRequest, state: ReturnType<typeof parseNativeState>) {
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
  const parents = Object.assign(new Map([[request.head, [] as string[]]]), {
    files: new Map([[request.head, state.files]]),
  });
  const { entries, metadata } = materializeWork(data, manifest, [], 'objects', parents, false, false, true);
  metadata.counts.sourceBlobs = blobs.size;
  const projection = { metadata: JSON.stringify(metadata), entries };
  // Oversized projections keep the existing paged owner repair.
  return utf8.encode(JSON.stringify(projection)).length <= 4 * 1024 * 1024 ? projection : undefined;
}
