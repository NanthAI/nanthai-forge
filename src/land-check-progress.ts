// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { hasDetachedCheckRequest } from './check-controller.js';
import { processAlive } from './local-process.js';
import type { CheckRun } from './work-types.js';
import type { WorkStore } from './work-store.js';
import type { ActionsJournal } from './github-actions-export.js';
import type { ModalPlan } from './modal-plan.js';
import type { Counts } from './land-phases.js';

const markerCache = new Map<string, { stamp: string; files: Set<string>; markers: boolean }>();
function fileMarkers(path: string) {
  const stat = statSync(path, { bigint: true });
  const stamp = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const cached = markerCache.get(path);
  if (cached?.stamp === stamp) return cached;
  const files = new Set<string>();
  let markers = false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const marker = line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '').trimStart();
    if (!marker.startsWith('__FORGE_TESTS__')) continue;
    try {
      const report = JSON.parse(marker.slice('__FORGE_TESTS__'.length));
      markers = true;
      if (report.complete === true && typeof report.file === 'string') files.add(report.file);
    } catch {
      /* An incomplete final line is not a completed file. */
    }
  }
  const value = { stamp, files, markers };
  markerCache.set(path, value);
  return value;
}
/** Optional local observations may be absent or mid-write. They never supply a verdict. */
export function progressJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
    )
      return;
    throw error;
  }
}
export function readLandCheckProgress(directory: string, runId: string, includeFiles = true) {
  const path = join(directory, `check-${runId}`);
  const plan = progressJson<Pick<ModalPlan, 'groups' | 'selection'>>(join(path, 'modal-plan.json'));
  const journal = progressJson<ActionsJournal>(join(path, 'github-actions.json'));
  const usage = journal?.jobUsage ?? [];
  const starts = usage.flatMap(job => (job.started_at ? [job.started_at] : [])).sort();
  const ends = usage.flatMap(job => (job.completed_at ? [job.completed_at] : [])).sort();
  const total = plan ? plan.groups.length + 1 : undefined;
  // Retried jobs replace earlier attempts for progress; historical attempts remain retained.
  const executions =
    progressJson<{ index: number; attempt: number; executionId: string; exitCode?: number }[]>(
      join(path, 'modal-shard-logs.json'),
    ) ?? [];
  const latest = new Map<number, (typeof executions)[number]>();
  for (const execution of executions)
    if ((latest.get(execution.index)?.attempt ?? -1) <= execution.attempt)
      latest.set(execution.index, execution);
  const states = journal?.states ?? {};
  const completed = (item: (typeof executions)[number]) =>
    (item.exitCode !== undefined || states[item.executionId]?.startsWith('completed/')) &&
    (!journal?.retrying?.includes(item.index) ||
      String(journal.retrySources?.[item.index]) !== item.executionId);
  const supersededJobs = new Set(Object.values(journal?.retrySources ?? {}).map(String));
  const done = journal?.states
    ? Object.entries(states).filter(
        ([id, state]) => state.startsWith('completed/') && !supersededJobs.has(id),
      ).length
    : [...latest.values()].filter(completed).length;
  const shardsDone = [...latest.values()].filter(
    item => item.index < (plan?.groups.length ?? 0) && completed(item),
  ).length;
  const files = new Set<string>();
  let markers = false;
  let names: string[] = [];
  try {
    if (includeFiles) names = readdirSync(join(path, 'shards'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Only the latest selected attempt contributes file progress.
  for (const execution of latest.values()) {
    if (
      journal?.retrying?.includes(execution.index) &&
      String(journal.retrySources?.[execution.index]) === execution.executionId
    )
      continue;
    const prefix = execution.index === plan?.groups.length ? 'static' : String(execution.index);
    const name = `${prefix}${execution.attempt ? `.attempt-${execution.attempt + 1}` : ''}.log`;
    if (!names.includes(name)) continue;
    const observed = fileMarkers(join(path, 'shards', name));
    markers ||= observed.markers;
    for (const file of observed.files) if (plan?.selection.tests.includes(file)) files.add(file);
  }
  const progress: { jobs?: Counts; shards?: Counts; files?: Counts } = {
    ...(total === undefined
      ? {}
      : { jobs: { done, total }, shards: { done: shardsDone, total: plan!.groups.length } }),
    ...(markers && plan ? { files: { done: files.size, total: plan.selection.tests.length } } : {}),
  };
  return {
    dispatchAt: journal?.dispatchAttempts?.[0]?.startedAt,
    ciAt: starts[0],
    checkedAt: total !== undefined && done === total ? ends.at(-1) : undefined,
    dispatched: !!journal?.runId || executions.length > 0,
    progress,
  };
}

/** Read the physical execution lease without queue admission, recovery or stale-ticket cleanup. */
export function readLandCheckController(store: WorkStore, run: CheckRun) {
  if (!['queued', 'preparing', 'running'].includes(run.status)) return;
  const lease = `check-controllers/${run.id}`;
  let names: string[] = [];
  try {
    names = readdirSync(join(store.directory, lease));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const holder = names.flatMap(name => {
    const match = /^(\d+)\.([\w-]+)\.([\w-]+)$/.exec(name);
    if (!match) return [];
    const identity = {
      pid: Number(match[1]),
      startTime: Buffer.from(match[2]!, 'base64url').toString(),
    };
    const ticket = progressJson<{ holding?: boolean; released?: boolean }>(
      join(store.directory, lease, name, 'ticket.json'),
    );
    return ticket?.holding && !ticket.released && processAlive(identity)
      ? [{ ...identity, host: hostname(), lease }]
      : [];
  })[0];
  const detached = hasDetachedCheckRequest(store, run);
  const owner:
    { pid: number; host: string; startTime?: string | undefined; lease?: string | undefined } | undefined =
    holder ?? (!detached ? run.runner : undefined);
  return {
    runId: run.id,
    phase: run.status,
    holder: owner,
    waitingOn: owner ? undefined : 'check controller lease',
  };
}
