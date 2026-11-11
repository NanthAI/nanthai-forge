// SPDX-License-Identifier: Apache-2.0
import { historyViewVersion } from './projectLandingCapsuleContext';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id, Doc } from './_generated/dataModel';
import type { JournalIndex, JournalSegment } from '../src/journal-segment';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/state/hash';
import { invariant } from '../src/errors';
export const journalScope = (kind: string, key: string) => `record:${kind}:${key}`;
export const journalIndexKey = (projectId: string, scope: string, from: number) =>
  `${projectId}:${scope}:${String(from).padStart(16, '0')}`;
type Context = QueryCtx | MutationCtx;
const laneSourcePins = new WeakMap<
  object,
  { head: string; version: number; sourceVersion: number; lifecycleVersion: number }
>();
export const journalLaneSourcePins = (row: Doc<'projectHostedRecords'>) => laneSourcePins.get(row);
const configured = new WeakMap<Context, Map<string, boolean>>();
export function journalProject(ctx: Context, project: Doc<'hostedProjects'>) {
  let entries = configured.get(ctx);
  if (!entries) configured.set(ctx, (entries = new Map()));
  // Narrow finish projections intentionally omit unrelated project fields. They cannot establish
  // that no journal exists. A full canonical row can keep the pre-rollout zero-read fast path.
  if (project.journalRevision || typeof project.revision === 'number')
    entries.set(project._id, !!project.journalRevision);
  else entries.delete(project._id);
}

const dependencies = new WeakMap<Context, Map<string, unknown>>();
export function journalDependency(ctx: Context, key: string, value: unknown) {
  let selected = dependencies.get(ctx);
  if (!selected) dependencies.set(ctx, (selected = new Map()));
  selected.set(key, value);
}
type LoadedContext = Context & { journalLoaded?: JournalSegment[]; journalPrivate?: boolean };
export class JournalNeeded extends Error {
  constructor(readonly index: JournalIndex) {
    super('Selected journal segment requires a server read.');
  }
}
export async function journalReadReply(ctx: Context, error: unknown, projectId: Id<'hostedProjects'>) {
  if (!(error instanceof JournalNeeded)) throw error;
  const project = !(ctx as LoadedContext).journalPrivate ? await ctx.db.get(projectId) : null;
  invariant(
    (ctx as LoadedContext).journalPrivate || project,
    'PROJECT_UNAVAILABLE',
    'Selected history is unavailable.',
  );
  return canonicalPayload({
    journalHistory: true,
    ...(project
      ? {
          viewVersion: digest(
            canonicalPayload([await historyViewVersion(ctx, project), [...(dependencies.get(ctx) ?? [])]]),
          ),
        }
      : {}),
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
  const [row] = await ctx.db
    .query('projectJournalSegments')
    .withIndex('by_project_and_scope_and_from', q =>
      q.eq('projectId', projectId).eq('scope', scope).lte('from', position),
    )
    .order('desc')
    .take(1);
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
  const containing = after < 0 ? null : await journalIndexAt(ctx, projectId, scope, after);
  if (containing && containing.through > after) return containing;
  if (configured.get(ctx)?.get(projectId) === false) return null;
  const [row] = await ctx.db
    .query('projectJournalSegments')
    .withIndex('by_project_and_scope_and_from', q =>
      q.eq('projectId', projectId).eq('scope', scope).gt('from', after).lte('from', through),
    )
    .order('asc')
    .take(1);
  return row ? (JSON.parse(row.value) as JournalIndex) : null;
}
export function requireJournal(ctx: Context, index: JournalIndex) {
  journalDependency(ctx, `segment:${index.scope}:${index.from}`, index.pointer.sha256);
  const loaded = (ctx as LoadedContext).journalLoaded?.find(
    segment =>
      segment.scope === index.scope && segment.from === index.from && segment.startKey === index.startKey,
  );
  if (!loaded) throw new JournalNeeded(index);
  invariant(loaded.through === index.through, 'WORK_STALE', 'Journal range changed while reading.');
  return loaded;
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
  if (!pin) return null; // Sparse imported versions retain their original not-found result.
  const row = {
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
  if (kind === 'lane' && pin[9])
    laneSourcePins.set(row, {
      head: pin[9][0],
      version,
      sourceVersion: pin[9][1],
      lifecycleVersion: pin[9][2],
    });
  return row;
}

export async function journalBody(ctx: Context, row: Doc<'projectHostedRecords'>) {
  const index = await journalIndexAt(ctx, row.projectId, journalScope(row.kind, row.key), row.version);
  invariant(index, 'SOURCE_UNAVAILABLE', 'Exact journal record is unavailable.');
  requireJournal(ctx, index);
  const original = loadedJournalRows(ctx, 'projectHostedRecords').find(item => item._id === row._id);
  if (original?.inline !== undefined) return original.inline;
  return loadedJournalRows(ctx, 'projectHostedRecordBodies').find(body => body._id === row.bodyId)?.value;
}

export async function journalIndexBefore(
  ctx: Context,
  projectId: Id<'hostedProjects'>,
  scope: string,
  before: number,
) {
  if (before <= 0 || configured.get(ctx)?.get(projectId) === false) return null;
  const [row] = await ctx.db
    .query('projectJournalSegments')
    .withIndex('by_project_and_scope_and_from', q =>
      q.eq('projectId', projectId).eq('scope', scope).lt('from', before),
    )
    .order('desc')
    .take(1);
  return row ? (JSON.parse(row.value) as JournalIndex) : null;
}

export const projectJournalHint = (ctx: Context, projectId: Id<'hostedProjects'>) =>
  configured.get(ctx)?.get(projectId);
