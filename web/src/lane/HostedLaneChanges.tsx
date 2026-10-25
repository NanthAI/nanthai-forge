import { useSourceReview } from '../use-source-review';
import { usePageCritical } from '../ui/page-critical';
import { useReadRetry } from '../ui/read-retry';
// SPDX-License-Identifier: Apache-2.0
import { useQuery } from 'convex/react';
import { workIndex, type WorkIndexWorkspace } from '../hosted-work-index';
import { useCallback, useEffect, useState } from 'react';
import type { Id } from '../../../convex/_generated/dataModel';
import type { ReviewPath } from '../../../src/native-source-review';
import { hostedError } from '../snapshot';
import { ChangesPanel, type ChangedPath } from './ChangesPanel';
import type { Comparison } from './Diff';
import type { MapPeer } from './ChangeMapToggle';
import { numberedLines } from './diff-rows';
type Index =
  | { available: true; paths: (ReviewPath & { add?: number; del?: number })[] }
  | { available: false; reason: string };
type File =
  | { available: true; file: ReviewPath; comparison: Comparison }
  | { available: false; reason: string };
/** Manifest first, then only the selected file. No source is fetched to populate the file list. */
export function HostedLaneChanges({
  projectId,
  backupId,
  workspace,
  base,
  head,
  paths: selectedPaths,
  title,
  peers,
  laneId,
}: {
  projectId: Id<'hostedProjects'>;
  backupId: Id<'projectBackups'>;
  workspace?: WorkIndexWorkspace;
  base: string;
  head: string;
  paths?: readonly string[];
  title?: string;
  peers?: MapPeer[];
  laneId?: string;
}) {
  const readAttempt = useReadRetry();
  const read = useSourceReview();
  const [index, setIndex] = useState<Index | null>(null),
    [error, setError] = useState('');
  const indexedPins =
    workspace?.backupId === backupId &&
    workspace.sourceKind === 'native' &&
    workspace.sourceTransport === 'objects' &&
    workspace.counts.sourcePins !== undefined;
  const pinArgs = (id: string) =>
    indexedPins
      ? { projectId, generationId: workspace!.generationId, collection: 'sourcePins', id }
      : ('skip' as const);
  const basePin = useQuery(workIndex.detail, pinArgs(base));
  const headPin = useQuery(workIndex.detail, pinArgs(head));
  const pinsLoading = indexedPins && (basePin === undefined || headPin === undefined);
  const sourceMissing =
    indexedPins &&
    [basePin, headPin].some(pin => pin?.generationId === workspace!.generationId && pin.value === null);
  const [diffReady, setDiffReady] = useState(false);
  const markDiffReady = useCallback(() => setDiffReady(true), []);
  const [stats, setStats] = useState<Record<string, { add: number; del: number }>>({});
  useEffect(() => {
    let current = true;
    setIndex(null);
    setStats({});
    setDiffReady(false);
    setError('');
    if (pinsLoading) return;
    if (sourceMissing) {
      setError('This source object is not retained in the selected checkpoint.');
      return;
    }
    void read({ projectId, backupId, base, head }).then(
      value => {
        if (current) setIndex(JSON.parse(value) as Index);
      },
      e => {
        if (current) setError(hostedError(e));
      },
    );
    return () => {
      current = false;
    };
  }, [read, projectId, backupId, base, head, readAttempt, pinsLoading, sourceMissing]);
  const load = useCallback(
    async (file: string, signal: AbortSignal) => {
      const result = JSON.parse(await read({ projectId, backupId, base, head, file })) as File;
      if (!result.available) throw new Error(result.reason);
      if (!signal.aborted && !result.comparison.truncated) {
        const whole = result.file.status === 'added' || result.file.status === 'deleted';
        const lines = result.comparison.hunks.flatMap((hunk, i) =>
          numberedLines(hunk, whole && i === result.comparison.hunks.length - 1),
        );
        setStats(current => ({
          ...current,
          [file]: {
            add: lines.filter(line => line.kind === 'added').length,
            del: lines.filter(line => line.kind === 'removed').length,
          },
        }));
      }
      return {
        ...result.comparison,
        beforeBlob: result.file.before?.blob ?? null,
        afterBlob: result.file.after?.blob ?? null,
      };
    },
    [read, projectId, backupId, base, head],
  );
  const paths: ChangedPath[] | null = index?.available
    ? index.paths
        .filter(path => path.status !== 'unchanged' && (!selectedPaths || selectedPaths.includes(path.path)))
        .map(path => ({
          path: path.path,
          status: path.status,
          add: stats[path.path]?.add ?? path.add,
          del: stats[path.path]?.del ?? path.del,
          approximate: false,
        }))
    : null;
  usePageCritical('Lane', {
    sourceIndex: index !== null || !!error,
    sourceDiff: !!error || !!(index && !index.available) || paths?.length === 0 || diffReady,
  });
  return (
    <ChangesPanel
      onSettled={markDiffReady}
      mapSource={{ kind: 'lane', id: laneId ?? head, base, head, projectId, backupId, peers }}
      loadNeighbour={load}
      compactFiles={Boolean(selectedPaths)}
      title={title}
      paths={paths}
      error={error || (index && !index.available ? index.reason : undefined)}
      subtitle={selectedPaths ? 'Candidate changes · selected save’s files' : 'against the Lane base'}
      load={load}
    />
  );
}
