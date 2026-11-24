// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Bounded, paged audit timeline for one planning Item (Item 1d51c91f).
// Reuses existing projectHostedRecords / projectHostedRecordHeads / projectWorkEvents /
// projectIntentLandingNotes indexes with zero new tables or indexes.
import { z } from 'zod';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { invariant } from '../src/errors';
import { agentActor, isAgentSlug } from '../src/agent-slug';
import { maxIntentChain } from '../src/hosted-intent-chain';
import { diffPlanningVersion, modelFromAgentClient, type AuditChange } from '../src/planning-audit';
import { decisionOperationId } from '../src/work-planning-put';
import type { PlanningItem } from '../src/work-planning-types';
import { hostedRecordBody } from './projectHostedRecords';
import { hostedRecordValue } from './hostedRecordValue';
import { itemIntentChain } from './projectIntentLandingNotes';
import { landingNoteWindow } from './projectIntentLandingNoteArchive';
import { cursorJson, itemLandingFromNote } from './projectItemLandingHistory';
import { legacyVersions, legacyVersionValue, planningHistoryBudget } from './projectPlanningHistory';
import { record } from './projectWorkIndexStore';
import { workRecordTable } from './projectWorkRecordTables';
import { storeItem } from './projectWorkStoreReads';

const AUDIT_CURSOR = 'forge-item-audit-v1:';
const MAX_LIMIT = 100;
const WORK_STREAM_CAP = 50;
const MAX_COMMENT_PREVIEW = 500;
const PAGE_BYTES = 2 * 1024 * 1024;

const timePosition = z.object({ at: z.number().min(0), skip: z.number().int().min(1).max(512) });
const streamPos = z.union([timePosition, z.literal(false), z.null()]);
const auditCursorSchema = z
  .object({
    v: z.number().int().min(1).nullable(),
    c: z.union([timePosition, z.number().int().min(0), z.literal(false), z.null()]),
    l: z.array(streamPos).max(maxIntentChain + 1),
    n: z.array(streamPos).max(maxIntentChain + 1),
  })
  .strict();

type TimePosition = z.infer<typeof timePosition>;
type StreamPos = z.infer<typeof streamPos>;
type AuditCursor = z.infer<typeof auditCursorSchema>;
type Budget = ReturnType<typeof planningHistoryBudget>;

const MODEL_NOT_DECLARED = 'not declared';

export type ResolvedWriter = {
  actor?: string;
  actorKind: 'person' | 'agent' | 'system' | 'unknown';
  agent?: string;
  model: string | null;
};

/** Build public-identity-safe actor fields (`publicPeople` maps `actor` to handles for writers and removes it for readers). */
export function writerIdentity(
  rawActor: string | undefined,
  agent: string | undefined,
  agentClient: string | undefined,
): ResolvedWriter {
  const slug = isAgentSlug(agent) ? agent : undefined;
  const model = slug ? (modelFromAgentClient(agentClient) ?? MODEL_NOT_DECLARED) : null;
  const actor = rawActor ? (slug ? agentActor(rawActor, slug) : rawActor) : undefined;
  const actorKind = slug ? 'agent' : rawActor ? 'person' : 'unknown';
  return {
    ...(actor ? { actor } : {}),
    actorKind,
    ...(slug ? { agent: slug } : {}),
    model,
  };
}

/** Load a hosted Issue record snapshot and its recorded actor in at most one body read (plus one legacy event lookup for pre-cutover rows). */
export async function loadVersionSnapshot(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  partition: Id<'projectWorkGenerations'> | null,
  row: Doc<'projectHostedRecords'>,
  charge: Budget,
): Promise<{ item: PlanningItem; actor?: string } | null> {
  if (charge.exhausted || row.purged !== undefined) return null;
  if (row.journalSegment) {
    if (!partition) return null;
    let read = 0;
    for await (const legacy of legacyVersions(ctx, partition, row.key)) {
      if (read++ >= 64 || !charge.record(legacy)) break;
      const header = JSON.parse(legacy.value) as PlanningItem;
      if (header.version === row.version && !header.purged) {
        const value = await legacyVersionValue(ctx, partition, legacy, charge);
        if (value === null) return null;
        const item = JSON.parse(value) as PlanningItem;
        const actor = await lookupEventActor(ctx, projectId, item.operationId, charge);
        return { item, actor };
      }
      if (header.version < row.version) break;
    }
    return null;
  }
  let raw: string | undefined = row.inline;
  let actor: string | undefined;
  const body = await ctx.db.get(row.bodyId);
  if (body) {
    if (!charge.record(body)) return null;
    if (typeof body.actor === 'string' && body.actor) actor = body.actor;
    if (raw === undefined) raw = body.value;
  }
  if (raw === undefined) {
    if (!charge.spend(row.bytes)) return null;
    raw = await hostedRecordBody(ctx, row);
  }
  const item = (JSON.parse(raw) as { item: PlanningItem }).item;
  if (!actor && !charge.exhausted) actor = await lookupEventActor(ctx, projectId, item.operationId, charge);
  return { item, actor };
}

async function lookupEventActor(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  operationId: string,
  charge: Budget,
): Promise<string | undefined> {
  if (charge.exhausted) return undefined;
  const event = await ctx.db
    .query('projectWorkEvents')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();
  if (event && charge.record(event) && event.actor) return event.actor;
  return undefined;
}

function skipTies<T extends { _creationTime: number }>(rows: T[], from: TimePosition | undefined) {
  if (!from) return rows;
  let offset = 0;
  while (offset < from.skip && rows[offset]?._creationTime === from.at) offset++;
  return rows.slice(offset);
}

function nextTimePos(
  rows: readonly { _creationTime: number }[],
  consumed: number,
  from: TimePosition | undefined,
): TimePosition {
  const at = rows[consumed - 1]!._creationTime;
  let skip = from?.at === at ? from.skip : 0;
  while (consumed > 0 && rows[--consumed]!._creationTime === at) skip++;
  return { at, skip };
}

type AuditEvent =
  | ({
      kind: 'version';
      id: string;
      version: number;
      at: string;
      summary: string;
      changes: AuditChange[];
      decisionCommentId?: string;
    } & ResolvedWriter)
  | ({
      kind: 'comment';
      id: string;
      at: string;
      text: string;
      textTruncated?: true;
      textLength?: number;
      replyTo?: string;
      decision?: true;
      summary: string;
    } & ResolvedWriter)
  | ({
      kind: 'lane';
      id: string;
      intentId: string;
      at: string;
      state: 'active' | 'completed' | 'abandoned';
      head: string;
      resolves?: string;
      summary: string;
    } & ResolvedWriter)
  | ({
      kind: 'landing' | 'revert';
      id: string;
      intentId: string;
      at: string;
      commit: string;
      sequence?: number;
      laneIds: string[];
      landedBy?: string;
      revertOf?: string;
      summary: string;
    } & ResolvedWriter);

type CommentRow = {
  id: string;
  itemId: string;
  text: string;
  at: string;
  author?: string;
  agent?: string;
  agentClient?: string;
  replyTo?: string;
  decision?: true;
};

type LaneRecord = {
  id: string;
  intentId: string;
  actor: string;
  state: 'active' | 'completed' | 'abandoned';
  at: string;
  head: string;
  agentRun?: string;
  agentClient?: string;
  authorship?: { kind: 'agent' | 'person'; declaration?: 'unknown' | 'not-declared' };
  holder?: { agent?: string };
  resolution?: { origin?: { laneId: string } };
};

/** One comment's timeline event: public-identity writer, bounded text preview and a one-line summary. */
async function commentEvent(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  comment: CommentRow,
  charge: Budget,
): Promise<AuditEvent> {
  const who = writerIdentity(
    comment.author ?? (await lookupEventActor(ctx, projectId, comment.id, charge)),
    comment.agent,
    comment.agentClient,
  );
  const long = comment.text.length > MAX_COMMENT_PREVIEW;
  const text = long ? `${comment.text.slice(0, MAX_COMMENT_PREVIEW - 1)}…` : comment.text;
  const label = comment.decision ? 'decision comment' : comment.replyTo ? 'reply' : 'comment';
  return {
    kind: 'comment',
    id: comment.id,
    at: comment.at,
    ...who,
    text,
    ...(long ? { textTruncated: true as const, textLength: comment.text.length } : {}),
    ...(comment.replyTo ? { replyTo: comment.replyTo } : {}),
    ...(comment.decision ? { decision: true as const } : {}),
    summary: `${label}: ${text.replace(/\s+/g, ' ').slice(0, 100)}`,
  };
}

const PRIORITY: Record<AuditEvent['kind'], number> = {
  revert: 4,
  landing: 3,
  lane: 2,
  version: 1,
  comment: 0,
};

function compareNewest(a: AuditEvent, b: AuditEvent) {
  if (a.at !== b.at) return a.at > b.at ? -1 : 1;
  if (PRIORITY[a.kind] !== PRIORITY[b.kind]) return PRIORITY[b.kind] - PRIORITY[a.kind];
  return a.id > b.id ? -1 : a.id < b.id ? 1 : 0;
}

function decodeCursor(
  cursor: string | null | undefined,
  intentCount: number,
  currentVersion: number,
): AuditCursor {
  if (!cursor)
    return {
      v: currentVersion,
      c: false,
      l: Array.from({ length: intentCount }, () => false),
      n: Array.from({ length: intentCount }, () => false),
    };
  invariant(
    cursor.startsWith(AUDIT_CURSOR),
    'BAD_ARGUMENT',
    'cursor: expected the nextCursor returned by planning Item history.',
  );
  const parsed = auditCursorSchema.safeParse(cursorJson(cursor.slice(AUDIT_CURSOR.length)));
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    'cursor: expected the nextCursor returned by planning Item history.',
  );
  const data = parsed.data;
  const pad = (list: StreamPos[]) =>
    Array.from({ length: intentCount }, (_, i) => (i < list.length ? list[i]! : null));
  return { v: data.v, c: data.c, l: pad(data.l), n: pad(data.n) };
}

export async function readItemAuditHistory(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
  partition: Id<'projectWorkGenerations'> | null,
  input: { itemId: string; limit?: number; cursor?: string | null },
) {
  const pageLimit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), MAX_LIMIT);
  const workCap = Math.min(pageLimit, WORK_STREAM_CAP);
  const charge = planningHistoryBudget(PAGE_BYTES);
  const recordsMode = project.workStore === 'records';

  let current: PlanningItem | null = null;
  if (recordsMode) {
    current = (await storeItem(ctx, project._id, input.itemId)) as PlanningItem | null;
  } else if (partition) {
    const row = await record(ctx, partition, 'planningItems', input.itemId);
    if (row) current = JSON.parse(await hostedRecordValue(ctx, partition, row)) as PlanningItem;
  }
  invariant(current, 'NOT_FOUND', 'Planning item not found.');

  // Where retained history starts for this Item (one exact lookup for version 1).
  let historyStartsAt: string | null = null;
  let firstVersion: number | null = null;
  let completeFromCreation = false;
  if (current.purged) {
    historyStartsAt = current.purged.deletedAt;
    firstVersion = current.version;
  } else if (current.version === 1) {
    historyStartsAt = current.at;
    firstVersion = 1;
    completeFromCreation = true;
  } else if (recordsMode) {
    const v1 = await ctx.db
      .query('projectHostedRecords')
      .withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
        q
          .eq('projectId', project._id)
          .eq('kind', 'issue')
          .eq('key', input.itemId)
          .eq('version', 1)
          .eq('lifecyclePlanId', undefined),
      )
      .unique();
    if (v1 && v1.purged === undefined && charge.record(v1)) {
      // The header (or its inline body) dates version 1; a journal-segment row must prove its body is retained.
      const at = v1.journalSegment
        ? (await loadVersionSnapshot(ctx, project._id, partition, v1, charge))?.item.at
        : v1.inline === undefined
          ? new Date(v1._creationTime).toISOString()
          : (JSON.parse(v1.inline) as { item?: PlanningItem }).item?.at;
      if (at) {
        historyStartsAt = at;
        firstVersion = 1;
        completeFromCreation = true;
      }
    }
  } else if (partition) {
    const [earliest] = await ctx.db
      .query(await workRecordTable(ctx, partition, 'planningVersions'))
      .withIndex('by_generation_and_collection_and_parent_and_position', q =>
        q.eq('generationId', partition).eq('collection', 'planningVersions').eq('parent', input.itemId),
      )
      .order('asc')
      .take(1);
    if (earliest && charge.record(earliest)) {
      const snap = JSON.parse(earliest.value) as PlanningItem;
      historyStartsAt = snap.at;
      firstVersion = snap.version;
      completeFromCreation = snap.version === 1 && !snap.purged;
    }
  }

  const { intents } =
    current.kind === 'issue' ? await itemIntentChain(ctx, project._id, input.itemId) : { intents: [] };
  const state = decodeCursor(input.cursor, intents.length, current.version);

  // 1. Comments stream (read before versions so decision comments can attribute their derived body versions).
  type CommentStreamEntry = { event: AuditEvent; raw: CommentRow; examined: number };
  const commentEntries: CommentStreamEntry[] = [];
  // Rows read for this stream, in order (skipped ones included): cursors advance by them, not by events.
  const commentExamined: { _creationTime: number; position?: number }[] = [];
  let commentHasMore = false;
  if (state.c !== null && !current.purged) {
    if (recordsMode) {
      const time = typeof state.c === 'object' ? state.c : undefined;
      const heads = await ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_parent_and_status', q => {
          const base = q
            .eq('projectId', project._id)
            .eq('kind', 'comment')
            .eq('parent', input.itemId)
            .eq('status', 'comment');
          return time ? base.lte('_creationTime', time.at) : base;
        })
        .order('desc')
        .take(pageLimit + 1 + (time?.skip ?? 0));
      const trimmed = skipTies(heads, time);
      commentHasMore = trimmed.length > pageLimit;
      for (const head of trimmed.slice(0, pageLimit)) {
        if (!charge.record(head)) {
          commentHasMore = true;
          break;
        }
        let comment: CommentRow | null = null;
        if (head.value !== undefined) comment = JSON.parse(head.value) as CommentRow;
        else {
          const rec = await ctx.db.get(head.recordId);
          if (rec && rec.purged === undefined && charge.record(rec))
            comment =
              (JSON.parse(await hostedRecordBody(ctx, rec)) as { comment?: CommentRow }).comment ?? null;
          else if (charge.exhausted) {
            commentHasMore = true;
            break;
          }
        }
        commentExamined.push(head);
        if (!comment) continue;
        commentEntries.push({
          raw: comment,
          examined: commentExamined.length - 1,
          event: await commentEvent(ctx, project._id, comment, charge),
        });
      }
    } else if (partition) {
      const beforePos = typeof state.c === 'number' ? state.c : undefined;
      const rows = await ctx.db
        .query(await workRecordTable(ctx, partition, 'planningComments'))
        .withIndex('by_generation_and_collection_and_parent_and_position', q => {
          const base = q
            .eq('generationId', partition)
            .eq('collection', 'planningComments')
            .eq('parent', input.itemId);
          return beforePos !== undefined ? base.lte('position', beforePos) : base;
        })
        .order('desc')
        .take(pageLimit + 1);
      commentHasMore = rows.length > pageLimit;
      for (const row of rows.slice(0, pageLimit)) {
        if (!charge.record(row)) {
          commentHasMore = true;
          break;
        }
        const comment = JSON.parse(row.value) as CommentRow;
        commentExamined.push(row);
        commentEntries.push({
          raw: comment,
          examined: commentExamined.length - 1,
          event: await commentEvent(ctx, project._id, comment, charge),
        });
      }
    }
  }
  const decisionByOp = new Map<string, CommentRow>();
  for (const entry of commentEntries)
    if (entry.raw.decision) decisionByOp.set(decisionOperationId(entry.raw.id), entry.raw);

  // 2. Item versions stream (newest-first, plus 1 predecessor so the oldest version on the page diffs cleanly).
  type VersionStreamEntry = { event: AuditEvent; version: number };
  const versionEntries: VersionStreamEntry[] = [];
  let versionHasMore = false;
  let versionNextFloor: number | null = null;
  let versionBudgetHit = false;
  if (state.v !== null) {
    if (current.purged) {
      if (state.v >= current.version) {
        const diff = diffPlanningVersion(null, current);
        versionEntries.push({
          version: current.version,
          event: {
            kind: 'version',
            id: current.operationId,
            version: current.version,
            at: current.at,
            ...writerIdentity(current.purged.by, undefined, undefined),
            summary: diff.summary,
            changes: diff.changes,
          },
        });
      }
    } else {
      const loaded: { item: PlanningItem; actor?: string }[] = [];
      if (recordsMode) {
        // Lifecycle-plan rows share a key and version with the real row: page by raw rows, never by a filtered take.
        const rows = ctx.db
          .query('projectHostedRecords')
          .withIndex('by_project_and_kind_and_key_and_version_and_plan', q =>
            q
              .eq('projectId', project._id)
              .eq('kind', 'issue')
              .eq('key', input.itemId)
              .lte('version', state.v!),
          )
          .order('desc');
        let raw = 0;
        for await (const row of rows) {
          if (loaded.length > pageLimit) {
            versionHasMore = true;
            break;
          }
          if (raw++ >= 4 * (pageLimit + 1)) {
            versionHasMore = true;
            versionBudgetHit = true;
            if (!loaded.length) versionNextFloor = row.version;
            break;
          }
          if (row.lifecyclePlanId !== undefined || row.purged !== undefined) continue;
          if (!charge.record(row)) {
            versionBudgetHit = true;
            versionHasMore = true;
            break;
          }
          const snap = await loadVersionSnapshot(ctx, project._id, partition, row, charge);
          if (!snap) {
            versionBudgetHit = true;
            versionHasMore = true;
            break;
          }
          loaded.push(snap);
        }
      } else if (partition) {
        let skipped = 0;
        for await (const row of legacyVersions(ctx, partition, input.itemId)) {
          if (!charge.record(row)) {
            versionBudgetHit = true;
            versionHasMore = true;
            break;
          }
          const header = JSON.parse(row.value) as PlanningItem;
          if (header.version > state.v) {
            if (++skipped > 4096) {
              versionBudgetHit = true;
              break;
            }
            continue;
          }
          if (header.purged) break;
          if (loaded.length >= pageLimit + 1) {
            versionHasMore = true;
            break;
          }
          const value = await legacyVersionValue(ctx, partition, row, charge);
          if (value === null) {
            versionHasMore = true;
            versionBudgetHit = true;
            break;
          }
          const item = JSON.parse(value) as PlanningItem;
          const actor = await lookupEventActor(ctx, project._id, item.operationId, charge);
          loaded.push({ item, actor });
        }
      }
      // With more to come, the oldest loaded version is only the predecessor that the oldest shown one diffs against
      // (a budget cut too); a lone version still shows, with an unavailable predecessor, so paging moves on.
      const shownCount = versionHasMore && loaded.length >= 2 ? loaded.length - 1 : loaded.length;
      const shown = loaded.slice(0, shownCount);
      const predecessor = loaded[shownCount]?.item ?? null;
      if (shown.length) {
        const oldest = shown.at(-1)!.item;
        if (!firstVersion || oldest.version < firstVersion) {
          if (!completeFromCreation) {
            firstVersion = oldest.version;
            historyStartsAt = oldest.at;
          }
        }
        if (versionHasMore) versionNextFloor = oldest.version - 1;
      }
      for (let i = 0; i < shown.length; i++) {
        const { item, actor } = shown[i]!;
        const prev = i + 1 < shown.length ? shown[i + 1]!.item : predecessor;
        const diff = diffPlanningVersion(prev, item);
        const decision = decisionByOp.get(item.operationId);
        const bodyAuthorFallback =
          item.author && (item.version === 1 || (prev && prev.body !== item.body)) ? item.author : undefined;
        const resolvedActor = actor ?? decision?.author ?? bodyAuthorFallback;
        const who =
          item.statusSource === 'work'
            ? { actor: 'Forge', actorKind: 'system' as const, model: null }
            : writerIdentity(
                resolvedActor,
                item.agent ?? decision?.agent,
                item.agentClient ?? decision?.agentClient,
              );
        versionEntries.push({
          version: item.version,
          event: {
            kind: 'version',
            id: item.operationId,
            version: item.version,
            at: item.at,
            ...who,
            summary: diff.summary,
            changes: diff.changes,
            ...(decision ? { decisionCommentId: decision.id } : {}),
          },
        });
      }
    }
  }

  // 3. Lanes per Intent in chain.
  type TimedStreamEntry = { event: AuditEvent; examined: number };
  type TimedStream = {
    entries: TimedStreamEntry[];
    examined: { _creationTime: number }[];
    hasMore: boolean;
    incoming: StreamPos;
  };
  const laneStreams: TimedStream[] = [];
  for (let i = 0; i < intents.length; i++) {
    const incoming = state.l[i]!;
    if (incoming === null || charge.exhausted) {
      laneStreams.push({ entries: [], examined: [], hasMore: incoming !== null, incoming });
      continue;
    }
    const time = incoming || undefined;
    const heads = await ctx.db
      .query('projectHostedRecordHeads')
      .withIndex('by_project_and_kind_and_parent', q => {
        const base = q.eq('projectId', project._id).eq('kind', 'lane').eq('parent', intents[i]!);
        return time ? base.lte('_creationTime', time.at) : base;
      })
      .order('desc')
      .take(workCap + 1 + (time?.skip ?? 0));
    const trimmed = skipTies(heads, time);
    let hasMore = trimmed.length > workCap;
    const entries: TimedStreamEntry[] = [];
    const examined: { _creationTime: number }[] = [];
    for (const head of trimmed.slice(0, workCap)) {
      if (!charge.record(head)) {
        hasMore = true;
        break;
      }
      const rec = await ctx.db.get(head.recordId);
      if (rec && rec.purged === undefined && !charge.record(rec)) {
        hasMore = true;
        break;
      }
      examined.push(head);
      if (!rec || rec.purged !== undefined) continue;
      let lane: LaneRecord;
      try {
        lane = JSON.parse(await hostedRecordBody(ctx, rec)) as LaneRecord;
      } catch {
        continue;
      }
      const run = [lane.agentRun, lane.holder?.agent].find(isAgentSlug);
      const isAgent = Boolean(run) || lane.authorship?.kind === 'agent';
      const model = isAgent
        ? (modelFromAgentClient(lane.agentClient) ??
          (lane.authorship?.declaration === 'unknown' ? 'unknown' : MODEL_NOT_DECLARED))
        : null;
      const who: ResolvedWriter = {
        actor: agentActor(lane.actor, run),
        actorKind: isAgent ? 'agent' : 'person',
        ...(run ? { agent: run } : {}),
        model,
      };
      entries.push({
        examined: examined.length - 1,
        event: {
          kind: 'lane',
          id: lane.id,
          intentId: lane.intentId,
          at: lane.at,
          state: lane.state,
          head: lane.head,
          ...who,
          ...(lane.resolution?.origin ? { resolves: lane.resolution.origin.laneId } : {}),
          summary: `Lane ${lane.id.slice(0, 8)} ${lane.state}`,
        },
      });
    }
    laneStreams.push({ entries, examined, hasMore, incoming });
  }

  // 4. Landings and reverts per Intent in chain (hot + archived capsules).
  const landingStreams: TimedStream[] = [];
  for (let i = 0; i < intents.length; i++) {
    const incoming = state.n[i]!;
    if (incoming === null || charge.exhausted) {
      landingStreams.push({ entries: [], examined: [], hasMore: incoming !== null, incoming });
      continue;
    }
    const time = incoming || undefined;
    const rows = await landingNoteWindow(
      ctx,
      project._id,
      intents[i]!,
      workCap + 1 + (time?.skip ?? 0),
      time?.at,
    );
    const trimmed = skipTies(rows, time);
    let hasMore = trimmed.length > workCap;
    const entries: TimedStreamEntry[] = [];
    const examined: { _creationTime: number }[] = [];
    for (const note of trimmed.slice(0, workCap)) {
      // The note plus its receipt lookup, charged at the note's size.
      if (!charge.spend(2 * JSON.stringify(note).length)) {
        hasMore = true;
        break;
      }
      examined.push(note);
      let detail;
      try {
        detail = await itemLandingFromNote(ctx, project._id, note);
      } catch {
        continue;
      }
      const kind = note.kind === 'reverted' ? ('revert' as const) : ('landing' as const);
      const rawActor = 'actor' in note && typeof note.actor === 'string' ? note.actor : undefined;
      const run = 'agentRun' in note && typeof note.agentRun === 'string' ? note.agentRun : undefined;
      const client =
        'agentClient' in note && typeof note.agentClient === 'string' ? note.agentClient : undefined;
      const slug = isAgentSlug(run) ? run : undefined;
      const isAgent = Boolean(slug) || note.landedBy?.by === 'agent';
      const who: ResolvedWriter = isAgent
        ? {
            ...(rawActor ? { actor: slug ? agentActor(rawActor, slug) : rawActor } : {}),
            actorKind: 'agent',
            ...(slug ? { agent: slug } : {}),
            model: modelFromAgentClient(client) ?? MODEL_NOT_DECLARED,
          }
        : rawActor
          ? writerIdentity(rawActor, undefined, undefined)
          : {
              actorKind:
                note.landedBy?.by === 'person'
                  ? 'person'
                  : note.landedBy?.by === 'queue'
                    ? 'system'
                    : 'unknown',
              model: null,
            };
      entries.push({
        examined: examined.length - 1,
        event: {
          kind,
          id: detail.receiptId,
          intentId: intents[i]!,
          at: detail.at,
          commit: detail.commit,
          ...(detail.sequence !== undefined ? { sequence: detail.sequence } : {}),
          laneIds: [...note.laneIds],
          ...(note.landedBy ? { landedBy: note.landedBy.by } : {}),
          ...(note.revertOf ? { revertOf: note.revertOf } : {}),
          ...who,
          summary:
            kind === 'revert'
              ? `reverted landing ${note.revertOf?.slice(0, 8) ?? ''} (commit ${detail.commit.slice(0, 8)})`
              : `landed on main (commit ${detail.commit.slice(0, 8)}, receipt ${detail.receiptId.slice(0, 8)})`,
        },
      });
    }
    landingStreams.push({ entries, examined, hasMore, incoming });
  }

  // k-way merge (newest first) over a strict prefix of each stream. A stream that has more than it loaded bounds
  // the page at its last loaded event: anything older could sort after its unloaded events, so it waits.
  const streams: { events: AuditEvent[]; index: number; hasMore: boolean }[] = [
    { events: versionEntries.map(e => e.event), index: 0, hasMore: versionHasMore },
    { events: commentEntries.map(e => e.event), index: 0, hasMore: commentHasMore },
    ...[...laneStreams, ...landingStreams].map(s => ({
      events: s.entries.map(e => e.event),
      index: 0,
      hasMore: s.hasMore,
    })),
  ];
  const events: AuditEvent[] = [];
  while (events.length < pageLimit) {
    let best = -1;
    for (let i = 0; i < streams.length; i++) {
      const stream = streams[i]!;
      if (stream.index >= stream.events.length) continue;
      if (
        best < 0 ||
        compareNewest(stream.events[stream.index]!, streams[best]!.events[streams[best]!.index]!) < 0
      )
        best = i;
    }
    if (best < 0) break;
    const chosen = streams[best]!;
    const candidate = chosen.events[chosen.index]!;
    const bounded = streams.some(
      s =>
        s.hasMore &&
        s.index >= s.events.length &&
        s.events.length > 0 &&
        compareNewest(candidate, s.events.at(-1)!) > 0,
    );
    if (bounded) break;
    events.push(candidate);
    chosen.index++;
  }

  // Advance each cursor past the rows its stream consumed (skipped rows included), never past unshown events.
  const vConsumed = streams[0]!.index;
  const nextV =
    vConsumed < versionEntries.length
      ? versionEntries[vConsumed]!.version
      : versionHasMore
        ? versionEntries.length === 0
          ? (versionNextFloor ?? state.v)
          : versionNextFloor !== null && versionNextFloor >= 1
            ? versionNextFloor
            : null
        : null;

  const advanceTimed = (
    stream: { entries: TimedStreamEntry[]; examined: { _creationTime: number }[]; hasMore: boolean },
    incoming: TimePosition | false,
    consumed: number,
  ): TimePosition | false | null => {
    const from = incoming || undefined;
    if (consumed < stream.entries.length)
      return consumed === 0
        ? incoming
        : nextTimePos(stream.examined, stream.entries[consumed - 1]!.examined + 1, from);
    if (!stream.hasMore) return null;
    return stream.examined.length ? nextTimePos(stream.examined, stream.examined.length, from) : incoming;
  };

  const cConsumed = streams[1]!.index;
  let nextC: AuditCursor['c'] = null;
  if (state.c !== null && !current.purged) {
    const comments = { entries: commentEntries, examined: commentExamined, hasMore: commentHasMore };
    if (recordsMode) nextC = advanceTimed(comments, typeof state.c === 'object' ? state.c : false, cConsumed);
    else {
      // Legacy comments page by position (inclusive upper bound).
      const through =
        cConsumed < commentEntries.length
          ? cConsumed === 0
            ? null
            : commentEntries[cConsumed - 1]!.examined
          : commentHasMore && commentExamined.length
            ? commentExamined.length - 1
            : undefined;
      nextC =
        through === undefined
          ? commentHasMore
            ? state.c
            : null
          : through === null
            ? state.c
            : (commentExamined[through]!.position ?? 0) - 1;
      if (typeof nextC === 'number' && nextC < 0) nextC = null;
    }
  }

  const timed = (stream: TimedStream, consumed: number) =>
    stream.incoming === null
      ? null
      : advanceTimed(stream, typeof stream.incoming === 'object' ? stream.incoming : false, consumed);
  const nextL = laneStreams.map((stream, i) => timed(stream, streams[2 + i]!.index));
  const nextN = landingStreams.map((stream, i) => timed(stream, streams[2 + intents.length + i]!.index));

  const hasNext =
    nextV !== null || nextC !== null || nextL.some(p => p !== null) || nextN.some(p => p !== null);
  const nextCursor = hasNext
    ? AUDIT_CURSOR + JSON.stringify({ v: nextV, c: nextC, l: nextL, n: nextN })
    : null;

  const notes: string[] = [];
  if (current.purged) notes.push('Item was permanently deleted; earlier versions and text were purged.');
  if (!completeFromCreation && !current.purged)
    notes.push(
      'Version 1 is unavailable in retained storage; history starts at the earliest retained version.',
    );
  if (events.some(e => e.kind === 'version' && e.actorKind === 'unknown'))
    notes.push('Versions predating hosted journal actor recording report actorKind "unknown".');
  if (versionBudgetHit)
    notes.push('This page reached its per-read byte budget; continue with nextCursor for earlier events.');

  return {
    itemId: current.id,
    kind: current.kind,
    title: current.title,
    status: current.status,
    currentVersion: current.version,
    historyStartsAt,
    firstVersion,
    completeFromCreation,
    ...(current.purged ? { purged: current.purged } : {}),
    coverage: current.purged
      ? ('purged' as const)
      : !completeFromCreation || versionBudgetHit
        ? ('partial' as const)
        : ('complete' as const),
    ...(notes.length ? { notes } : {}),
    events,
    nextCursor,
  };
}
