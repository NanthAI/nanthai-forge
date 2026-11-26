// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { gzipSync, gunzipSync } from 'fflate';
import { makeFunctionReference } from 'convex/server';
import { writableHostedCheck, writeHostedCheck } from './projectHostedCheckStore';
import { invariant } from '../src/errors';
import { checkPin } from '../src/hosted-check';
import { z } from 'zod';
import { internalMutation } from './server';
import {
  reportsDetached,
  detachCheckReports,
  hydrateCheckReports,
  objectReportTransport,
} from './projectHostedCheckReports';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedCheckRun } from '../src/hosted-check';
import { hostedCheckRunSchema } from '../src/hosted-check';
import { parseTimingHistory, updateHostedTimingHistory } from '../src/hosted-test-timings';
import { emptyHistory, timingHistoryLimits } from '../scripts/test-shards.mjs';
import { checkTimeEvidence } from '../src/check-time-added';
import { isScopedRecheck } from '../src/scoped-recheck-policy';
import { isStandardForgeCheck } from '../src/standard-check';

export function encodeTimingHistoryRow(text: string) {
  const body = gzipSync(new TextEncoder().encode(text), { level: 6, mtime: 0 });
  invariant(
    body.byteLength <= timingHistoryLimits.bytes - 2048,
    'BAD_ARGUMENT',
    'The compressed timing history must fit its existing document.',
  );
  return { history: '', compressed: body.slice().buffer };
}

// fflate's bounded synchronous decoder does not check the gzip CRC.
const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc;
});

export function decodeTimingHistoryRow(
  row: Pick<Doc<'projectHostedTestTimings'>, 'history' | 'compressed'> | null,
) {
  if (!row?.compressed) return parseTimingHistory(row?.history ?? '');
  const body = new Uint8Array(row.compressed);
  // This writer emits a fixed header. Reject optional fields before fflate scans them.
  if (body.length < 18 || body.length > timingHistoryLimits.bytes || body[3] !== 0) return emptyHistory();
  const trailer = new DataView(row.compressed, body.length - 8, 8);
  const rawSize = trailer.getUint32(4, true);
  if (rawSize > timingHistoryLimits.bytes) return emptyHistory();
  try {
    const plain = gunzipSync(body, { out: new Uint8Array(rawSize) });
    if (plain.length !== rawSize) return emptyHistory();
    let crc = 0xffffffff;
    for (const byte of plain) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
    if (~crc >>> 0 !== trailer.getUint32(0, true)) return emptyHistory();
    return parseTimingHistory(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch {
    return emptyHistory();
  }
}

/** Same advisory JSON/EWMA as the native owner's .forge/work/test-timings.json.
 * One indexed document, read/written inside existing authorized transactions.
 * Serialization reserves room for the document fields. */
export async function hostedTimingHistory(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  excludeRunId?: string,
) {
  const row = await ctx.db
    .query('projectHostedTestTimings')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  let history = decodeTimingHistoryRow(row);
  if (!row) {
    // Bootstrap from already retained fixed-runner reports. At most one latest
    // run per terminal status, never a run-history scan or an extra function call.
    const recent: HostedCheckRun[] = [];
    for (const status of ['passed', 'failed']) {
      const latest = await ctx.db
        .query('projectHostedCheckRuns')
        .withIndex('by_project_and_status', q => q.eq('projectId', projectId).eq('status', status))
        .order('desc')
        .take(1);
      for (const item of latest) {
        if (item.runId === excludeRunId) continue;
        try {
          const parsed = hostedCheckRunSchema.safeParse(JSON.parse(item.value));
          if (parsed.success) {
            // Inline-report reader: remove on 2026-12-31 (see projectHostedCheckStore.ts).
            if (item.reportParts !== undefined) {
              detachCheckReports(parsed.data, item.reportParts, item.reportDigest ?? '');
              await hydrateCheckReports(ctx, parsed.data);
            }
            if (parsed.data.contractReports) recent.push(parsed.data);
          }
        } catch {
          /* Advisory, malformed old metadata supplies no weights. */
        }
      }
    }
    for (const run of recent.sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? '')))
      history = parseTimingHistory(updateHostedTimingHistory(JSON.stringify(history), run));
  }
  return { row, history };
}

const reportDurations = (run: HostedCheckRun) =>
  Object.fromEntries(
    Object.entries(run.contractReports ?? {}).flatMap(([file, report]) =>
      report.durationMs === undefined ? [] : [[file, report.durationMs]],
    ),
  );

export async function recordHostedTestTimings(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  run: HostedCheckRun,
  durations?: Record<string, number>,
  final = true,
) {
  if (!['passed', 'failed'].includes(run.status)) return;
  const transport = objectReportTransport(run);
  if (transport && durations === undefined) return;
  if (!run.contractReports && durations === undefined) {
    if (reportsDetached(run))
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedTestTimings:record'), {
        projectId,
        runId: run.id,
      });
    return;
  }
  const part = durations === undefined ? undefined : checkPin({ durations, final });
  if (transport && part) {
    if (transport.timingParts?.includes(part)) return;
    invariant(!transport.timingComplete, 'EVIDENCE_CHANGED', 'Final timing arguments are immutable.');
  }
  const { row, history } = await hostedTimingHistory(ctx, projectId, run.id);
  if (history.runs.includes(run.id)) return;
  let stamp = transport?.timingStamp;
  if (transport) {
    if (
      !history.generation ||
      !Number.isSafeInteger(history.sample) ||
      history.sample! >= Number.MAX_SAFE_INTEGER
    ) {
      history.generation = crypto.randomUUID();
      history.sample = 0;
    }
    if (!stamp) {
      stamp = { generation: history.generation, sequence: ++history.sample! };
      transport.timingStamp = stamp;
    }
    invariant(
      stamp.generation === history.generation,
      'EVIDENCE_CHANGED',
      'Timing history changed during its argument pages.',
    );
  }
  // Check-time evidence (Issue a217b83e): this run's files against the history already read, once, for a
  // run whose timings arrive in one final part. The caller's existing run write keeps it. A whole run also
  // names files it no longer runs; a contract-selected run of Forge's own check recipe (never a main-race
  // scoped recheck) names new files only (src/check-time-added.ts says why nothing is lost). Only that
  // recipe's selector sends a deleted or renamed path to a full run: a configured (BYO CI) command that
  // declares `selection: changed-paths` scopes without it, so its selected runs are not judged (review d2d1a7e8).
  const whole = (run.gate === undefined || run.gate.effective === 'full') && !run.plan?.scoped;
  const selected =
    run.gate?.effective === 'contract' &&
    !run.plan?.scoped &&
    !isScopedRecheck(run.gate) &&
    isStandardForgeCheck(run.check);
  const evidence =
    (whole || selected) && final && !transport?.timingParts?.length
      ? checkTimeEvidence(history.files, durations ?? reportDurations(run), whole)
      : null;
  if (evidence) run.checkTime = evidence;
  const value = {
    projectId,
    ...encodeTimingHistoryRow(
      updateHostedTimingHistory(JSON.stringify(history), run, durations, stamp?.sequence, final),
    ),
  };
  if (transport && part) {
    transport.timingParts = [...(transport.timingParts ?? []), part];
    if (final) transport.timingComplete = true;
  }
  if (row) await ctx.db.replace(row._id, value);
  else await ctx.db.insert('projectHostedTestTimings', value);
}

/** Provider completion keeps the webhook slim; timing metadata is read once after that event. */
export const record = internalMutation({
  args: { projectId: v.id('hostedProjects'), runId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await ctx.db
      .query('projectHostedCheckRuns')
      .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
      .unique();
    if (!row || row.reportStorage === 'r2') return null;
    const run = hostedCheckRunSchema.parse(JSON.parse(row.value));
    // Inline-report reader: remove on 2026-12-31 with the one in projectHostedCheckStore.ts, once no inline run remains.
    if (row.reportParts !== undefined) {
      detachCheckReports(run, row.reportParts, row.reportDigest ?? '');
      await hydrateCheckReports(ctx, run);
    }
    await recordHostedTestTimings(ctx, input.projectId, run);
    return null;
  },
});

/** Only oversized duration arguments need continuation pages; the ordinary collector still settles once. */
export const argumentsPage = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    runId: v.string(),
    reportDigest: v.string(),
    durations: v.string(),
    final: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    invariant(
      new TextEncoder().encode(input.durations).length <= 768 * 1024,
      'BAD_ARGUMENT',
      'Page timing arguments.',
    );
    const { run, row } = await writableHostedCheck(ctx, input);
    const transport = objectReportTransport(run);
    invariant(
      transport && run.reportPointer?.digest === input.reportDigest,
      'EVIDENCE_CHANGED',
      'Record timing arguments for their original report pin.',
    );
    if (
      typeof transport.conclusion !== 'string' ||
      transport.conclusion === 'cancelled' ||
      run.cancelRequested
    )
      return null;
    const before = JSON.stringify(transport);
    await recordHostedTestTimings(
      ctx,
      input.projectId,
      run,
      z.record(z.string(), z.number().finite().nonnegative()).parse(JSON.parse(input.durations)),
      input.final,
    );
    if (JSON.stringify(transport) !== before) await writeHostedCheck(ctx, row._id, run);
    return null;
  },
});
