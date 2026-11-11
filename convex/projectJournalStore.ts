// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id, Doc } from './_generated/dataModel';
import type { JournalIndex, JournalSegment } from '../src/journal-segment';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
export const journalIndexKind = 'projectJournalSegments';
export const journalScope = (kind: string, key: string) => `record:${kind}:${key}`;
export const journalIndexKey = (projectId: string, scope: string, from: number) =>
  `${projectId}:${scope}:${String(from).padStart(16, '0')}`;
type Context = QueryCtx | MutationCtx;
const configured = new WeakMap<Context, Map<string, boolean>>();
export function journalProject(ctx: Context, project: Doc<'hostedProjects'>) {
  let entries = configured.get(ctx);
  if (!entries) configured.set(ctx, (entries = new Map()));
  entries.set(project._id, !!project.journalRevision);
}

type LoadedContext = Context & { journalLoaded?: JournalSegment[]; journalPrivate?: boolean };
export class JournalNeeded extends Error {
  constructor(readonly index: JournalIndex) {
    super('Selected journal segment requires a server read.');
  }
}
export function journalReadReply(ctx: Context, error: unknown) {
  if (!(error instanceof JournalNeeded)) throw error;
  return canonicalPayload({
    journalHistory: true,
    ...((ctx as LoadedContext).journalPrivate ? { index: error.index } : {}),
  });
}
export function loadedJournalRows<T extends keyof JournalSegment['tables']>(
  ctx: Context,
  table: T,
): Doc<T>[] {
  return ((ctx as LoadedContext).journalLoaded ?? []).flatMap(segment =>
    (segment.tables[table] ?? []).map(text => JSON.parse(text)),
  );
}
export async function journalIndexAt(
  ctx: Context,
  projectId: Id<'hostedProjects'>,
  scope: string,
  position: number,
) {
  if (configured.get(ctx)?.get(projectId) === false) return null;
  const row = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_source', q =>
      q
        .eq('kind', journalIndexKind)
        .gte('sourceId', journalIndexKey(projectId, scope, 0))
        .lte('sourceId', journalIndexKey(projectId, scope, position)),
    )
    .order('desc')
    .first();
  const index = row ? (JSON.parse(row.value) as JournalIndex) : null;
  return index && index.scope === scope && index.from <= position && index.through >= position ? index : null;
}
export async function journalIndexAfter(
  ctx: Context,
  projectId: Id<'hostedProjects'>,
  scope: string,
  after: number,
  through: number,
) {
  const containing = await journalIndexAt(ctx, projectId, scope, after);
  if (containing && containing.through > after) return containing;
  if (configured.get(ctx)?.get(projectId) === false) return null;
  const row = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_source', q =>
      q
        .eq('kind', journalIndexKind)
        .gt('sourceId', journalIndexKey(projectId, scope, after))
        .lte('sourceId', journalIndexKey(projectId, scope, through)),
    )
    .order('asc')
    .first();
  return row ? (JSON.parse(row.value) as JournalIndex) : null;
}
export function requireJournal(ctx: Context, index: JournalIndex) {
  const loaded = (ctx as LoadedContext).journalLoaded?.find(
    segment => segment.scope === index.scope && segment.from === index.from,
  );
  if (!loaded) throw new JournalNeeded(index);
  invariant(loaded.through === index.through, 'WORK_STALE', 'Journal range changed while reading.');
}
export async function journalRecord(
  ctx: Context,
  projectId: Id<'hostedProjects'>,
  kind: string,
  key: string,
  version: number,
) {
  const index = await journalIndexAt(ctx, projectId, journalScope(kind, key), version);
  if (!index) return null;
  const loaded = loadedJournalRows(ctx, 'projectHostedRecords').find(
    row => row.kind === kind && row.key === key && row.version === version,
  );
  if (loaded) return loaded;
  const pin = index.records?.find(pin => pin[0] === version);
  invariant(pin, 'SOURCE_UNAVAILABLE', 'Original journal transaction pin is unavailable.');
  return {
    projectId,
    kind,
    key,
    version,
    _id: pin[1],
    _creationTime: pin[2],
    bodyId: pin[3],
    parent: pin[4],
    status: pin[5],
    digest: pin[6],
    bytes: pin[7],
    ...(pin[8] === null ? {} : { workReadDigest: pin[8] }),
  } as Doc<'projectHostedRecords'>;
}

export async function journalBody(ctx: Context, row: Doc<'projectHostedRecords'>) {
  const index = await journalIndexAt(ctx, row.projectId, journalScope(row.kind, row.key), row.version);
  invariant(index, 'SOURCE_UNAVAILABLE', 'Exact journal record is unavailable.');
  requireJournal(ctx, index);
  const original = loadedJournalRows(ctx, 'projectHostedRecords').find(item => item._id === row._id);
  if (original?.inline !== undefined) return original.inline;
  return loadedJournalRows(ctx, 'projectHostedRecordBodies').find(body => body._id === row.bodyId)?.value;
}
