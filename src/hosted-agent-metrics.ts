// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { hostedAgentCommandSchemas, type HostedAgentAddress } from './hosted-agent-contract.js';
import type { MetricQuery } from './self-metrics-hosted-pages.js';
import { metricPeriod, metricsSurface } from './self-metrics-surface.js';
import { pageMetrics } from './self-metrics-page.js';
import { networkDeadline, networkFailure } from './network-fetch.js';
import { withExchangeProgress } from './exchange-progress.js';
import { currentExchangeProgress } from './exchange-progress-hooks.js';
import { ForgeError } from './errors.js';
import { canonicalPayload } from './hosted-source-operation.js';
import {
  hasNextPage,
  METRICS_RESUME_TTL_MS,
  metricsReadToken,
  openMetricsRead,
  readMetricRecords,
} from './self-metrics-source.js';

/** The whole metrics read, not only each page: it ends under an agent shell's
 * two-minute limit. Page reads grow with the window (about 70 s for 7 days at
 * 2026-11 dogfood size), so a larger window ends here with a typed next step. */
const METRICS_DEADLINE_MS = 100_000;

/**
 * The agent surface reads a narrow window (Issue 686ecdde). A read costs about 0.2 MB of database reads per
 * hour of window plus context at 2026-11 dogfood size (a 2 h window with the old 2-day context read 27 calls and
 * 10.2 MB; 55 such reads an hour were a third of the day's included reads). The default is the last 3 hours with
 * 90 minutes of context; the largest read a builder can ask for is 12 hours with 6 hours of context. Longer windows
 * and the wide 2 to 30 day context stay with the lead: `nforge metrics ROOT` (src/metrics-cli.ts), which does not
 * pass through here.
 */
export const AGENT_METRICS_DEFAULT_WINDOW_MS = 3 * 3_600_000;
export const AGENT_METRICS_WINDOW_MAX_MS = 12 * 3_600_000;
export const AGENT_METRICS_CONTEXT_DAYS_DEFAULT = 0.0625;
export const AGENT_METRICS_CONTEXT_DAYS_MAX = 0.25;

/** The agent surface's window and context, or a typed refusal before any server call. */
export function agentMetricsRead(command: {
  from?: string | undefined;
  to?: string | undefined;
  contextDays?: number | undefined;
}) {
  const ended = metricPeriod(undefined, command.to);
  const period =
    command.from === undefined
      ? metricPeriod(new Date(Date.parse(ended.to) - AGENT_METRICS_DEFAULT_WINDOW_MS).toISOString(), ended.to)
      : metricPeriod(command.from, command.to);
  const contextDays = command.contextDays ?? AGENT_METRICS_CONTEXT_DAYS_DEFAULT;
  const hours = (Date.parse(period.to) - Date.parse(period.from)) / 3_600_000;
  if (hours * 3_600_000 > AGENT_METRICS_WINDOW_MAX_MS || contextDays > AGENT_METRICS_CONTEXT_DAYS_MAX)
    throw new ForgeError(
      'BAD_ARGUMENT',
      `Agent metrics read at most ${AGENT_METRICS_WINDOW_MAX_MS / 3_600_000} hours with ${AGENT_METRICS_CONTEXT_DAYS_MAX} days of context (this read: ${Math.round(hours * 10) / 10} hours, contextDays ${contextDays}); a wider read costs the project about 0.2 MB of database reads per hour. Nothing changed. Next: narrow it to your Lane's own time, for example from your start time with contextDays 0.0625. A longer window is the lead's read: nforge metrics ROOT --from DATE --to DATE.`,
    );
  return { period, contextDays };
}

type MetricsRead = {
  token: string;
  period: { from: string; to: string };
  contextDays: number;
  answered: number;
};
/** Reads in this process by their parameters, so the deadline's error can name the resume. Only
 * a finished read removes its entry: the deadline fires before the aborted read unwinds. */
const reads = new Map<string, MetricsRead>();
const readKey = (input: unknown) => {
  const parameters = { ...(input as Record<string, unknown> | undefined) };
  delete parameters.operationId;
  return canonicalPayload(parameters);
};

/**
 * `metrics` over a window too large for one call's deadline (ad80e037; 8 days took 112 s at
 * 2026-11 dogfood size) resumes from its recorded server calls, and the pages of one window read the
 * server once (`openMetricsRead` in self-metrics-source.ts).
 */
export async function executeHostedMetrics(
  session: { root: string; address: HostedAgentAddress; query: MetricQuery },
  input: unknown,
  deadlineMs = METRICS_DEADLINE_MS,
) {
  const command = hostedAgentCommandSchemas.metrics.parse(input);
  const { period, contextDays } = agentMetricsRead(command);
  const token = metricsReadToken(session.address, period, contextDays);
  const record = await openMetricsRead(session.root, token, session.query, command.cursor !== undefined);
  const { reused, read: answered, query: recorded } = record;
  const read: MetricsRead = Object.assign(answered, { token, period, contextDays });
  reads.set(readKey(input), read);
  const result = await metricsDeadline(
    input,
    async () => {
      const [page, exactConflicts] = await Promise.all([
        pageMetrics(
          metricsSurface(
            await readMetricRecords(session.root, period, {
              address: session.address,
              query: recorded,
              contextDays,
            }),
            period,
          ),
          period,
          command,
        ),
        exactConflictSummary(recorded, period),
      ]);
      return exactConflicts ? { ...page, exactConflicts } : page;
    },
    deadlineMs,
  );
  reads.delete(readKey(input));
  // A paged reply keeps its recorded calls until its last page: each `cursor` page of the window is
  // recomputed from them, so N pages cost one read of the window, not N (Item 686ecdde; four 153 MB
  // reads of one window in 12 minutes on 2026-11-22).
  record.finish(hasNextPage(result));
  return reused
    ? { ...result, resumed: { recordedCalls: reused, newCalls: read.answered - reused } }
    : result;
}

/** Exact conflicts at save (flip 4): notices flagged in the window and the time from flag to the Lane's
 * first land. One read-only query; a server without it leaves the field out. */
async function exactConflictSummary(query: MetricQuery, period: { from: string; to: string }) {
  try {
    const value = await query('projectHostedConflicts:summary', {
      from: Date.parse(period.from),
      to: Date.parse(period.to),
    });
    const parsed = (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown> | null;
    return parsed && !('error' in parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** One budget for the whole action: callers that read capabilities first wrap
 * that call too, so discovery cannot add its own 120 s on top. Nested calls
 * share the outer signal; the earliest deadline wins. */
export async function metricsDeadline<T>(
  input: unknown,
  operation: () => Promise<T>,
  deadlineMs = METRICS_DEADLINE_MS,
): Promise<T> {
  try {
    // Cancellation reaches every in-flight page and object read through the exchange signal.
    return await networkDeadline(
      signal => withExchangeProgress({ signal }, operation),
      deadlineMs,
      currentExchangeProgress()?.signal,
      'metrics',
    );
  } catch (error) {
    if (
      !networkFailure(error) ||
      error.code !== 'EXCHANGE_REQUEST_TIMEOUT' ||
      !/^metrics /.test(error.message)
    )
      throw error;
    throw metricsTimeout(input, deadlineMs);
  }
}

function metricsTimeout(input: unknown, deadlineMs: number) {
  const parameters = { ...(input as Record<string, unknown> | undefined) };
  delete parameters.operationId;
  const stopped = reads.get(readKey(input));
  if (stopped?.answered) {
    const resume = {
      from: stopped.period.from,
      to: stopped.period.to,
      contextDays: stopped.contextDays,
      ...(parameters.limit !== undefined ? { limit: parameters.limit } : {}),
      ...(parameters.cursor !== undefined ? { cursor: parameters.cursor } : {}),
    };
    return new ForgeError(
      'METRICS_TIMEOUT',
      `metrics did not finish within ${Math.round(deadlineMs / 1000)} s for [${stopped.period.from}, ${stopped.period.to}); the ${stopped.answered} calls answered so far are kept on this machine for ${METRICS_RESUME_TTL_MS / 60_000} minutes. Nothing changed. Next: nforge agent ROOT metrics '${JSON.stringify(resume)}' (the same window) continues the read from there and reads no page twice; repeat it until it answers.`,
    );
  }
  const command = hostedAgentCommandSchemas.metrics.safeParse(parameters);
  let period: { from: string; to: string } | undefined;
  try {
    if (command.success) period = agentMetricsRead(command.data).period;
  } catch {
    // An invalid or wide window fails inside the action with its own BAD_ARGUMENT.
  }
  const to = period?.to ?? new Date().toISOString();
  // Never suggest a window larger than the one that failed: the later half, at least an hour.
  const span = period ? Date.parse(period.to) - Date.parse(period.from) : 86_400_000;
  const half = new Date(Date.parse(to) - Math.max(3_600_000, Math.floor(span / 2))).toISOString();
  const from = period && half < period.from ? period.from : half;
  return new ForgeError(
    'METRICS_TIMEOUT',
    `metrics did not finish within ${Math.round(deadlineMs / 1000)} s${period ? ` for [${period.from}, ${period.to})` : ''}; it reads the window plus a context horizon (contextDays, default ${AGENT_METRICS_CONTEXT_DAYS_DEFAULT}) page by page. Nothing changed. Next: nforge agent ROOT metrics '${JSON.stringify({ from, to, contextDays: AGENT_METRICS_CONTEXT_DAYS_DEFAULT })}' for the later part of the window with the default horizon.`,
  );
}
