// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import {
  hydrateMetricInputs,
  joinMetricAttempts,
  type MetricObjects,
  type MetricAttempt,
  type MetricLane,
  type MetricSave,
  type MetricPin,
} from './self-metrics-hosted-inputs.js';
import { hostedActionError } from './hosted-action-error.js';
import { invariant } from './errors.js';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { minutesBetween, type MetricPeriod, type MetricRecords } from './self-metrics-types.js';
import { readHostedBills } from './self-metrics-bills.js';
import { metricReceiptRowSchema } from './self-metric-receipts.js';
import { hostedCallerReceipts } from './self-metrics-hosted-receipts.js';
import { readPlacement } from './self-metrics-placement.js';
import { METRICS_CONTEXT_DAYS_DEFAULT, METRICS_CONTEXT_DAYS_MAX } from './self-metrics-page.js';
import { landingCostsSchema } from './hosted-landings-view.js';
export type MetricQuery = ((name: string, args: Record<string, unknown>) => Promise<unknown>) & {
  objects?: MetricObjects;
};
const pin = z.object({ sha256: z.string(), size: z.number().nonnegative() }).nullable().optional();
const stamp = z.iso.datetime(),
  nullableStamp = stamp.nullable();
const mutation = z.object({
  action: z.literal('cancel'),
  actor: z.string(),
  operationId: z.string(),
  at: stamp,
});
const rowSchemas = {
  acceptances: z.object({
    id: z.string(),
    at: stamp,
    head: z.string(),
    submissionId: z.string(),
    submittedAt: nullableStamp,
    trusted: z.boolean(),
    kind: z.enum(['landing', 'compensating']),
    path: z.literal('after-retry').optional(),
    attemptId: z.string().optional(),
    inputPin: pin,
    reused: z.boolean().optional(),
    revision: z.number().int().nonnegative().nullable().optional(),
    firstCheckRecheck: z.string().min(1).max(64).nullable().optional(),
    landedOnAdmissionRun: z.boolean().nullable().optional(),
    agentClient: z.string().max(100).nullable().optional(),
    costs: landingCostsSchema.optional(),
    settleSeconds: z.number().nonnegative().nullable().optional(),
  }),
  requests: z.object({
    id: z.string(),
    at: stamp,
    status: z.string(),
    runIds: z.array(z.string()),
    progressAt: z.array(stamp),
    errorCode: z.string().nullable(),
    compensating: z.boolean().optional(),
    noOwnerCause: z.string().nullable().optional(),
    retryCause: z.enum(['stall', 'conflict', 'check-failure-or-flake', 'other']).optional(),
    actor: z.string().optional(),
    operationId: z.string().optional(),
    attemptId: z.string().optional(),
    endedAt: nullableStamp.optional(),
    firstCheckRecheck: z.string().min(1).max(64).nullable().optional(),
    sharedBatch: z
      .object({ runId: z.string(), individualPassed: z.boolean(), likelyCulprit: z.boolean() })
      .nullable()
      .optional(),
    agentClient: z.string().max(100).nullable().optional(),
    retry: z
      .object({
        operationId: z.string(),
        actor: z.string(),
        supersedes: z.string(),
        reason: z.enum(['flake', 'main-moved', 'infra', 'other']),
      })
      .optional(),
  }),
  runs: z.object({
    id: z.string(),
    at: stamp,
    endedAt: nullableStamp,
    status: z.string(),
    head: z.string(),
    started: z.boolean(),
    runnerMinutes: z.number().nonnegative().nullable(),
    fullSuite: z.boolean().nullable(),
    scopedRecheck: z.literal(true).optional(),
    inputPin: pin,
    reuseKey: z.string().nullable().optional(),
    flaky: z
      .object({
        total: z.number().int().positive(),
        executionId: z.string().nullable().optional(),
        files: z
          .array(
            z.object({
              file: z.string(),
              attempts: z
                .array(z.object({ durationMs: z.number().nonnegative(), failed: z.boolean() }))
                .max(2)
                .optional(),
              firstError: z.string().max(512).optional(),
            }),
          )
          .max(8),
      })
      .nullable()
      .optional(),
    selectionFallback: z.string().min(1).max(64).nullable().optional(),
    gateFallback: z.string().min(1).max(64).nullable().optional(),
    auditRunnerSeconds: z.number().nonnegative().nullable().optional(),
  }),
  attempts: z.object({
    id: z.string(),
    submissionId: z.string(),
    at: stamp,
    parentAttemptId: z.string().nullable(),
    mainHead: z.string().nullable(),
    inputPin: pin,
    runId: z.string().nullable(),
    recheckReason: z.string().min(1).max(64).nullable().optional(),
    scopedFallback: z.string().min(1).max(64).nullable().optional(),
    /** Submitter as the server authenticated it; absent from older deployments. */
    actorKind: z.enum(['agent', 'person']).nullable().optional(),
  }),
  lanes: z.object({ id: z.string(), version: z.number(), intentId: z.string(), revert: z.boolean() }),
  saves: z.object({ id: z.string(), laneId: z.string(), head: z.string(), at: stamp }),
  operations: z.object({ id: z.string(), mutation: mutation.optional() }),
  receipts: metricReceiptRowSchema,
};
const audits = z.object({
  events: z
    .array(
      z.object({
        kind: z.enum(['red', 'green', 'flake', 'stalled', 'culprit']),
        at: stamp,
        sequence: z.number().int().nonnegative(),
        culprit: z.string().optional(),
      }),
    )
    .max(100),
  complete: z.boolean(),
});
const gaps = ['Hosted overlap acknowledgements and authority observations need durable coverage.'];
const pageSchema = (stream: keyof typeof rowSchemas) =>
  z.object({
    page: z.array(rowSchemas[stream]).max(100),
    isDone: z.boolean(),
    continueCursor: z.string(),
    cutover: nullableStamp,
    authority: sourceAuthoritySchema,
    coverage: z.record(z.string(), nullableStamp).optional(),
    audits: audits.optional(),
    contextFrom: stamp.optional(),
  });
type StreamPage = z.infer<ReturnType<typeof pageSchema>>;
const metricPage = async (
  query: MetricQuery,
  stream: keyof typeof rowSchemas,
  period: MetricPeriod,
  contextDays: number,
  cursor: string | null,
) => {
  const raw: unknown = await query('projectSelfMetrics:page', {
    stream,
    from: period.from,
    to: period.to,
    cursor,
    contextDays,
  });
  return pageSchema(stream).parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
};
/** One stream's pages in order, continuing from an already read first page. A stream is
 * sequential (each page needs the last cursor); the streams are independent, so the caller
 * reads them side by side. */
async function readStream(
  query: MetricQuery,
  stream: keyof typeof rowSchemas,
  period: MetricPeriod,
  contextDays: number,
  firstPageOnly: boolean,
  first?: StreamPage,
) {
  const pages: StreamPage[] = [];
  const seen = new Set<string>();
  let page = first ?? (await metricPage(query, stream, period, contextDays, null));
  for (;;) {
    pages.push(page);
    if (page.isDone || firstPageOnly) return pages;
    invariant(
      page.continueCursor && !seen.has(page.continueCursor),
      'EVIDENCE_CHANGED',
      'Hosted metric cursor did not advance.',
    );
    seen.add(page.continueCursor);
    page = await metricPage(query, stream, period, contextDays, page.continueCursor);
  }
}
/** `runsOnly` reads the runs stream alone (about one call per 100 check runs), with one day of
 * context and no bills, placement or input hydration: enough for the flake list (Issue d710663d).
 * `contextDays` bounds the pre-window history every stream also reads (default 2 days; status
 * summaries and `runsOnly` read 1): the window bounds the read, not a fixed 30-day horizon
 * (Issue e32cb0e7: 366 page calls and a 100 s timeout for a 2 h window). */
export async function readHostedMetricPages(
  query: MetricQuery,
  period: MetricPeriod,
  summary = false,
  runsOnly = false,
  requestedContextDays?: number,
) {
  const contextDays = Math.min(
    METRICS_CONTEXT_DAYS_MAX,
    Math.max(1, Math.floor(requestedContextDays ?? (summary || runsOnly ? 1 : METRICS_CONTEXT_DAYS_DEFAULT))),
  );
  // The horizon the server reports; an older deploy that ignores the argument reads 30 days.
  let contextFrom = new Date(Date.parse(period.from) - contextDays * 86400000).toISOString();
  const records: MetricRecords = {
    moves: [],
    submissions: [],
    runs: [],
    receipts: [],
    finishTimings: [],
    gaps: [...gaps],
    surfaceGaps: [],
    landingCoverageGaps: [],
    source: { kind: 'hosted' },
    fullResultsUnavailable:
      'Hosted results without explicit full-suite selection and pre-context boundary results remain unknown.',
    landingKindsComplete: true,
  };
  let cutover: string | null = null,
    reuseKeysProjected = true,
    flakesProjected = true;
  const pins = new Map<string, MetricPin>();
  const attempts: MetricAttempt[] = [],
    lanes: MetricLane[] = [],
    saves: MetricSave[] = [];
  const accepted = new Map<string, string>();
  const receiptRows: z.infer<typeof rowSchemas.receipts>[] = [];
  const retries: (MetricRecords['receipts'][number] & { submissionId: string })[] = [];
  let receiptCoverage: Record<string, string | null> | undefined;
  try {
    const streams = runsOnly
      ? (['runs'] as const)
      : summary
        ? (['acceptances', 'requests', 'runs', 'operations'] as const)
        : ([
            'acceptances',
            'requests',
            'runs',
            'operations',
            'attempts',
            'lanes',
            'saves',
            'receipts',
          ] as const);
    // One probe page first: a missing module, a refused caller or a bad window ends the read
    // after one call, not eight. The streams then run side by side (same calls, wall time of the
    // slowest stream) and are folded in the fixed order above, whatever order they arrive in.
    const probe = await metricPage(query, streams[0], period, contextDays, null);
    const fetched = await Promise.all(
      streams.map((stream, index) =>
        readStream(query, stream, period, contextDays, summary, index === 0 ? probe : undefined),
      ),
    );
    for (const [index, stream] of streams.entries()) {
      for (const page of fetched[index]!) {
        if (page.contextFrom && page.contextFrom < contextFrom) contextFrom = page.contextFrom;
        invariant(
          page.authority.mode === 'server',
          'SOURCE_AUTHORITY_CHANGED',
          'Hosted metrics require server source authority.',
        );
        if (records.source?.revision === undefined) {
          records.source!.revision = page.authority.epoch;
          cutover = page.cutover;
        }
        invariant(
          records.source?.revision === page.authority.epoch && cutover === page.cutover,
          'SOURCE_AUTHORITY_CHANGED',
          'Authority changed during metric pagination.',
        );
        for (const rawRow of page.page) {
          if (stream === 'acceptances') {
            const row = rowSchemas.acceptances.parse(rawRow);
            if (row.inputPin) pins.set(`move:${row.id}`, row.inputPin);
            accepted.set(row.submissionId, row.at);
            records.moves.push({
              id: row.id,
              at: row.at,
              head: row.head,
              kind: row.kind,
              path: row.path,
              ...(row.attemptId ? { attemptId: row.attemptId } : {}),
              ...(row.reused ? { reused: true } : {}),
              ...(row.revision != null ? { revision: row.revision } : {}),
              ...(row.firstCheckRecheck ? { firstCheckRecheck: row.firstCheckRecheck } : {}),
              inputs: [],
            });
            if (row.firstCheckRecheck === undefined) records.fallbacksUnprojected = true;
            if (row.reused === undefined) records.reuseUnprojected = true;
            records.finishTimings!.push({
              id: row.id,
              at: row.at,
              trusted: row.trusted,
              minutes: minutesBetween(row.submittedAt ?? '', row.at) ?? null,
              onAdmissionRun: row.landedOnAdmissionRun ?? null,
              ...(row.costs ? { costs: row.costs } : {}),
              ...(row.settleSeconds != null ? { settleSeconds: row.settleSeconds } : {}),
            });
          } else if (stream === 'runs') {
            const row = rowSchemas.runs.parse(rawRow);
            if (row.inputPin) pins.set(`run:${row.id}`, row.inputPin);
            const { reuseKey, flaky, selectionFallback, gateFallback, auditRunnerSeconds, ...run } = row;
            if (selectionFallback === undefined) records.fallbacksUnprojected = true;
            if (reuseKey === undefined) reuseKeysProjected = false;
            if (flaky === undefined) flakesProjected = false;
            records.runs.push({
              ...run,
              inputs: [],
              endedAt: row.endedAt ?? undefined,
              wallMinutes: minutesBetween(row.at, row.endedAt ?? undefined),
              runnerMinutes: row.runnerMinutes ?? undefined,
              fullSuite: row.fullSuite ?? false,
              ...(reuseKey ? { reuseKey } : {}),
              ...(flaky ? { flaky } : {}),
              ...(selectionFallback ? { selectionFallback } : {}),
              ...(gateFallback ? { gateFallback } : {}),
              ...(auditRunnerSeconds !== undefined ? { auditRunnerSeconds } : {}),
            });
            // Hosted landing never adopts earlier check evidence: each run row is its own request.
            (records.checkRequests ??= []).push({
              id: row.id,
              at: row.at,
              runId: row.id,
              reused: false,
              ...(reuseKey ? { reuseKey } : {}),
            });
          } else if (stream === 'requests') {
            const row = rowSchemas.requests.parse(rawRow);
            if (row.firstCheckRecheck === undefined) records.secondChecksUnprojected = true;
            if (row.retry)
              retries.push({
                schema: 1,
                kind: 'mutation',
                origin: 'command',
                action: 'retry',
                at: row.at,
                operationId: row.retry.operationId,
                actor: { kind: 'account', name: row.retry.actor },
                submissionId: row.id,
              });
            records.submissions.push({
              ...row,
              ...(row.noOwnerCause ? { noOwner: true } : {}),
              entryId: row.id,
              entryAt: row.at,
              entryStatus: row.status,
              inputs: [],
              endedAt: row.endedAt ?? undefined,
              ...(row.retry ? { supersedes: row.retry.supersedes, retryReason: row.retry.reason } : {}),
              status: row.status === 'terminal-failed' ? 'failed' : row.status,
            });
          } else if (stream === 'attempts') {
            const row = rowSchemas.attempts.parse(rawRow);
            if (row.recheckReason === undefined) records.fallbacksUnprojected = true;
            attempts.push(row);
          } else if (stream === 'lanes') {
            lanes.push(rowSchemas.lanes.parse(rawRow));
          } else if (stream === 'saves') {
            saves.push(rowSchemas.saves.parse(rawRow));
          } else if (stream === 'receipts') {
            receiptRows.push(rowSchemas.receipts.parse(rawRow));
          } else {
            const row = rowSchemas.operations.parse(rawRow);
            if (row.mutation)
              records.receipts.push({
                schema: 1,
                kind: 'mutation',
                origin: 'command',
                ...row.mutation,
                // Legacy cancel rows record the account only, never agent or person.
                actor: { kind: 'account', name: row.mutation.actor },
              });
          }
        }
        if (page.coverage) receiptCoverage = page.coverage;
        if (page.audits) records.mainAudits = page.audits;
        if (summary && !page.isDone) {
          records.surfaceGaps!.push(
            `Status read one hosted ${stream} page; use metrics for the remaining records.`,
          );
        }
      }
    }
  } catch (error) {
    const missing =
      error instanceof Error &&
      /(?:Could not find (?:public )?function|function[^\n]*not found|no function)[^\n]*projectSelfMetrics/i.test(
        error.message,
      );
    if (!missing) throw hostedActionError(error, 'metrics');
    records.error = {
      code: 'METRICS_UNAVAILABLE',
      message: 'Deploy the projectSelfMetrics Convex module before reading hosted metrics.',
    };
    records.surfaceGaps!.push(
      'METRICS_UNAVAILABLE: the hosted self-metrics module is unavailable; no native fallback was used.',
    );
  }
  const contextHours = Math.round((Date.parse(period.from) - Date.parse(contextFrom)) / 3600000);
  records.landingCoverageGaps!.push(
    `Hosted classification reads ${contextHours % 24 === 0 ? `${contextHours / 24} day${contextHours === 24 ? '' : 's'}` : `${contextHours} hours`} of pre-window context (from ${contextFrom}); older submission/save history and changes during live pagination can leave ordering incomplete. Widen it with contextDays (at most ${METRICS_CONTEXT_DAYS_MAX}).`,
  );
  if (!flakesProjected) records.flakesUnprojected = true;
  if (reuseKeysProjected && cutover) records.coverage = { ...records.coverage, checkRequests: cutover };
  else records.gaps.push('Hosted reuse keys need the deployed projectSelfMetrics runs projection.');
  // Who submitted each landing, as the server authenticated it: the first attempt names the submitter.
  const submitter = new Map<string, 'agent' | 'person'>();
  for (const attempt of [...attempts].sort((a, b) => a.at.localeCompare(b.at)))
    if (attempt.actorKind && !submitter.has(attempt.submissionId))
      submitter.set(attempt.submissionId, attempt.actorKind);
  for (const { submissionId, ...retry } of retries)
    records.receipts.push({
      ...retry,
      actor: { kind: submitter.get(submissionId) ?? 'account', name: retry.actor.name },
    });
  if (!records.error && !summary && !runsOnly) {
    records.billHistoryFrom = contextFrom;
    await readHostedBills(query, period, records).catch(error => {
      throw hostedActionError(error, 'metrics');
    });
    hostedCallerReceipts(records, receiptRows, receiptCoverage, period);
    await readPlacement(query, period, records);
    const requests = records.submissions;
    joinMetricAttempts(records, attempts, pins);
    await hydrateMetricInputs(records, pins, lanes, saves, query.objects);
    const selectedByEntry = new Map<string, Set<string>>();
    for (const row of records.submissions) {
      const ids = selectedByEntry.get(row.entryId) ?? new Set<string>();
      for (const input of row.inputs) ids.add(input.intentId);
      selectedByEntry.set(row.entryId, ids);
    }
    const seenIntents = new Set<string>();
    for (const request of [...requests].sort((a, b) => a.at.localeCompare(b.at))) {
      const intents = selectedByEntry.get(request.entryId) ?? new Set<string>();
      if (!request.supersedes && [...intents].some(id => seenIntents.has(id)))
        records.receipts.push({
          schema: 1,
          kind: 'mutation',
          origin: 'command',
          action: 'resubmit',
          at: request.at,
          operationId: request.operationId ?? request.entryId,
          actor: { kind: submitter.get(request.entryId) ?? 'account', name: request.actor ?? 'unknown' },
        });
      for (const id of intents) seenIntents.add(id);
    }
  }
  const unattributed = records.receipts.filter(
    r =>
      r.kind === 'mutation' &&
      r.actor.kind === 'account' &&
      Date.parse(r.at) >= Date.parse(period.from) &&
      Date.parse(r.at) < Date.parse(period.to),
  ).length;
  if (unattributed)
    (records.mutationCoverageGaps ??= []).push(
      `${unattributed} interventions have no recorded agent or person (written before attribution was recorded) and are shown as account:NAME.`,
    );
  for (const submission of records.submissions) submission.landedAt = accepted.get(submission.entryId);
  return { records, cutover };
}
