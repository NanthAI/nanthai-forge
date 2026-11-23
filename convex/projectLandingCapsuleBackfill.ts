// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from './server';
import type { Id } from './_generated/dataModel';
import { landingRequestOriginalDb } from './projectLandingRequestBody';
import { workRecordOriginalDb } from './projectWorkRecordWriter';
import { finishReadOriginalDb } from './projectFinishReadWriter';
import { classifyLandingCapsule } from './projectLandingCapsuleStore';
import { capsuleFinishKinds } from './projectLandingCapsuleCapture';
import { capsuleProgressKind, capsulePageRows } from './projectLandingCapsuleRemove';
import { capsuleIndexKind, capsuleIndexPage } from './projectLandingCapsuleIndex';
import { cancelPendingTask } from './schedulerCancel';
import { canonicalPayload } from '../src/hosted-source-operation';
import type { LandingCapsulePointer } from '../src/hosted-landing';

/**
 * One-time backfill (b149b16b): landings that settled before the S1 writer was deployed never got a
 * pack wake. An operator starts it with one explicit call per project. It is never a cron and never
 * runs on idle: it scans a project's landing requests and schedules the existing packer, which
 * verifies the stored object before it removes any row and is a no-op for a packed landing.
 * Delete this module and its control rows once dev and bench are backfilled (e806e2a7).
 */
export const capsuleBackfillKind = 'projectLandingCapsuleBackfill';
/** Requests read per scan page; with one pointer lookup each, a page reads about 128 documents. */
export const backfillPageRows = 64;
export const backfillPageBytes = 1024 * 1024;
/** Packs start this far apart (default), so a backfill keeps about one pack in flight. */
export const backfillStaggerMs = 2_000;
const staggerBounds = [500, 60_000] as const;
/** Index bootstrap pages per call while the project's capsule index is unbuilt: no pack is scheduled
 * until it is built, so packs never race the bootstrap on its one control row. */
export const backfillIndexPages = 8;
/** Dry-run pages count each candidate's landing-owned rows: 8 requests x 7 scopes x 65 rows. */
export const dryRunPageRows = 8;
const dryRunScopeRows = 64;
export const dryRunPageBytes = 1024 * 1024;
/** Measured packer calls per landing on dev (667a78c7: 6 capsule + 3.8 expiry), before extra
 * removal pages over the first 64 rows. */
export const packCallsPerLanding = 10;

type Ctx = QueryCtx | MutationCtx;
type Totals = {
  pages: number;
  scanned: number;
  scheduled: number;
  resumed: number;
  packed: number;
  active: number;
  inGrace: number;
};
const zero = (): Totals => ({
  pages: 0,
  scanned: 0,
  scheduled: 0,
  resumed: 0,
  packed: 0,
  active: 0,
  inGrace: 0,
});
const add = (a: Totals, b: Totals): Totals =>
  Object.fromEntries(
    Object.keys(a).map(key => [key, a[key as keyof Totals] + b[key as keyof Totals]]),
  ) as Totals;
type Candidate = { submissionId: string; dueAt: number; pointer: LandingCapsulePointer | null };

/** The unhydrated request port: unwrap the Work, finish-read and landing-body layers, repeatedly,
 * since a test or custom context may nest them. Reads beneath them return the stored rows. */
function rawRequests(db: Ctx['db']) {
  let current = db;
  for (;;) {
    const next = landingRequestOriginalDb(
      finishReadOriginalDb(workRecordOriginalDb(current as MutationCtx['db'])) as Ctx['db'],
    );
    if (next === current) return current;
    current = next;
  }
}

/** One bounded page of a project's landing requests, classified by the packer's shared rules.
 * Cold request bodies are never read: the scan needs only phase, settle time and the pointer. */
async function scan(ctx: Ctx, projectId: Id<'hostedProjects'>, cursor: string | null, rows: number) {
  const page = await rawRequests(ctx.db)
    .query('projectHostedLandingRequests')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .paginate({ cursor, numItems: rows, maximumRowsRead: rows, maximumBytesRead: backfillPageBytes });
  const totals = { ...zero(), pages: 1 };
  const candidates: Candidate[] = [];
  const packedPointers: LandingCapsulePointer[] = [];
  const now = Date.now();
  for (const row of page.page) {
    totals.scanned++;
    const selected = await classifyLandingCapsule(ctx, row, now);
    if (selected.kind === 'active') totals.active++;
    // Inside the grace the live writer's own wake owns the landing.
    else if (selected.kind === 'grace') totals.inGrace++;
    else if (selected.kind === 'packed') {
      totals.packed++;
      packedPointers.push(selected.pointer);
    } else if (selected.kind === 'removing') {
      // A run that stopped between verified removal pages: the packer resumes its stored offset.
      totals.resumed++;
      candidates.push({ submissionId: row.submissionId, dueAt: selected.dueAt, pointer: selected.pointer });
    } else {
      totals.scheduled++;
      candidates.push({ submissionId: row.submissionId, dueAt: selected.dueAt, pointer: null });
    }
  }
  return {
    totals,
    candidates,
    packedPointers,
    cursor: page.isDone ? null : page.continueCursor,
    done: page.isDone,
  };
}

type State = {
  /** Bumped by every operator start; a chained call from an older generation stops. */
  generation: number;
  cursor: string | null;
  done: boolean;
  totals: Totals;
  /** The one pending chained call, cancelled when a restart supersedes it. */
  nextTaskId: string | null;
  /** When the last scheduled pack starts; later pages start their packs after it. */
  packsUntil: number;
};
const initial = (): State => ({
  generation: 0,
  cursor: null,
  done: false,
  totals: zero(),
  nextTaskId: null,
  packsUntil: 0,
});
async function stateRow(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  return await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_source', q => q.eq('kind', capsuleBackfillKind).eq('sourceId', projectId))
    .unique();
}

/**
 * One scan page per call; the cursor, totals and chain identity live in one control row, so a crash
 * or re-run resumes after the last committed page. Exactly one chain: an operator call while a page's
 * packs are still starting or a chained call is pending is refused (`busy`) unless it is a `restart`,
 * which cancels the pending call; each operator start bumps `generation`, and a chained call stops
 * unless its generation, cursor and the unfinished state all match. A finished backfill writes nothing
 * on a re-run; `restart` re-scans and schedules only landings still unpacked.
 */
export const run = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    pages: v.optional(v.number()),
    restart: v.optional(v.boolean()),
    limit: v.optional(v.number()),
    staggerMs: v.optional(v.number()),
    generation: v.optional(v.number()),
    from: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const now = Date.now();
    const pages = Math.max(1, Math.min(Math.floor(input.pages ?? 1), 1_000));
    const rows = Math.max(1, Math.min(Math.floor(input.limit ?? backfillPageRows), backfillPageRows));
    const stagger = Math.max(
      staggerBounds[0],
      Math.min(Math.floor(input.staggerMs ?? backfillStaggerMs), staggerBounds[1]),
    );
    const old = await stateRow(ctx, input.projectId);
    let state: State = old ? { ...initial(), ...JSON.parse(old.value) } : initial();
    if (input.generation !== undefined) {
      if (input.generation !== state.generation || input.from !== state.cursor || state.done)
        return canonicalPayload({ stale: true, ...state });
    } else {
      if (state.done && !input.restart) return canonicalPayload({ ...state, unchanged: true });
      const task = state.nextTaskId
        ? await ctx.db.system.get(state.nextTaskId as Id<'_scheduled_functions'>)
        : null;
      const pending = task?.state.kind === 'pending';
      if (!input.restart && (pending || now < state.packsUntil))
        return canonicalPayload({ busy: true, retryAfterMs: Math.max(0, state.packsUntil - now), ...state });
      if (pending) await cancelPendingTask(ctx, state.nextTaskId as Id<'_scheduled_functions'>, task);
      state = {
        ...(input.restart ? initial() : state),
        generation: state.generation + 1,
        nextTaskId: null,
        packsUntil: state.packsUntil,
      };
    }
    const chain = async (delay: number, args: { pages: number }) =>
      (await ctx.scheduler.runAfter(
        delay,
        makeFunctionReference<'mutation'>('projectLandingCapsuleBackfill:run'),
        {
          projectId: input.projectId,
          limit: rows,
          staggerMs: stagger,
          generation: state.generation,
          from: state.cursor,
          ...args,
        },
      )) as string;
    const save = async (extra: Record<string, unknown> = {}) => {
      const value = canonicalPayload(state);
      if (old) await ctx.db.patch(old._id, { value });
      else
        await ctx.db.insert('projectFinishReadRows', {
          kind: capsuleBackfillKind,
          sourceId: input.projectId,
          projectId: input.projectId,
          value,
        });
      return canonicalPayload({ ...state, ...extra });
    };
    let indexed = false;
    for (let page = 0; page < backfillIndexPages && !indexed; page++)
      indexed = await capsuleIndexPage(ctx, input.projectId);
    if (!indexed) {
      // Finite bootstrap drain, then the same page: it does not use the caller's page budget.
      state.nextTaskId = await chain(0, { pages });
      return await save({ indexing: true });
    }
    const page = await scan(ctx, input.projectId, state.cursor, rows);
    const start = Math.max(0, state.packsUntil - now);
    for (const [index, candidate] of page.candidates.entries())
      await ctx.scheduler.runAfter(
        start + index * stagger,
        makeFunctionReference<'action'>('projectLandingCapsuleRun:pack'),
        { projectId: input.projectId, submissionId: candidate.submissionId, dueAt: candidate.dueAt },
      );
    state.cursor = page.cursor;
    state.done = page.done;
    state.totals = add(state.totals, page.totals);
    state.packsUntil = Math.max(state.packsUntil, now + start + page.candidates.length * stagger);
    state.nextTaskId =
      !page.done && pages > 1 ? await chain(state.packsUntil - now, { pages: pages - 1 }) : null;
    return await save({ page: page.totals });
  },
});

const pointerRows = (pointer: LandingCapsulePointer) =>
  (JSON.parse(pointer.tables) as Array<[number, number]>).reduce((n, [, rows]) => n + rows, 0);
/** Read-only: one dry-run page. Counts each unpacked candidate's landing-owned rows and bytes
 * (attempts, observations and finish projections), each resumed removal's remaining rows, the
 * packed landings' stored sizes and the packer calls. Shared scopes (acceptance, compose pages,
 * check callbacks) are not read; `partial` marks a row cap or the byte stop. */
export const dryRunPage = internalQuery({
  args: { projectId: v.id('hostedProjects'), cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    const page = await scan(ctx, input.projectId, input.cursor, dryRunPageRows);
    let rows = 0,
      bytes = 0,
      resumeRows = 0,
      packCalls = 0,
      partial = false,
      stopped = false;
    const utf8 = (text: string) => new TextEncoder().encode(text).length;
    for (const candidate of page.candidates) {
      const identity = { projectId: input.projectId, submissionId: candidate.submissionId };
      if (candidate.pointer) {
        const progress = await ctx.db
          .query('projectFinishReadRows')
          .withIndex('by_kind_and_project_and_submission', q =>
            q
              .eq('kind', capsuleProgressKind)
              .eq('projectId', identity.projectId)
              .eq('submissionId', identity.submissionId),
          )
          .unique();
        const offset = progress ? (JSON.parse(progress.value).offset as number) : 0;
        const remaining = Math.max(0, pointerRows(candidate.pointer) - offset);
        resumeRows += remaining;
        // begin, then the remaining verified removal pages; no capture, refs or expiry.
        packCalls += 1 + Math.ceil(remaining / capsulePageRows);
        continue;
      }
      if (stopped) {
        packCalls += packCallsPerLanding;
        continue;
      }
      const scopes = [
        ctx.db
          .query('projectHostedLandingAttempts')
          .withIndex('by_project_and_submission_and_number', q =>
            q.eq('projectId', identity.projectId).eq('submissionId', identity.submissionId),
          ),
        ctx.db
          .query('projectHostedLandingObservations')
          .withIndex('by_project_and_submission_and_version', q =>
            q.eq('projectId', identity.projectId).eq('submissionId', identity.submissionId),
          ),
        ...capsuleFinishKinds.map(kind =>
          ctx.db
            .query('projectFinishReadRows')
            .withIndex('by_kind_and_project_and_submission', q =>
              q
                .eq('kind', kind)
                .eq('projectId', identity.projectId)
                .eq('submissionId', identity.submissionId),
            ),
        ),
      ];
      let landingRows = 0;
      // At most 65 rows per scope (a lower bound past 64) and 1 MiB per page plus one row.
      for (const scope of scopes) {
        let scanned = 0;
        for await (const row of scope as AsyncIterable<Record<string, unknown>>) {
          landingRows++;
          bytes += utf8(canonicalPayload(row));
          if (bytes > dryRunPageBytes) stopped = true;
          if (++scanned > dryRunScopeRows || stopped) {
            partial = true;
            break;
          }
        }
        if (stopped) break;
      }
      rows += landingRows;
      packCalls +=
        packCallsPerLanding + Math.ceil(Math.max(0, landingRows - capsulePageRows) / capsulePageRows);
    }
    const packed = page.packedPointers.reduce(
      (sum, pointer) => ({
        rows: sum.rows + pointerRows(pointer),
        rawBytes: sum.rawBytes + pointer.rawSize,
        compressedBytes: sum.compressedBytes + pointer.size,
      }),
      { rows: 0, rawBytes: 0, compressedBytes: 0 },
    );
    // The first page says whether the project still needs its one-time capsule index bootstrap.
    const index =
      input.cursor === null
        ? await ctx.db
            .query('projectFinishReadRows')
            .withIndex('by_kind_and_source', q =>
              q.eq('kind', capsuleIndexKind).eq('sourceId', input.projectId),
            )
            .unique()
        : undefined;
    return canonicalPayload({
      ...page.totals,
      ...(index === undefined ? {} : { indexBuilt: !!index && JSON.parse(index.value).done === true }),
      candidateRows: rows,
      candidateBytes: bytes,
      resumeRows,
      packCalls,
      partial,
      packedRows: packed.rows,
      packedRawBytes: packed.rawBytes,
      packedCompressedBytes: packed.compressedBytes,
      cursor: page.cursor,
      done: page.done,
    });
  },
});

const dryKeys = [
  ...(Object.keys(zero()) as Array<keyof Totals>),
  'candidateRows',
  'candidateBytes',
  'resumeRows',
  'packCalls',
  'packedRows',
  'packedRawBytes',
  'packedCompressedBytes',
] as const;
/** Read-only: sums dry-run pages for one project from `cursor`. Writes nothing and schedules nothing.
 * A large project returns `done: false` with its `cursor`; pass it back to continue. */
export const dryRun = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    cursor: v.optional(v.union(v.string(), v.null())),
    maxPages: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const maxPages = Math.max(1, Math.min(Math.floor(input.maxPages ?? 500), 2_000));
    const totals = Object.fromEntries(dryKeys.map(key => [key, 0])) as Record<
      (typeof dryKeys)[number],
      number
    >;
    let cursor: string | null = input.cursor ?? null,
      done = false,
      queryCalls = 0,
      partialPages = 0,
      indexBuilt: boolean | null = null;
    while (!done && queryCalls < maxPages) {
      const page = JSON.parse(
        await ctx.runQuery(makeFunctionReference<'query'>('projectLandingCapsuleBackfill:dryRunPage'), {
          projectId: input.projectId,
          cursor,
        }),
      );
      queryCalls++;
      for (const key of dryKeys) totals[key] += page[key] ?? 0;
      if (page.partial) partialPages++;
      if (page.indexBuilt !== undefined) indexBuilt = page.indexBuilt;
      cursor = page.cursor;
      done = page.done;
    }
    const landings = totals.scheduled + totals.resumed;
    const perPacked = totals.packed
      ? {
          rows: totals.packedRows / totals.packed,
          rawBytes: totals.packedRawBytes / totals.packed,
          compressedBytes: totals.packedCompressedBytes / totals.packed,
        }
      : null;
    return canonicalPayload({
      done,
      cursor: done ? null : cursor,
      dryRunQueryCalls: queryCalls,
      partialPages,
      // null when resumed from a cursor; false means the first run call bootstraps the index first.
      indexBuilt,
      ...totals,
      landings,
      // Backfill cost: scan pages at 64 requests each, plus the packer calls counted per landing.
      estimatedScanCalls: Math.ceil(totals.scanned / backfillPageRows),
      estimatedPackCalls: totals.packCalls,
      estimatedFromPacked: perPacked
        ? {
            perLanding: perPacked,
            rows: Math.round(perPacked.rows * totals.scheduled),
            rawBytes: Math.round(perPacked.rawBytes * totals.scheduled),
            compressedBytes: Math.round(perPacked.compressedBytes * totals.scheduled),
          }
        : null,
    });
  },
});
