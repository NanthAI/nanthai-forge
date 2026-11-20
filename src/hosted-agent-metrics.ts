// SPDX-License-Identifier: Apache-2.0
import { hostedAgentCommandSchemas, type HostedAgentAddress } from './hosted-agent-contract.js';
import { readMetricRecords } from './self-metrics-source.js';
import type { MetricQuery } from './self-metrics-hosted-pages.js';
import { metricPeriod, metricsSurface } from './self-metrics-surface.js';
import { pageMetrics } from './self-metrics-page.js';
import { networkDeadline, networkFailure } from './network-fetch.js';
import { withExchangeProgress } from './exchange-progress.js';
import { currentExchangeProgress } from './exchange-progress-hooks.js';
import { ForgeError } from './errors.js';
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { digest } from './hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { hostedAgentDirectory } from './hosted-agent-journal.js';
import { METRICS_CONTEXT_DAYS_DEFAULT, METRICS_CONTEXT_DAYS_MAX } from './self-metrics-page.js';

/** The whole metrics read, not only each page: it ends under an agent shell's
 * two-minute limit. Page reads grow with the window (about 70 s for 7 days at
 * 2026-11 dogfood size), so a larger window ends here with a typed next step. */
export const METRICS_DEADLINE_MS = 100_000;

/** How long the pages of a stopped read stay resumable on this machine. */
export const METRICS_RESUME_TTL_MS = 60 * 60 * 1000;
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
const resumeDirectory = (root: string) => join(hostedAgentDirectory(root), 'metrics-read');

/**
 * `metrics` over a window too large for one call's deadline (ad80e037; 8 days took 112 s at
 * 2026-11 dogfood size). Every answered server call of the read is appended to a local file
 * (the project's agent cache, mode 0600) under a token of the project, the exact window and the
 * context horizon. When the deadline stops the read, the same window asked again within the hour
 * answers the recorded calls from the file and asks the server only for the rest, so a page is
 * never read twice and the DB I/O of the whole read is that of one read, split across calls (no
 * new field: the MCP tool list stays at its ceiling). A finished read deletes its file, so a
 * later read always starts fresh; a stopped one is kept one hour. R2 object downloads (input hydration) are not
 * recorded: they are not Convex reads, and the machine object cache keeps them.
 */
export async function executeHostedMetrics(
  session: { root: string; address: HostedAgentAddress; query: MetricQuery },
  input: unknown,
  deadlineMs = METRICS_DEADLINE_MS,
) {
  const command = hostedAgentCommandSchemas.metrics.parse(input);
  const period = metricPeriod(command.from, command.to);
  const contextDays = Math.min(
    METRICS_CONTEXT_DAYS_MAX,
    Math.max(0, command.contextDays ?? METRICS_CONTEXT_DAYS_DEFAULT),
  );
  const token = digest(
    canonicalPayload({
      kind: 'forge-metrics-read',
      url: session.address.url,
      projectId: session.address.projectId,
      from: period.from,
      to: period.to,
      contextDays,
    }),
  ).slice(0, 16);
  const directory = resumeDirectory(session.root);
  const file = join(directory, `${token}.jsonl`);
  const answers = new Map<string, unknown>();
  // The same window asked again within the hour continues a stopped read; an older file is gone.
  let lines: string[] = [];
  try {
    if (Date.now() - statSync(file).mtimeMs < METRICS_RESUME_TTL_MS)
      lines = readFileSync(file, 'utf8').split('\n');
    else rmSync(file, { force: true });
  } catch {
    // No stopped read of this window: a fresh read.
  }
  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { k: string; v: unknown };
      answers.set(entry.k, entry.v);
    } catch {
      // A line cut by a killed process: that call is asked again.
    }
  }
  if (!answers.size) pruneStoppedReads(directory);
  const reused = answers.size;
  const read: MetricsRead = { token, period, contextDays, answered: reused };
  reads.set(readKey(input), read);
  const recorded: MetricQuery = Object.assign(
    async (name: string, args: Record<string, unknown>) => {
      const key = JSON.stringify([name, args]);
      if (answers.has(key)) return answers.get(key);
      const value = await session.query(name, args);
      answers.set(key, value);
      if (read.answered === reused) mkdirSync(directory, { recursive: true, mode: 0o700 });
      appendFileSync(file, `${JSON.stringify({ k: key, v: value })}\n`, { mode: 0o600 });
      read.answered++;
      return value;
    },
    session.query.objects ? { objects: session.query.objects } : {},
  );
  const result = await metricsDeadline(
    input,
    async () => {
      const [page, exactConflicts] = await Promise.all([
        pageMetrics(
          metricsSurface(
            await readMetricRecords(session.root, period, {
              address: session.address,
              query: recorded,
              contextDays: command.contextDays,
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
  rmSync(file, { force: true });
  return reused
    ? { ...result, resumed: { recordedCalls: reused, newCalls: read.answered - reused } }
    : result;
}

/** Stopped reads older than the resume window are deleted when a new read starts. */
function pruneStoppedReads(directory: string) {
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names)
    try {
      if (Date.now() - statSync(join(directory, name)).mtimeMs >= METRICS_RESUME_TTL_MS)
        rmSync(join(directory, name), { force: true });
    } catch {
      // Removed by a concurrent read.
    }
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
    if (command.success) period = metricPeriod(command.data.from, command.data.to);
  } catch {
    // An invalid window fails inside the action with its own BAD_ARGUMENT.
  }
  const to = period?.to ?? new Date().toISOString();
  // Never suggest a window larger than the one that failed: the later half, at least an hour.
  const span = period ? Date.parse(period.to) - Date.parse(period.from) : 86_400_000;
  const half = new Date(Date.parse(to) - Math.max(3_600_000, Math.floor(span / 2))).toISOString();
  const from = period && half < period.from ? period.from : half;
  return new ForgeError(
    'METRICS_TIMEOUT',
    `metrics did not finish within ${Math.round(deadlineMs / 1000)} s${period ? ` for [${period.from}, ${period.to})` : ''}; it reads the window plus a context horizon (contextDays, default 2) page by page. Nothing changed. Next: nforge agent ROOT metrics '${JSON.stringify({ from, to, contextDays: 1 })}' for the later part of the window with a one-day horizon.`,
  );
}
