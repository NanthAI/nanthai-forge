// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { metricRunRow } from '../src/self-metrics-run';
import type { HostedCheckRun } from '../src/hosted-check';
import type { HostedLandingAttempt } from '../src/hosted-landing';
import { classifyRuns, type StatsAttempt, type StatsRun, type StatsStopCause } from '../src/stats-runs';
import { metricRunKind } from './projectMetricReadProjection';
import { capsuleIndexKind } from './projectLandingCapsuleIndex';
import { landingRequestOriginalDb } from './projectLandingRequestBody';
import { workRecordOriginalDb } from './projectWorkRecordWriter';

/** Every check run started on one closed day, for Stats (Item a61d3c91; src/stats-runs.ts). Read once, at the day's
 * close, from the compact metric rows metrics 5.6 reads, plus the few run rows not projected yet (a run inserted and
 * never updated, such as one still queued), with the landing attempts that name each run. Every read is capped; a
 * busier day is marked partial, and nothing past a cap is guessed:
 * - STATS_CLOSE_RUNS compact run rows (about 1 KB each) and STATS_CLOSE_UNPROJECTED_RUNS full run rows;
 * - STATS_CLOSE_ATTEMPTS attempt rows (compact rows, or the attempt rows themselves while the project's compact
 *   attempt index is still being built);
 * - STATS_CLOSE_LOOKUPS compact landing rows, one per submission whose passed run neither landed that day nor was
 *   rechecked (to tell a later landing, work still waiting and work replaced or withdrawn apart);
 * - and the transaction's own read meter (`statsRoom`): every read of the close counts there, whoever makes it, and
 *   each reader stops while it still leaves its `keep` of one Convex transaction's 16 MiB and 4,096 queries, so a busy
 *   day is partial rather than a close that fails and holds up the days after it. Runs and attempts are read a page at
 *   a time so the meter can stop them between pages. */
export const STATS_CLOSE_RUNS = 3_000;
export const STATS_CLOSE_UNPROJECTED_RUNS = 200;
export const STATS_CLOSE_ATTEMPTS = 6_000;
export const STATS_CLOSE_LOOKUPS = 300;
export const STATS_CLOSE_PAGE = 200;
/** Full run rows are read one at a time: one can be up to Convex's 1 MiB document limit (a shard pool's 4,096 pending
 * paths, contract reports), so a read past the meter's check stays inside the room it keeps (review d6b0f1aa finding
 * 6). They are few: rows written before their projection (convex/projectMetricReadWriter.ts). */
export const STATS_CLOSE_UNPROJECTED_PAGE = 1;
/** What a reader leaves of the transaction when it stops: queries (index ranges and gets), bytes and documents read,
 * and for a writer the documents and bytes it may still write. */
export type StatsKeep = {
  queries: number;
  bytes: number;
  documents: number;
  writes?: { documents: number; bytes: number };
};
/** The runs and their lookups stop here: room for one more page (at most 200 compact rows of a few KB, or one full run
 * row of at most 1 MiB) and the close's writes. */
export const STATS_RUNS_KEEP: StatsKeep = { queries: 64, bytes: 2 * 1024 * 1024, documents: 400 };
/** The landings stop here, after a person's day is read: room for the person-day writes and at least a share of the
 * day's runs. */
export const STATS_LANDINGS_KEEP: StatsKeep = { queries: 1_000, bytes: 5 * 1024 * 1024, documents: 1_000 };
/** People's days stop here (one read and one write per person and day, convex/personDays.ts#recordPersonDays): room
 * for the day's runs (their pages, attempts and lookups take a few hundred queries) and the close's own writes. */
export const STATS_PEOPLE_KEEP: StatsKeep = {
  queries: 700,
  bytes: 4 * 1024 * 1024,
  documents: 1_000,
  writes: { documents: 200, bytes: 2 * 1024 * 1024 },
};
/** The transaction still has more than `keep` left to read (Convex: 4,096 queries, 16 MiB, 32,000 documents) and, for
 * a writer, to write (Convex's documents and bytes written per transaction). */
export async function statsRoom(ctx: Pick<MutationCtx, 'meta'>, keep: StatsKeep) {
  const left = await ctx.meta.getTransactionMetrics();
  return (
    left.databaseQueries.remaining > keep.queries &&
    left.bytesRead.remaining > keep.bytes &&
    left.documentsRead.remaining > keep.documents &&
    (keep.writes === undefined ||
      (left.documentsWritten.remaining > keep.writes.documents &&
        left.bytesWritten.remaining > keep.writes.bytes))
  );
}
/** Attempts are read from this long before the day (a run's attempt starts before it) to this long after it (a
 * recompose after main moved may follow a late run past midnight). */
const ATTEMPTS_LEAD_MS = 6 * 3_600_000;
const ATTEMPTS_TRAIL_MS = 2 * 86_400_000;

/** Why a reader stopped short (src/stats-runs.ts#STATS_STOP_CAUSES): its own row cap, the transaction's read room, or a
 * full page at one shared instant. */
type Stop = 'cap' | 'meter' | 'instant';
/** Rows of one time range, oldest first, a page of `size` rows at a time until `cap` rows or no room: `page(from,
 * after)` reads up to `size` rows at or after `from` (strictly after it once `after`, for a time no two rows share,
 * such as `_creationTime`). Rows at one shared instant past a full page are not read (partial); `stop` says which. */
async function pages<T extends { _id: string }>(
  ctx: Pick<MutationCtx, 'meta'>,
  page: (from: number, after: boolean) => Promise<T[]>,
  time: (row: T) => number,
  start: number,
  cap: number,
  size = STATS_CLOSE_PAGE,
  unique = false,
) {
  const rows: T[] = [];
  const seen = new Set<string>();
  let from = start,
    after = false;
  const stopped = (stop: Stop) => ({ rows, partial: true as const, stop });
  for (;;) {
    if (!(await statsRoom(ctx, STATS_RUNS_KEEP))) return stopped('meter');
    const chunk = await page(from, after);
    for (const row of chunk) {
      if (seen.has(row._id)) continue;
      if (rows.length >= cap) return stopped('cap');
      seen.add(row._id);
      rows.push(row);
    }
    if (chunk.length < size) return { rows, partial: false as const, stop: null };
    const last = time(chunk.at(-1)!);
    if (!unique && last === from) return stopped('instant');
    from = last;
    after = unique;
  }
}

const ms = (iso: string | null | undefined) => {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(value) ? value : null;
};
type RunRow = ReturnType<typeof metricRunRow>;
const statsRun = (row: RunRow): StatsRun => ({
  id: row.id,
  at: ms(row.at) ?? 0,
  endedAt: ms(row.endedAt),
  status: row.status,
  runnerSeconds: row.runnerMinutes === null ? null : row.runnerMinutes * 60,
  fullSuite: row.fullSuite,
  scopedRecheck: row.scopedRecheck === true,
  // Rows projected before the explicit flag know an audit only once it ended with execution seconds.
  audit: row.audit === true || row.auditRunnerSeconds !== null,
});

async function dayRuns(ctx: MutationCtx, projectId: Id<'hostedProjects'>, from: number, to: number) {
  const compact = await pages(
    ctx,
    at =>
      ctx.db
        .query('projectFinishReadRows')
        .withIndex('by_kind_and_project_and_source_time', q =>
          q
            .eq('kind', metricRunKind)
            .eq('projectId', projectId)
            .gte('sourceCreatedAt', at)
            .lt('sourceCreatedAt', to),
        )
        .take(STATS_CLOSE_PAGE),
    // Rows in a sourceCreatedAt range always carry it.
    row => row.sourceCreatedAt ?? 0,
    from,
    STATS_CLOSE_RUNS,
  );
  // A run row not projected (or whose projection was invalidated) is read itself; it wins over a stale compact row.
  const unprojected = await pages(
    ctx,
    (at, after) =>
      ctx.db
        .query('projectHostedCheckRuns')
        .withIndex('by_project_and_metrics_projection', q => {
          const range = q.eq('projectId', projectId).eq('metricsProjected', undefined);
          return (after ? range.gt('_creationTime', at) : range.gte('_creationTime', at)).lt(
            '_creationTime',
            to,
          );
        })
        .take(STATS_CLOSE_UNPROJECTED_PAGE),
    row => row._creationTime,
    from,
    STATS_CLOSE_UNPROJECTED_RUNS,
    STATS_CLOSE_UNPROJECTED_PAGE,
    true,
  );
  const rows = new Map<string, RunRow>();
  for (const row of compact.rows) {
    const value = JSON.parse(row.value) as RunRow;
    rows.set(value.id, value);
  }
  for (const row of unprojected.rows) {
    const value = metricRunRow(JSON.parse(row.value) as HostedCheckRun, row.reportFlakes);
    rows.set(value.id, value);
  }
  const stops: StatsStopCause[] = [
    ...(compact.stop ? [`runs:${compact.stop}` as const] : []),
    ...(unprojected.stop && unprojected.stop !== 'instant'
      ? [`unprojected:${unprojected.stop}` as const]
      : []),
  ];
  return { runs: [...rows.values()].map(statsRun), partial: compact.partial || unprojected.partial, stops };
}

async function dayAttempts(ctx: MutationCtx, projectId: Id<'hostedProjects'>, from: number, to: number) {
  const index = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_source', q => q.eq('kind', capsuleIndexKind).eq('sourceId', projectId))
    .unique();
  if (index && (JSON.parse(index.value) as { done?: boolean }).done) {
    const read = await pages(
      ctx,
      at =>
        ctx.db
          .query('projectFinishReadRows')
          .withIndex('by_kind_and_project_and_source_time', q =>
            q
              .eq('kind', 'projectHostedLandingAttempts')
              .eq('projectId', projectId)
              .gte('sourceCreatedAt', at)
              .lt('sourceCreatedAt', to),
          )
          .take(STATS_CLOSE_PAGE),
      row => row.sourceCreatedAt ?? 0,
      from,
      STATS_CLOSE_ATTEMPTS,
    );
    const attempts: StatsAttempt[] = read.rows.map(row => {
      const outer = JSON.parse(row.value) as { attemptId: string; submissionId: string; value: string };
      const metric = (JSON.parse(outer.value) as { metric: unknown[] }).metric;
      return {
        id: outer.attemptId,
        submissionId: outer.submissionId,
        parentAttemptId: typeof metric[1] === 'string' ? metric[1] : null,
        runId: typeof metric[3] === 'string' ? metric[3] : null,
        member: metric[7] !== null && metric[7] !== undefined,
        mainRace: typeof metric[4] === 'string',
      };
    });
    return { attempts, partial: read.partial, stops: read.stop ? [`attempts:${read.stop}` as const] : [] };
  }
  // The compact attempt index is not built yet (convex/projectLandingCapsuleIndex.ts): the attempt rows themselves,
  // about three times the bytes, so the read meter stops them sooner.
  const read = await pages(
    ctx,
    at =>
      ctx.db
        .query('projectHostedLandingAttempts')
        .withIndex('by_project', q =>
          q.eq('projectId', projectId).gte('_creationTime', at).lt('_creationTime', to),
        )
        .take(STATS_CLOSE_PAGE),
    row => row._creationTime,
    from,
    STATS_CLOSE_ATTEMPTS,
  );
  const attempts: StatsAttempt[] = read.rows.map(row => {
    const a = JSON.parse(row.value) as HostedLandingAttempt;
    return {
      id: a.id,
      submissionId: a.submissionId,
      parentAttemptId: a.parentAttemptId ?? null,
      runId: a.check?.runId ?? null,
      member: a.memberCandidate !== undefined,
      mainRace: a.recheckReason !== undefined,
    };
  });
  return { attempts, partial: read.partial, stops: read.stop ? [`attempts:${read.stop}` as const] : [] };
}

/** A submission's phase and current attempt, from its compact landing row (or the landing row before compact rows). */
async function landingFate(ctx: MutationCtx, projectId: Id<'hostedProjects'>, submissionId: string) {
  const peer = await ctx.db
    .query('projectFinishReadRows')
    .withIndex('by_kind_and_project_and_submission', q =>
      q.eq('kind', 'projectHostedLandingPeers').eq('projectId', projectId).eq('submissionId', submissionId),
    )
    .first();
  if (peer) return JSON.parse(peer.value) as { phase: string; attemptId: string };
  // Before compact landing rows: the landing row's own columns, without its body pages.
  const row = await landingRequestOriginalDb(workRecordOriginalDb(ctx.db))
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_submission', q =>
      q.eq('projectId', projectId).eq('submissionId', submissionId),
    )
    .unique();
  return row ? { phase: row.phase, attemptId: row.attemptId } : null;
}

export async function statsDayRuns(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  from: number,
  to: number,
  landedAttemptIds: ReadonlySet<string>,
) {
  const read = await dayRuns(ctx, projectId, from, to);
  const window = await dayAttempts(ctx, projectId, from - ATTEMPTS_LEAD_MS, to + ATTEMPTS_TRAIL_MS);
  const { runs } = read,
    { attempts } = window;
  // A passed run whose attempt did not land that day and was not rechecked: read its landing once to tell a later
  // landing (accepted), work still waiting (pending) and work replaced or withdrawn (superseded).
  const accepted = new Set(landedAttemptIds);
  const pending = new Set<string>();
  const unread = new Set<string>();
  const lookupStops = new Set<StatsStopCause>();
  const byRun = new Map<string, StatsAttempt[]>();
  for (const a of attempts) if (a.runId) byRun.set(a.runId, [...(byRun.get(a.runId) ?? []), a]);
  const parents = new Set(attempts.flatMap(a => (a.parentAttemptId ? [a.parentAttemptId] : [])));
  const looked = new Set<string>();
  for (const run of runs) {
    if (run.audit || run.status !== 'passed') continue;
    const mine = byRun.get(run.id) ?? [];
    if (mine.some(a => accepted.has(a.id) || parents.has(a.id))) continue;
    for (const submissionId of new Set(mine.map(a => a.submissionId))) {
      if (looked.has(submissionId) || unread.has(submissionId)) continue;
      const capped = looked.size >= STATS_CLOSE_LOOKUPS;
      if (capped || !(await statsRoom(ctx, STATS_RUNS_KEEP))) {
        unread.add(submissionId);
        lookupStops.add(capped ? 'lookups:cap' : 'lookups:meter');
        continue;
      }
      looked.add(submissionId);
      const fate = await landingFate(ctx, projectId, submissionId);
      if (!fate) continue;
      if (fate.phase === 'landed') accepted.add(fate.attemptId);
      else if (fate.phase !== 'terminal-failed') pending.add(submissionId);
    }
  }
  return classifyRuns({
    runs,
    attempts,
    landedAttemptIds: accepted,
    pendingSubmissionIds: pending,
    unreadSubmissionIds: unread,
    partial: read.partial || window.partial || unread.size > 0,
    stops: [...read.stops, ...window.stops, ...lookupStops],
  });
}
