// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { hostedActionError } from './hosted-action-error.js';
import { invariant } from './errors.js';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { minutesBetween, type MetricPeriod, type MetricRecords } from './self-metrics-types.js';
export type MetricQuery = (name: string, args: Record<string, unknown>) => Promise<unknown>;
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
  }),
  requests: z.object({
    id: z.string(),
    at: stamp,
    status: z.string(),
    runIds: z.array(z.string()),
    progressAt: z.array(stamp),
    errorCode: z.string().nullable(),
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
  }),
  operations: z.object({ id: z.string(), mutation: mutation.optional() }),
};
const gaps = [
  'Hosted immutable Lane/Intent input objects are not loaded by metrics; landing path and first-attempt classification are unknown.',
  'Hosted caller-visible lifecycle errors and no-owner incident tags are not recorded.',
  'Hosted terminal states do not establish delivery to a requester; terminal delivery and overlap delivery/acknowledgement remain unknown.',
  'Hosted full-suite selection flags are unavailable; exact-State results without that evidence cannot establish red-main minutes.',
  'Hosted complete reuse keys, request/adoption receipts, cache/surface observations and provider bills are unavailable.',
  'Requester-attributed hosted cancellations and linked finish retries have mutation coverage; restarts and other interventions remain partial.',
  'Hosted context is limited to one day before the window by record creation time; older pending work and boundary red-main state may be missing. Pages are live observations, not an atomic cross-page snapshot.',
];
export async function readHostedMetricPages(query: MetricQuery, period: MetricPeriod, summary = false) {
  const records: MetricRecords = {
    moves: [],
    submissions: [],
    runs: [],
    receipts: [],
    finishTimings: [],
    gaps: [...gaps],
    surfaceGaps: [...gaps],
    source: { kind: 'hosted' },
    fullResultsUnavailable:
      'Hosted full-suite selection and boundary results are unavailable; red-main minutes are unknown.',
    landingKindsComplete: false,
  };
  let cutover: string | null = null;
  const accepted = new Map<string, string>();
  try {
    for (const stream of ['acceptances', 'requests', 'runs', 'operations'] as const) {
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const raw = await query('projectSelfMetrics:page', {
          stream,
          from: period.from,
          to: period.to,
          cursor,
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
            accepted.set(row.submissionId, row.at);
            records.moves.push({
              id: row.id,
              at: row.at,
              head: row.head,
              kind: row.kind,
              path: row.path,
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
              status: row.status === 'terminal-failed' ? 'failed' : row.status,
            });
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
  for (const submission of records.submissions) submission.landedAt = accepted.get(submission.entryId);
  return { records, cutover };
}
