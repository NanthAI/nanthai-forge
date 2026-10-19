// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { workProgress, workProgressIdentity } from './work-progress.js';
import { CheckQueue, queueHolder } from './check-queue.js';
import { processAlive, processIdentity } from './local-process.js';
import { ForgeError, invariant } from './errors.js';

export type WorkLockOptions = {
  cancelled?: (() => boolean) | undefined;
  waitMs?: number | undefined;
  operation?: string | undefined;
  actor?: string | undefined;
};
const context = new AsyncLocalStorage<WorkLockOptions>();
export const withWorkLockOptions = <T>(options: WorkLockOptions, run: () => T) =>
  context.run({ ...context.getStore(), ...options }, run);
type Holder = {
  pid: number;
  host: string;
  startTime?: string;
  operation?: string;
  actor?: string;
  startedAt?: string;
  operationId?: string;
  runId?: string;
  phase?: string;
};
function holder(path: string): Holder | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Holder | null;
    return value && typeof value === 'object' && Number.isInteger(value.pid) && value.pid > 0
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
function description(owner?: Holder) {
  const age = owner?.startedAt
    ? Math.max(0, Math.floor((Date.now() - Date.parse(owner.startedAt)) / 1000))
    : undefined;
  return `${owner?.operation ?? 'work operation'} by ${owner?.actor ?? (owner ? `pid ${owner.pid}` : 'admission pending (holder details not published)')}${age === undefined ? '' : ` (started ${age >= 60 ? `${Math.floor(age / 60)}m` : `${age}s`} ago)`}`.replace(
    /[\r\n]/g,
    ' ',
  );
}
export const workLockWaitMs = () =>
  context.getStore()?.waitMs ?? Number(process.env.FORGE_WORK_LOCK_WAIT_MS ?? 600000);
export const workQueueWaitMs = () =>
  context.getStore()?.waitMs ??
  Number(process.env.FORGE_LANDING_LOCK_WAIT_MS ?? process.env.FORGE_WORK_LOCK_WAIT_MS ?? 600000);
function recover(path: string) {
  const owner = holder(path);
  if (
    !owner ||
    owner.host !== hostname() ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    processAlive(owner)
  )
    return;
  const recovery = `${path}-recovery`;
  try {
    mkdirSync(recovery, { mode: 0o700 });
  } catch {
    return;
  }
  try {
    const current = holder(path);
    if (
      current &&
      current.host === hostname() &&
      Number.isInteger(current.pid) &&
      current.pid > 0 &&
      !processAlive(current)
    )
      unlinkSync(path);
  } finally {
    rmdirSync(recovery);
  }
}
/** FIFO admission plus the legacy exclusive file: old writers and ambiguous locks
 * remain respected. Dead queue tickets use kernel process identities, never age. */
export function workLocked<T>(path: string, run: () => T, options: WorkLockOptions = {}): T {
  const settings = { ...context.getStore(), ...options },
    waitMs = settings.waitMs ?? workLockWaitMs();
  invariant(
    Number.isSafeInteger(waitMs) && waitMs >= 0,
    'BAD_ARGUMENT',
    'Work lock waitMs must be a nonnegative safe integer.',
  );
  const began = Date.now(),
    queue = new CheckQueue(`${path}-queue`, {
      limit: 1,
      serializeAdmission: false,
      anchor: dirname(path),
    });
  let fd: number | undefined,
    announced = 0;
  try {
    for (;;) {
      invariant(!settings.cancelled?.(), 'CANCELLED', 'Finish cancelled while waiting for a Work lock.');
      const position = queue.position();
      if (position.acquired) {
        if (existsSync(path)) recover(path);
        try {
          fd = openSync(path, 'wx', 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        if (fd !== undefined) break;
      }
      const owner = holder(path);
      const details = `waiting for ${description(owner)}${owner?.phase ? ` phase=${owner.phase}` : ''}${owner?.operationId ? ` operation=${owner.operationId}` : ''}${owner?.runId ? ` run=${owner.runId}` : ''}; queue position=${position.position}; ${owner ? '' : `holder=${queueHolder(position.holder)}`}`;
      if (!announced || Date.now() - announced >= 5000) {
        workProgress('waiting for lock', details, path);
        announced = Date.now();
      }
      if (Date.now() - began >= waitMs)
        throw new ForgeError(
          'WORK_BUSY',
          `Timed out after ${waitMs}ms: ${details}. Existing work and lock are preserved. Retry the original operation ${workProgressIdentity().operationId ?? 'ID'} or increase lockWaitMs/FORGE_WORK_LOCK_WAIT_MS.`,
        );
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.min(25, Math.max(1, waitMs - (Date.now() - began))),
      );
    }
    const started = Date.now(),
      identity = processIdentity(),
      owner = {
        ...identity,
        ...workProgressIdentity(),
        host: hostname(),
        operation: settings.operation ?? 'work',
        actor: settings.actor ?? `pid ${process.pid}`,
        startedAt: new Date(started).toISOString(),
      };
    try {
      writeFileSync(fd, JSON.stringify(owner));
      fsyncSync(fd);
      return run();
    } finally {
      closeSync(fd);
      fd = undefined;
      unlinkSync(path);
      if (process.env.FORGE_WORK_LOCK_TRACE) {
        // Diagnostics must never turn an already committed mutation into a failure.
        try {
          appendFileSync(
            process.env.FORGE_WORK_LOCK_TRACE,
            JSON.stringify({ ...owner, path, waitMs: started - began, holdMs: Date.now() - started }) + '\n',
            { mode: 0o600 },
          );
        } catch {
          /* Optional telemetry. */
        }
      }
    }
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      unlinkSync(path);
    }
    queue.release();
  }
}
