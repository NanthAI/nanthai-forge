import { useReadRetry } from './ui/read-retry';
// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { type ConvexReactClient, useConvex, usePaginatedQuery, useQuery } from 'convex/react';
import { makeFunctionReference, type PaginationOptions, type PaginationResult } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import type { WorkData } from '../../src/work-types';
import type { IntentPin } from './proposal-api';
import { hostedError } from './snapshot';
import { assembleIndexValue, type IndexHeader } from './hosted-index-value';

type Project = { projectId: Id<'hostedProjects'> };
type Selection = Project & {
  generationId?: string;
  collection: string;
  parentId?: string;
  newestFirst?: boolean;
};
type Row = { id: string; position: number; value: string };
type Page = PaginationResult<Row> & { generationId: string | null; revision: number | null };
type Detail = {
  generationId: string | null;
  revision: number | null;
  value: string | null;
  editable: boolean;
  intentPin: string | null;
};
export const workIndex = {
  workspace: makeFunctionReference<'query', Project, string | null>('projectWorkIndex:workspace'),
  records: makeFunctionReference<'query', Selection & { paginationOpts: PaginationOptions }, Page>(
    'projectWorkIndex:records',
  ),
  detail: makeFunctionReference<
    'query',
    Project & { generationId?: string; collection: string; id: string },
    Detail
  >('projectWorkIndex:detail'),
  ensure: makeFunctionReference<'action', Project, string>('projectWorkIndexActions:ensure'),
  checksum: makeFunctionReference<'action', Project, string>('projectWorkIndexActions:checksum'),
};
export type WorkIndexWorkspace = {
  generationId: string;
  freshness?: import('../../src/hosted-freshness').HostedFreshness;
  revision: number;
  backupId: Id<'projectBackups'>;
  backupDigest: string;
  sourceTransport?: 'objects';
  sourceHead: string;
  sourceKind?: 'native' | 'git';
  key: string;
  name: string;
  actor: string;
  counts: Record<string, number>;
  defaultIntentId?: string;
  capabilities: {
    recentSummaryPages?: boolean;
    owner: boolean;
    editableIntentIds: string[];
    sourceReturn: boolean;
    hostedChannels: boolean;
    planning?: boolean;
  };
};
export type IntentHeader = WorkData['intents'][number] & { noteCount?: number; lifecycleCount?: number };

/** Source returns and ordinary revisions preserve mounted forms and query identities. */
export function useWorkIndex(
  projectId: Id<'hostedProjects'>,
  source?: { backupId: Id<'projectBackups'>; revision: number },
) {
  const readAttempt = useReadRetry();
  const client = useConvex(),
    value = useQuery(workIndex.workspace, { projectId });
  const workspace = useMemo(() => (value ? (JSON.parse(value) as WorkIndexWorkspace) : null), [value]);
  const current = workspace && (!source || workspace.backupId === source.backupId) ? workspace : null;
  const [error, setError] = useState('');
  const retained = useRef<{ projectId: string; workspace: WorkIndexWorkspace } | null>(null);
  if (current) retained.current = { projectId, workspace: current };
  useEffect(() => {
    if (!source || current) return;
    let active = true;
    void client
      .action(workIndex.ensure, { projectId })
      .then(() => {
        if (active) setError('');
      })
      .catch(error => {
        if (active) setError(hostedError(error));
      });
    return () => {
      active = false;
    };
  }, [client, projectId, source?.backupId, source?.revision, current?.generationId, readAttempt]);
  // Keep mounted editor state while a new source generation is being prepared.
  // Any command still carries its observed revision and existing server CAS.
  return {
    workspace: current ?? (retained.current?.projectId === projectId ? retained.current.workspace : null),
    error,
  };
}

/** Transparently page existing choices; no retained record is hidden behind a count ceiling. */
function useWorkRows(
  projectId: Id<'hostedProjects'>,
  workspace: WorkIndexWorkspace | null,
  collection: string,
  parentId?: string,
  enabled = true,
) {
  const selection =
    workspace && enabled
      ? {
          projectId,
          generationId: workspace.generationId,
          collection,
          ...(workspace.capabilities?.recentSummaryPages &&
          parentId === undefined &&
          [
            'intents',
            'lanes',
            'views',
            'runs',
            'planningItems',
            'channelMoves',
            'hostedChannelMoves',
          ].includes(collection)
            ? { newestFirst: true }
            : {}),
          ...(parentId === undefined ? {} : { parentId }),
        }
      : 'skip';
  const initialNumItems = [
    'intents',
    'lanes',
    'views',
    'runs',
    'planningItems',
    'channelMoves',
    'hostedChannelMoves',
  ].includes(collection)
    ? 20
    : 100;
  const { results, status, loadMore } = usePaginatedQuery(workIndex.records, selection, { initialNumItems });
  // Convex splits any page longer than twice `initialNumItems` into two new subscriptions; larger
  // continuation pages would each be re-read and split twice before the page settles.
  const pageSize = Math.min(100, initialNumItems * 2);
  useEffect(() => {
    if (enabled && workspace && status === 'CanLoadMore') loadMore(pageSize);
  }, [enabled, workspace?.generationId, status, loadMore, results.length, pageSize]);
  return {
    rows: useMemo(() => [...results].sort((a, b) => a.position - b.position), [results]),
    complete: status === 'Exhausted',
    loading: enabled && !!workspace && status !== 'Exhausted',
    initialLoading: enabled && (!workspace || status === 'LoadingFirstPage'),
  };
}
type RecordPage = { records: unknown[]; complete: boolean; loading: boolean; initialLoading: boolean };
export const WorkRecordsContext = createContext<{
  projectId: string;
  generationId: string;
  collections: Record<string, RecordPage>;
} | null>(null);
export function useWorkRecords<T>(
  projectId: Id<'hostedProjects'>,
  workspace: WorkIndexWorkspace | null,
  collection: string,
  parentId?: string,
  enabled = true,
) {
  const context = useContext(WorkRecordsContext);
  const shared =
    enabled &&
    parentId === undefined &&
    context?.projectId === projectId &&
    context.generationId === workspace?.generationId
      ? context.collections[collection]
      : undefined;
  const result = useWorkRows(projectId, workspace, collection, parentId, enabled && !shared);
  const records = useMemo(() => result.rows.map(row => JSON.parse(row.value) as T), [result.rows]);
  return shared
    ? { ...shared, records: shared.records as T[] }
    : { records, complete: result.complete, loading: result.loading, initialLoading: result.initialLoading };
}
export function useResolvedWorkValue<T>(
  projectId: Id<'hostedProjects'>,
  workspace: WorkIndexWorkspace | null,
  collection: string,
  header: T | null,
  enabled = true,
) {
  const value = header as (T & IndexHeader) | null;
  const parts = useWorkRows(
    projectId,
    workspace,
    `${collection}:payload`,
    value?.payloadKey,
    enabled && !!value?.payloadKey,
  );
  return useMemo(
    () =>
      !value
        ? null
        : !value.payloadKey
          ? value
          : parts.complete
            ? assembleIndexValue(collection, value, parts.rows)
            : null,
    [value, collection, parts.complete, parts.rows],
  );
}
export function useWorkRecordResult<T>(
  projectId: Id<'hostedProjects'>,
  workspace: WorkIndexWorkspace | null,
  collection: string,
  id: string,
) {
  const result = useQuery(
    workIndex.detail,
    id
      ? { projectId, ...(workspace ? { generationId: workspace.generationId } : {}), collection, id }
      : 'skip',
  );
  const header = useMemo(
    () =>
      result && (!workspace || result.generationId === workspace.generationId) && result.value
        ? (JSON.parse(result.value) as T)
        : null,
    [result, workspace?.generationId],
  );
  const record = useResolvedWorkValue(projectId, workspace, collection, header);
  return {
    record,
    header,
    initialLoading: !!id && result === undefined,
    editable: result?.generationId === workspace?.generationId && result?.editable === true,
    intentPin:
      result?.generationId === workspace?.generationId && result?.intentPin
        ? (JSON.parse(result.intentPin) as IntentPin)
        : undefined,
  };
}
export function useWorkRecord<T>(
  projectId: Id<'hostedProjects'>,
  workspace: WorkIndexWorkspace | null,
  collection: string,
  id: string,
) {
  return useWorkRecordResult<T>(projectId, workspace, collection, id).record;
}
/** Fully resolve an explicitly selected editor value before allowing a replacement write. */
export async function readWorkRecord<T>(
  client: ConvexReactClient,
  projectId: Id<'hostedProjects'>,
  workspace: WorkIndexWorkspace,
  collection: string,
  id: string,
): Promise<T> {
  const result = await client.query(workIndex.detail, {
    projectId,
    generationId: workspace.generationId,
    collection,
    id,
  });
  if (result.generationId !== workspace.generationId || !result.value)
    throw new Error('This source selection changed. Load the current item before editing.');
  const header = JSON.parse(result.value) as T & IndexHeader;
  if (!header.payloadKey) return header;
  const parts: Row[] = [];
  let cursor: string | null = null;
  do {
    const page: Page = await client.query(workIndex.records, {
      projectId,
      generationId: workspace.generationId,
      collection: `${collection}:payload`,
      parentId: header.payloadKey,
      paginationOpts: { cursor, numItems: 50 },
    });
    if (page.generationId !== workspace.generationId)
      throw new Error('This source selection changed. The original item remains retained.');
    if (page.revision !== result.revision)
      return readWorkRecord(client, projectId, workspace, collection, id);
    parts.push(...page.page);
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  const latest = await client.query(workIndex.detail, {
    projectId,
    generationId: workspace.generationId,
    collection,
    id,
  });
  if (latest.generationId !== workspace.generationId)
    throw new Error('This source selection changed. The original item remains retained.');
  if (latest.revision !== result.revision || latest.value !== result.value)
    return readWorkRecord(client, projectId, workspace, collection, id);
  return assembleIndexValue(collection, header, parts);
}
