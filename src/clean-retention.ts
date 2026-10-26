import { retainCompactCheckReports } from './check-compact-output.js';
// SPDX-License-Identifier: Apache-2.0
import {
  closeSync,
  constants,
  fstatSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { allRecords } from './agent-lifecycle.js';
import { processBlocker, type workingProcesses } from './clean-processes.js';
import { processGroupAlive } from './local-process.js';
import { durableReplace } from './native-durability.js';
import { retentionPins, references } from './clean-retention-pins.js';
import { terminalReceipt, remoteExecutionBlocker } from './clean-terminal-receipt.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const LOG_TAIL_BYTES = 64 * 1024;
export type RetentionItem = {
  id: string;
  kind: 'check-workspaces' | 'check-retention' | 'exchange-staging';
  path: string;
  bytes: number;
  reason: string;
  runId?: string;
  tail?: true;
};
type Skipped = { kind: RetentionItem['kind']; id: string; reason: string; runId?: string };
const plain = (path: string) => {
  try {
    return lstatSync(path).isDirectory() && realpathSync(path) === path;
  } catch {
    return false;
  }
};
function size(path: string): number {
  const info = lstatSync(path);
  return info.isDirectory() && !info.isSymbolicLink()
    ? readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0)
    : info.size;
}

export function retentionPlan(
  store: WorkStore,
  kinds: readonly string[],
  processes: ReturnType<typeof workingProcesses>,
  now = Date.now(),
  selected?: Set<string>,
) {
  const items: RetentionItem[] = [],
    skipped: Skipped[] = [];
  if (!kinds.some(kind => ['check-workspaces', 'check-retention', 'exchange-staging'].includes(kind)))
    return { items, skipped };
  const runs = allRecords<CheckRun>(store, 'runs');
  const { refs, baselines, unknown } = retentionPins(store, runs);
  let referenceUnknown = unknown;
  const old = (time: number) => Number.isFinite(time) && now - time > RETENTION_MS;
  const exchange = readdirSync(store.directory).filter(n => /^exchange-(?:receive-)?[0-9a-f-]{36}$/i.test(n));
  for (const name of exchange) {
    const path = join(store.directory, name),
      id = name.replace(/^exchange-(?:receive-)?/, '');
    const blocked = referenceUnknown
      ? 'Local reference coverage is unavailable.'
      : refs.has(id) || baselines.has(id)
        ? 'Exchange is still referenced.'
        : processBlocker(path, processes);
    if (kinds.includes('exchange-staging')) {
      if (blocked) skipped.push({ kind: 'exchange-staging', id: path, reason: blocked });
      else if (
        !pinnedPath(path) &&
        plain(path) &&
        old(lstatSync(path).mtimeMs) &&
        (!selected || selected.has(path))
      )
        items.push({
          id: path,
          path,
          kind: 'exchange-staging',
          bytes: size(path),
          reason: 'Unreferenced exchange staging older than seven days.',
        });
    }
    // Age alone is not an export pin. Otherwise every fresh exchange would
    // perpetually retain every historical log. Only explicit/pending operations
    // and in-use staging need the exact original check bytes.
    if (refs.has(id) || (blocked && !baselines.has(id))) {
      try {
        references(JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8')), refs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') referenceUnknown = true;
      }
    }
  }

  // A retained manifest can pin staging encountered earlier in directory order.
  // Close that dependency before allowing any deletion from the plan.
  let changed: boolean;
  do {
    changed = false;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (
        !referenceUnknown &&
        !refs.has(item.path.replace(/^.*exchange-(?:receive-)?/, '')) &&
        !baselines.has(item.path.replace(/^.*exchange-(?:receive-)?/, ''))
      )
        continue;
      items.splice(i, 1);
      skipped.push({
        kind: item.kind,
        id: item.id,
        reason: 'Retained exchange reference or unavailable reference coverage.',
      });
      try {
        references(JSON.parse(readFileSync(join(item.path, 'manifest.json'), 'utf8')), refs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') referenceUnknown = true;
      }
      changed = true;
    }
  } while (changed);
  if (!kinds.some(kind => ['check-workspaces', 'check-retention'].includes(kind))) return { items, skipped };
  for (const run of runs) {
    const directory = join(store.directory, `check-${run.id}`),
      kind = kinds.includes('check-workspaces') ? 'check-workspaces' : 'check-retention';
    if (!plain(directory)) continue;
    if (
      !kinds.includes('check-retention') &&
      !['modal-source', 'github-actions-source'].some(name => plain(join(directory, name)))
    )
      continue;
    const blocked = ['queued', 'preparing', 'running'].includes(run.status)
      ? `Run is recorded as ${run.status}.`
      : referenceUnknown
        ? 'Local reference coverage is unavailable.'
        : refs.has(run.id)
          ? 'Run is explicitly pinned by a release or retained export.'
          : run.backend?.retryable
            ? 'Remote execution can still be resumed.'
            : run.childPid && processGroupAlive(run.childPid, run.childStartTime)
              ? 'Run process group is still alive.'
              : processBlocker(directory, processes);
    if (blocked) {
      skipped.push({ kind, id: directory, runId: run.id, reason: blocked });
      continue;
    }
    const receipt = terminalReceipt(store, run, directory),
      blocker = receipt.blocker ?? remoteExecutionBlocker(directory);
    if (blocker) {
      skipped.push({ kind, id: directory, runId: run.id, reason: blocker });
      continue;
    }
    if (receipt.sourceOnly) skipped.push({ kind, id: directory, runId: run.id, reason: receipt.reason! });
    try {
      for (const name of readdirSync(directory)) {
        const path = join(directory, name),
          info = lstatSync(path);
        if (info.isSymbolicLink() || (name !== 'shards' && pinnedPath(path))) continue;
        if (['modal-source', 'github-actions-source'].includes(name) && plain(path)) {
          items.push({
            id: path,
            path,
            kind,
            bytes: size(path),
            runId: run.id,
            reason:
              receipt.reason ??
              'Terminal remote source copy; result, logs, selection, plans and artifacts stay. Rerunning the check reconstructs source.',
          });
          continue;
        }
        if (
          receipt.sourceOnly ||
          !kinds.includes('check-retention') ||
          !run.endedAt ||
          !old(Date.parse(run.endedAt)) ||
          !old(info.mtimeMs)
        )
          continue;
        if (['workspace', 'runtime'].includes(name) && plain(path))
          items.push({
            id: path,
            path,
            kind: 'check-retention',
            bytes: size(path),
            runId: run.id,
            reason:
              'Terminal source/runtime copy older than seven days; acceptance evidence, result, selection, plans and artifacts stay.',
          });
        else if (name === 'shards' && plain(path)) scanLogs(path, run.id);
        else if (name.endsWith('.log') && info.isFile()) log(path, run.id);
      }
    } catch {
      skipped.push({
        kind: 'check-retention',
        id: directory,
        runId: run.id,
        reason: 'Retained directory is unreadable or changed during cleanup planning.',
      });
    }
  }
  function pinnedPath(path: string) {
    const relative = path.slice(store.directory.length + 1);
    return [...refs].some(
      ref => ref === path || ref === relative || ref.startsWith(`${path}/`) || ref.startsWith(`${relative}/`),
    );
  }
  function log(path: string, runId: string) {
    const info = lstatSync(path);
    if (
      info.isFile() &&
      !pinnedPath(path) &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      old(info.mtimeMs) &&
      info.size > 0
    )
      items.push({
        id: path,
        path,
        kind: 'check-retention',
        bytes: info.size,
        runId,
        reason: 'Local log retention expired after seven days; compact test evidence and results stay.',
      });
  }
  function scanLogs(directory: string, runId: string) {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (name.endsWith('.log')) log(path, runId);
      else if (
        !pinnedPath(path) &&
        plain(path) &&
        old(lstatSync(path).mtimeMs) &&
        (!selected || selected.has(path))
      )
        items.push({
          id: path,
          path,
          kind: 'check-retention',
          bytes: size(path),
          runId,
          reason: 'Unpinned shard work directory older than seven days.',
        });
    }
  }
  return { items, skipped };
}

export function removeRetention(item: RetentionItem) {
  if (!item.tail) {
    if (item.path.endsWith('.log')) {
      const folder = dirname(item.path);
      const directory = basename(folder) === 'shards' ? dirname(folder) : folder;
      if (!existsSync(join(directory, 'test-reports.json'))) retainCompactCheckReports(directory);
    }
    rmSync(item.path, { recursive: true, force: true });
    return;
  }
  const fd = openSync(item.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw Error('Log changed');
    const bytes = Buffer.alloc(Math.min(info.size, LOG_TAIL_BYTES));
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, info.size - bytes.length + offset);
      if (!n) throw Error('Log changed');
      offset += n;
    }
    const after = lstatSync(item.path);
    if (
      after.ino !== info.ino ||
      after.dev !== info.dev ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs ||
      after.ctimeMs !== info.ctimeMs
    )
      throw Error('Log changed');
    durableReplace(item.path, bytes);
  } finally {
    closeSync(fd);
  }
}
