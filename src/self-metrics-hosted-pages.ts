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
  }),
  requests: z.object({
    id: z.string(),
    at: stamp,
    status: z.string(),
    runIds: z.array(z.string()),
    progressAt: z.array(stamp),
    errorCode: z.string().nullable(),
    retryCause: z.enum(['stall', 'conflict', 'check-failure-or-flake', 'other']).optional(),
    actor: z.string().optional(),
    operationId: z.string().optional(),
    attemptId: z.string().optional(),
    endedAt: nullableStamp.optional(),
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
    inputPin: pin,
  }),
  attempts: z.object({
    id: z.string(),
    submissionId: z.string(),
    at: stamp,
    parentAttemptId: z.string().nullable(),
    mainHead: z.string().nullable(),
    inputPin: pin,
    runId: z.string().nullable(),
  }),
  lanes: z.object({ id: z.string(), version: z.number(), intentId: z.string(), revert: z.boolean() }),
  saves: z.object({ id: z.string(), laneId: z.string(), head: z.string(), at: stamp }),
  operations: z.object({ id: z.string(), mutation: mutation.optional() }),
};
const gaps = [
  'Hosted caller-visible lifecycle errors and no-owner incident tags are not recorded.',
  'Hosted terminal delivery, overlap acknowledgements, provider bills and authority observations need durable coverage.',
  'Hosted reuse keys and request/adoption receipts remain unavailable.',
];
export async function readHostedMetricPages(query: MetricQuery, period: MetricPeriod, summary = false) {
  const records: MetricRecords = {
    moves: [],
    submissions: [],
    runs: [],
    receipts: [],
    finishTimings: [],
    gaps: [...gaps],
    surfaceGaps: [],
    landingCoverageGaps: [
      'Hosted classification reads 30 days of pre-window context; older submission/save history and changes during live pagination can leave ordering incomplete.',
    ],
    source: { kind: 'hosted' },
    fullResultsUnavailable:
      'Hosted results without explicit full-suite selection and pre-context boundary results remain unknown.',
    landingKindsComplete: true,
  };
  let cutover: string | null = null;
  const pins = new Map<string, MetricPin>();
  const attempts: MetricAttempt[] = [],
    lanes: MetricLane[] = [],
    saves: MetricSave[] = [];
  const accepted = new Map<string, string>();
  try {
    for (const stream of summary
      ? (['acceptances', 'requests', 'runs', 'operations'] as const)
      : (['acceptances', 'requests', 'runs', 'operations', 'attempts', 'lanes', 'saves'] as const)) {
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const raw = await query('projectSelfMetrics:page', {
          stream,
          from: period.from,
          to: period.to,
          cursor,
          contextDays: summary ? 1 : 30,
        });
        const page = z
          .object({
            page: z.array(rowSchemas[stream]).max(100),
            isDone: z.boolean(),
            continueCursor: z.string(),
            cutover: nullableStamp,
            authority: sourceAuthoritySchema,
          })
          .parse(typeof raw === 'string' ? JSON.parse(raw) : raw);
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
              inputs: [],
            });
            records.finishTimings!.push({
              id: row.id,
              at: row.at,
              trusted: row.trusted,
              minutes: minutesBetween(row.submittedAt ?? '', row.at) ?? null,
            });
          } else if (stream === 'runs') {
            const row = rowSchemas.runs.parse(rawRow);
            if (row.inputPin) pins.set(`run:${row.id}`, row.inputPin);
            records.runs.push({
              ...row,
              inputs: [],
              endedAt: row.endedAt ?? undefined,
              wallMinutes: minutesBetween(row.at, row.endedAt ?? undefined),
              runnerMinutes: row.runnerMinutes ?? undefined,
              fullSuite: row.fullSuite ?? false,
            });
          } else if (stream === 'requests') {
            const row = rowSchemas.requests.parse(rawRow);
            if (row.retry)
              records.receipts.push({
                schema: 1,
                kind: 'mutation',
                origin: 'command',
                action: 'retry',
                at: row.at,
                operationId: row.retry.operationId,
                actor: { kind: 'agent', name: row.retry.actor },
              });
            records.submissions.push({
              ...row,
              entryId: row.id,
              entryAt: row.at,
              entryStatus: row.status,
              inputs: [],
              endedAt: row.endedAt ?? undefined,
              ...(row.retry ? { supersedes: row.retry.supersedes, retryReason: row.retry.reason } : {}),
              status: row.status === 'terminal-failed' ? 'failed' : row.status,
            });
          } else if (stream === 'attempts') {
            attempts.push(rowSchemas.attempts.parse(rawRow));
          } else if (stream === 'lanes') {
            lanes.push(rowSchemas.lanes.parse(rawRow));
          } else if (stream === 'saves') {
            saves.push(rowSchemas.saves.parse(rawRow));
          } else {
            const row = rowSchemas.operations.parse(rawRow);
            if (row.mutation)
              records.receipts.push({
                schema: 1,
                kind: 'mutation',
                origin: 'command',
                ...row.mutation,
                actor: { kind: 'person', name: row.mutation.actor },
              });
          }
        }
        if (summary && !page.isDone) {
          records.surfaceGaps!.push(
            `Status read one hosted ${stream} page; use metrics for the remaining records.`,
          );
          break;
        }
        if (page.isDone) break;
        invariant(
          page.continueCursor && !seen.has(page.continueCursor),
          'EVIDENCE_CHANGED',
          'Hosted metric cursor did not advance.',
        );
        seen.add(page.continueCursor);
        cursor = page.continueCursor;
      } while (cursor !== null);
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
  if (!records.error && !summary) {
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
          actor: { kind: 'person', name: request.actor ?? 'unknown' },
        });
      for (const id of intents) seenIntents.add(id);
    }
  }
  for (const submission of records.submissions) submission.landedAt = accepted.get(submission.entryId);
  return { records, cutover };
}
