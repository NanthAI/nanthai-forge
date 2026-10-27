// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../scripts/child-env.mjs';
import { metricsSurface } from './self-metrics-surface.js';
import type { MetricRecords, MetricPeriod } from './self-metrics-types.js';
/** The completed UTC ISO week before the write. Boundaries are Monday 00:00. */
export function previousMetricWeek(at: string) {
  const now = new Date(at),
    monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const start = new Date(+monday - 7 * 86400000),
    thursday = new Date(+start + 3 * 86400000);
  const year = thursday.getUTCFullYear(),
    jan4 = new Date(Date.UTC(year, 0, 4));
  jan4.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const week = Math.round((+start - +jan4) / (7 * 86400000)) + 1;
  return {
    name: `weekly-${year}-W${String(week).padStart(2, '0')}.json`,
    period: { from: start.toISOString(), to: monday.toISOString(), asOf: monday.toISOString() },
  };
}
/** Strip the current mutable Work revision: a closed week is reproduced from evidence,
 * not from the time or revision at which the write hook happens to run. */
export function weeklyMetricBytes(records: MetricRecords, period: MetricPeriod) {
  const closed: MetricRecords = {
    ...records,
    receipts: records.receipts.filter(r => Date.parse(r.at) < Date.parse(period.to)),
    ...(records.observations
      ? { observations: records.observations.filter(r => Date.parse(r.at) < Date.parse(period.to)) }
      : {}),
    ...(records.diskSamples
      ? { diskSamples: records.diskSamples.filter(r => Date.parse(r.at) < Date.parse(period.to)) }
      : {}),
    ...(records.checkRequests
      ? { checkRequests: records.checkRequests.filter(r => Date.parse(r.at) < Date.parse(period.to)) }
      : {}),
    moves: records.moves.filter(r => Date.parse(r.at) < Date.parse(period.to)),
    submissions: records.submissions
      .filter(r => Date.parse(r.at) < Date.parse(period.to))
      .map(r => ({
        ...r,
        progressAt: r.progressAt.filter(at => Date.parse(at) < Date.parse(period.to)),
        ...(r.endedAt && Date.parse(r.endedAt) >= Date.parse(period.to)
          ? { status: 'checking', endedAt: undefined }
          : {}),
      })),
    runs: records.runs
      .filter(r => Date.parse(r.at) < Date.parse(period.to))
      .map(r =>
        r.endedAt && Date.parse(r.endedAt) >= Date.parse(period.to)
          ? (() => {
              const copy = {
                ...r,
                status: 'running',
                endedAt: undefined,
                wallMinutes: undefined,
                runnerMinutes: undefined,
              };
              delete copy.executions;
              return copy;
            })()
          : r,
      ),
  };
  delete closed.source;
  // Completeness starts after the boundary cannot retroactively cover the week.
  return JSON.stringify(metricsSurface(closed, period), null, 2) + '\n';
}
const seen = new Map<string, string>();
const queued = new Set<string>();
const retryAfter = new Map<string, number>();
const backoff = 60 * 60 * 1000;
/** Tests supply a worker that injects a slow/failing reader in the child. */
export const weeklyMetricTestHooks = { worker: undefined as string | undefined };

export function metricWeekPaths(directory: string, name: string) {
  const metrics = join(directory, 'metrics');
  return {
    metrics,
    target: join(metrics, name),
    pending: join(metrics, `.${name}.pending`),
    failed: join(metrics, `.${name}.failed`),
  };
}
export function releaseMetricWeek(directory: string, name: string, token: string) {
  const { pending } = metricWeekPaths(directory, name);
  try {
    if (readFileSync(pending, 'utf8') === token) unlinkSync(pending);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
export function failMetricWeek(directory: string, name: string) {
  const { failed } = metricWeekPaths(directory, name);
  writeFileSync(failed, JSON.stringify({ at: new Date().toISOString() }) + '\n', { mode: 0o600 });
}
/** Called by a committed write. Only the week/cache and snapshot existence are
 * checked here: reservation, backoff IO and process launch run after it returns. */
export function snapshotMetricWeek(directory: string, at: string) {
  if (basename(dirname(directory)) !== '.forge') return;
  const { name, period } = previousMetricWeek(at);
  if (seen.get(directory) === name) return;
  const { target } = metricWeekPaths(directory, name);
  // An owner created after the week ended has no evidence for it: never start a worker.
  if (existsSync(target) || statSync(directory).birthtimeMs >= Date.parse(period.to)) {
    seen.set(directory, name);
    return;
  }
  if (queued.has(target) || Date.now() < (retryAfter.get(target) ?? 0)) return;
  queued.add(target);
  setImmediate(() => launchMetricWeek(directory, at, name));
}
function launchMetricWeek(directory: string, at: string, name: string) {
  const { metrics, target, pending, failed } = metricWeekPaths(directory, name);
  let reserved = false;
  const token = randomUUID();
  const release = () => {
    try {
      if (reserved) releaseMetricWeek(directory, name, token);
    } catch {
      // The child may already have removed its reservation.
    }
    queued.delete(target);
  };
  const fail = () => {
    retryAfter.set(target, Date.now() + backoff);
    try {
      failMetricWeek(directory, name);
    } catch {
      // Metrics must never change the committed write's outcome.
    }
  };
  try {
    // A fixture or owner removal may have closed the source before this handoff.
    // Never recreate a removed owner just to collect derived metrics.
    if (!existsSync(directory)) {
      release();
      return;
    }
    mkdirSync(metrics, { recursive: true, mode: 0o700 });
    // A reservation older than the backoff belongs to a worker that died (Mac killed, OOM).
    try {
      if (Date.now() - statSync(pending).mtimeMs > backoff) unlinkSync(pending);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      writeFileSync(pending, token, { flag: 'wx', mode: 0o600 });
      reserved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      release();
      return;
    }
    // Recheck after exclusive admission: another process may have just finished.
    if (existsSync(target)) {
      seen.set(directory, name);
      release();
      return;
    }
    try {
      const failedAt = Date.parse(JSON.parse(readFileSync(failed, 'utf8')).at);
      if (Date.now() < failedAt + backoff) {
        retryAfter.set(target, failedAt + backoff);
        release();
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const child = spawn(
      process.execPath,
      [
        weeklyMetricTestHooks.worker ??
          fileURLToPath(new URL('./self-metrics-weekly-worker.js', import.meta.url)),
        dirname(dirname(directory)),
        at,
        token,
      ],
      { detached: true, stdio: 'ignore', env: childEnv() },
    );
    let spawnFailed = false;
    child.once('error', () => {
      spawnFailed = true;
      fail();
    });
    child.once('close', code => {
      if (code === 0 && !spawnFailed) seen.set(directory, name);
      else if (!spawnFailed) {
        retryAfter.set(target, Date.now() + backoff);
        try {
          const failedAt = Date.parse(JSON.parse(readFileSync(failed, 'utf8')).at);
          if (Number.isFinite(failedAt)) retryAfter.set(target, failedAt + backoff);
        } catch {
          // Retain in-process backoff even when the failure file could not be written.
        }
        try {
          if (readFileSync(pending, 'utf8') === token) fail();
        } catch {
          // A normal worker failure already recorded its timestamp and released.
        }
      }
      release();
    });
    child.unref();
  } catch {
    // An EEXIST contender does not own the pending marker or record a failure.
    if (reserved) fail();
    release();
  }
}
