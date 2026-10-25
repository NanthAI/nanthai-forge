// SPDX-License-Identifier: Apache-2.0
import {
  closeSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  renameSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appendSelfMetric } from './self-metrics-journal.js';
export const diskKinds = ['objects', 'records', 'lanes', 'checks', 'snapshots', 'backups'] as const;
export const diskBudgetSchema = z.object({
  maxBytes: z.number().positive().finite(),
  maxGrowthBytesPerDay: z.number().positive().finite(),
  minFreeBytes: z.number().nonnegative().finite(),
  lookaheadDays: z.number().positive().finite().default(1),
});
export type DiskBudget = z.infer<typeof diskBudgetSchema>;
export type DiskSample = {
  at: string;
  localBytes: Record<(typeof diskKinds)[number], number>;
  freeBytes: number | null;
  complete: boolean;
  scannedEntries: number;
  budget: DiskBudget;
  growthBytesPerDay: number | null;
  warning: string | null;
};
// Advisory defaults only. No writes, Lanes or checks are denied at these budgets.
export const defaultDiskBudget: DiskBudget = {
  maxBytes: 10 * 1024 ** 3,
  maxGrowthBytesPerDay: 100 * 1024 ** 2,
  minFreeBytes: 1024 ** 3,
  lookaheadDays: 1,
};
const statePath = (directory: string) => join(directory, 'self-metrics-disk.json');
function json<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}
function replace(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
}
export function setSelfMetricDiskBudget(directory: string, budget: DiskBudget) {
  replace(join(directory, 'self-metrics-disk-budget.json'), diskBudgetSchema.parse(budget));
}
/** Status reads one retained sample, never starts a scan or contacts hosted storage. */
export function readSelfMetricDisk(directory: string): DiskSample | null {
  return json<DiskSample>(statePath(directory)) ?? null;
}
function classify(name: string): (typeof diskKinds)[number] | undefined {
  if (name === 'objects' || name === 'records') return name;
  if (/^lane-[0-9a-f-]{36}$/.test(name)) return 'lanes';
  if (name.startsWith('check-')) return 'checks';
  if (name === 'auto-snapshots' || name === 'snapshots') return 'snapshots';
  if (name.startsWith('native-backup-') || name === 'backups') return 'backups';
}
/** Hard entry/time bounds; no symlink traversal, command execution, network or worker. */
export function scanSelfMetricDisk(directory: string, limits = { entries: 100_000, milliseconds: 250 }) {
  const localBytes = Object.fromEntries(diskKinds.map(kind => [kind, 0])) as DiskSample['localBytes'];
  let scannedEntries = 0,
    complete = true;
  const deadline = performance.now() + limits.milliseconds;
  const queue: { path: string; kind?: (typeof diskKinds)[number] }[] = [{ path: directory }];
  try {
    const registry = join(directory, 'record-collection-backups.json');
    let backups: { path: string }[] = [];
    try {
      if (lstatSync(registry).size <= 1024 * 1024) backups = json(registry) ?? [];
      else complete = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
    }
    for (const backup of backups.slice(0, limits.entries)) queue.push({ path: backup.path, kind: 'backups' });
    if (backups.length > limits.entries) complete = false;
  } catch {
    complete = false;
  }
  for (let i = 0; i < queue.length; i++) {
    if (scannedEntries >= limits.entries || performance.now() >= deadline) {
      complete = false;
      break;
    }
    const selected = queue[i]!;
    let dir;
    try {
      if (lstatSync(selected.path).isSymbolicLink()) {
        complete = false;
        continue;
      }
      dir = opendirSync(selected.path);
    } catch {
      complete = false;
      continue;
    }
    try {
      let entry;
      while ((entry = dir.readSync())) {
        if (++scannedEntries > limits.entries || performance.now() >= deadline) {
          complete = false;
          break;
        }
        const kind = selected.kind ?? classify(entry.name);
        if (!kind) continue;
        const path = join(selected.path, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) queue.push({ path, kind });
        else if (entry.isFile()) {
          try {
            localBytes[kind] += lstatSync(path).size;
          } catch {
            complete = false;
          }
        }
      }
    } finally {
      dir.closeSync();
    }
    if (scannedEntries > limits.entries || performance.now() >= deadline) break;
  }
  let freeBytes: number | null = null;
  try {
    const fs = statfsSync(directory);
    freeBytes = fs.bavail * fs.bsize;
  } catch {
    /* Unknown, never zero. */
  }
  return { localBytes, freeBytes, complete, scannedEntries };
}
export function diskBudgetWarning(sample: Omit<DiskSample, 'warning'>) {
  const total = Object.values(sample.localBytes).reduce((n, bytes) => n + bytes, 0);
  const growth = Math.max(0, sample.growthBytesPerDay ?? 0),
    b = sample.budget;
  const reasons = [
    ...(total + growth * b.lookaheadDays >= b.maxBytes * 0.9
      ? ['project bytes approach the disk budget']
      : []),
    ...(growth >= b.maxGrowthBytesPerDay * 0.9 ? ['project growth approaches the daily budget'] : []),
    ...(sample.freeBytes !== null && sample.freeBytes - growth * b.lookaheadDays <= b.minFreeBytes * 1.1
      ? ['owner volume free space approaches its reserve']
      : []),
  ];
  return reasons.length
    ? `Disk: ${reasons.join('; ')}. Recorded ${sample.at}${sample.complete ? '' : ' (partial scan; bytes are lower bounds)'}.`
    : null;
}
/** Called only after a committed write. A durable day claim bounds scans across processes/restarts. */
export function sampleSelfMetricDisk(
  directory: string,
  now = new Date().toISOString(),
  scan = scanSelfMetricDisk,
): DiskSample | null {
  try {
    now = new Date(now).toISOString();
    const before = readSelfMetricDisk(directory);
    if (before?.at.slice(0, 10) === now.slice(0, 10)) return before;
    let fd;
    try {
      fd = openSync(join(directory, `self-metrics-disk-${now.slice(0, 10)}.sampled`), 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return before;
      throw error;
    }
    closeSync(fd);
    const measurement = scan(directory);
    const total = (bytes: DiskSample['localBytes']) =>
      Object.values(bytes).reduce((n, value) => n + value, 0);
    const days = before ? (Date.parse(now) - Date.parse(before.at)) / 86_400_000 : 0;
    const growthBytesPerDay =
      before?.complete && measurement.complete && days > 0
        ? (total(measurement.localBytes) - total(before.localBytes)) / days
        : null;
    const budget = diskBudgetSchema.parse(
      json(join(directory, 'self-metrics-disk-budget.json')) ?? defaultDiskBudget,
    );
    const sample: DiskSample = { at: now, ...measurement, budget, growthBytesPerDay, warning: null };
    sample.warning = diskBudgetWarning(sample);
    appendSelfMetric(directory, {
      schema: 1,
      kind: 'observation',
      action: 'disk-sample',
      operationId: `disk:${now.slice(0, 10)}`,
      actor: { kind: 'system', name: 'Forge disk sampler' },
      origin: 'system',
      at: now,
      disk: sample,
    });
    replace(statePath(directory), sample);
    return sample;
  } catch {
    // Disk diagnostics cannot turn an already committed write into a failed command.
    return null;
  }
}
