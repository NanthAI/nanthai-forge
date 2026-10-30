// SPDX-License-Identifier: Apache-2.0
import { snapshotDownload, type SnapshotPart } from './snapshot';
export type HostedHandoffPair = {
  projectKey: string;
  revision: number;
  journal: string;
  journalSha256: string;
  archive: {
    transport?: 'objects';
    manifestDigest?: string;
    id: string;
    digest: string;
    head: string;
    kind: 'native' | 'git';
  };
  name: string;
};
type SourceSnapshot = {
  sourceTransport?: 'objects';
  key: string;
  name: string;
  backupId: string;
  backupDigest: string;
  sourceHead: string;
  sourceKind?: 'native' | 'git';
};
const sha = /^[0-9a-f]{64}$/;
export type SourceTransport = {
  backupId: string;
  digest: string;
  head: string;
  kind: 'native' | 'git';
  transport: 'archive' | 'objects';
  manifestDigest: string;
};
/** A representation change does not replace the original source or journal receipt. */
export function refreshHostedPairTransport(
  pair: HostedHandoffPair,
  source?: SourceTransport | null,
): HostedHandoffPair {
  if (!source || source.backupId !== pair.archive.id) return pair;
  if (
    source.digest !== pair.archive.digest ||
    source.head !== pair.archive.head ||
    source.kind !== pair.archive.kind
  )
    throw new Error('The selected source identity differs from the retained Work journal.');
  if (
    source.transport !== 'objects' ||
    (pair.archive.transport === 'objects' && pair.archive.manifestDigest === source.manifestDigest)
  )
    return pair;
  return {
    ...pair,
    archive: { ...pair.archive, transport: 'objects', manifestDigest: source.manifestDigest },
  };
}
export async function captureHostedPair(
  snapshot: SourceSnapshot,
  read: () => Promise<string>,
): Promise<HostedHandoffPair> {
  const journal = await read(),
    parsed = JSON.parse(journal);
  if (
    parsed.kind !== 'forge-hosted-work-journal' ||
    parsed.projectKey !== snapshot.key ||
    !Number.isSafeInteger(parsed.revision) ||
    !sha.test(parsed.base?.archiveSha256 ?? '')
  )
    throw new Error('The Work journal has no valid matching project/archive identity.');
  // Earlier owner-only servers omit source metadata; use their snapshot only when its exact archive digest still matches.
  const source =
    parsed.source ??
    (parsed.base.archiveSha256 === snapshot.backupDigest
      ? {
          transport: snapshot.sourceTransport,
          backupId: snapshot.backupId,
          head: snapshot.sourceHead,
          kind: snapshot.sourceKind ?? 'git',
        }
      : null);
  if (
    !source ||
    typeof source.backupId !== 'string' ||
    !source.backupId ||
    !/^[0-9a-f]{40,64}$/.test(source.head ?? '') ||
    !['native', 'git'].includes(source.kind)
  )
    throw new Error(
      'Hosted source changed. Refresh this project before preparing a matching source and Work pair.',
    );
  const bytes = new TextEncoder().encode(journal),
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return {
    projectKey: parsed.projectKey,
    revision: parsed.revision,
    journal,
    journalSha256: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join(''),
    name: snapshot.name,
    archive: {
      ...(source.transport === 'objects'
        ? { transport: 'objects' as const, manifestDigest: parsed.base.manifestSha256 }
        : {}),
      id: source.backupId,
      digest: parsed.base.archiveSha256,
      head: source.head,
      kind: source.kind,
    },
  };
}
export async function downloadHostedPair(
  pair: HostedHandoffPair,
  read: (input: {
    id: string;
    digest: string;
    offset: number;
  }) => Promise<Omit<SnapshotPart, 'contentType' | 'repository' | 'head'>>,
  progress?: (received: number, total: number) => void,
) {
  const { id, digest, head } = pair.archive;
  return snapshotDownload(async offset => {
    const part = await read({ id, digest, offset });
    if (part.digest !== digest) throw new Error('Downloaded archive differs from the retained Work journal.');
    progress?.(offset + part.data.byteLength, part.size);
    return { ...part, contentType: 'application/gzip', repository: pair.name, head };
  });
}
