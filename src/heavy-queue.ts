// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { processesAlive, processIdentity, processStartTime } from './local-process.js';

/** The FIFO queue in front of the heavy slots: one small file per waiting `nforge heavy`, named
 * `q-<arrival>-<pid>-<random>` so a plain sort is arrival order. Local files only. */
export type HeavyTicket = {
  name: string;
  pid: number;
  seq: number;
  startTime?: string;
  queuedAt: number;
  command: string | null;
  cwd: string | null;
};
const PREFIX = 'q-';
/** Kernel start identity guards against PID reuse; unavailable identity falls back to the pid. */
export function startIdentity(pid = process.pid): string | undefined {
  try {
    return pid === process.pid ? processIdentity().startTime : processStartTime(pid);
  } catch {
    return undefined;
  }
}
const HISTORY = 'history.json';
const HISTORY_LENGTH = 32;
const MIN_HISTORY = 3;

const ticketName = /^q-(\d{15})-(\d+)-[0-9a-f]{8}$/;
export const queuedNames = (directory: string): string[] => {
  try {
    return readdirSync(directory)
      .filter(name => ticketName.test(name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};
/** Take a place at the back of the queue; `seq` keeps an earlier place after a lost ticket. */
export function joinQueue(
  directory: string,
  info: { command?: string | null; cwd?: string | null; pid?: number; seq?: number } = {},
): HeavyTicket {
  const pid = info.pid ?? process.pid;
  const last = Number(ticketName.exec(queuedNames(directory).at(-1) ?? '')?.[1] ?? 0);
  // Never sort before an existing ticket, even if the clock stepped back.
  const seq = info.seq ?? Math.max(Date.now(), last + 1);
  const startTime = startIdentity(pid);
  const ticket: HeavyTicket = {
    name: `${PREFIX}${String(seq).padStart(15, '0')}-${pid}-${randomUUID().slice(0, 8)}`,
    pid,
    seq,
    ...(startTime ? { startTime } : {}),
    queuedAt: Date.now(),
    command: info.command ? basename(info.command) : null,
    cwd: info.cwd ?? null,
  };
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `t-${ticket.name}.tmp`);
  // The name carries pid and arrival; the file adds what a name cannot.
  writeFileSync(
    temporary,
    JSON.stringify({
      startTime: ticket.startTime,
      queuedAt: ticket.queuedAt,
      command: ticket.command,
      cwd: ticket.cwd,
    }),
  );
  renameSync(temporary, join(directory, ticket.name));
  return ticket;
}
export const leaveQueue = (directory: string, ticket: { name: string }) =>
  rmSync(join(directory, ticket.name), { force: true });

function readTicket(directory: string, name: string): HeavyTicket {
  const [, seq, pid] = ticketName.exec(name)!;
  let record: Partial<HeavyTicket> = {};
  try {
    record = JSON.parse(readFileSync(join(directory, name), 'utf8')) as Partial<HeavyTicket>;
  } catch {}
  return {
    name,
    pid: Number(pid),
    seq: Number(seq),
    ...(typeof record.startTime === 'string' ? { startTime: record.startTime } : {}),
    queuedAt: typeof record.queuedAt === 'number' ? record.queuedAt : Number(seq),
    command: typeof record.command === 'string' ? record.command : null,
    cwd: typeof record.cwd === 'string' ? record.cwd : null,
  };
}
/** Waiting callers in arrival order. `deep` also compares process start times (PID reuse); the
 * cheap form only drops pids that no longer exist. `reap` deletes the dead tickets it finds. */
export function readQueue(directory: string, options: { deep?: boolean; reap?: boolean } = {}) {
  const tickets = queuedNames(directory).map(name => readTicket(directory, name));
  const alive = options.deep
    ? processesAlive(tickets)
    : tickets.map(ticket => {
        try {
          process.kill(ticket.pid, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
      });
  if (options.reap) tickets.forEach((ticket, index) => alive[index] || leaveQueue(directory, ticket));
  return tickets.filter((_, index) => alive[index]);
}

/** Recent hold times, newest last. Losing an entry to a concurrent write only blurs an estimate. */
export function readHolds(directory: string): number[] {
  try {
    const value = JSON.parse(readFileSync(join(directory, HISTORY), 'utf8')) as unknown;
    return Array.isArray(value)
      ? value.filter((item): item is number => Number.isFinite(item) && item >= 0)
      : [];
  } catch {
    return [];
  }
}
export function recordHold(directory: string, ms: number) {
  try {
    const temporary = join(directory, `t-${HISTORY}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
    writeFileSync(
      temporary,
      JSON.stringify([...readHolds(directory), Math.round(ms)].slice(-HISTORY_LENGTH)),
    );
    renameSync(temporary, join(directory, HISTORY));
  } catch {}
}
/** Wait until a caller with `ahead` waiters in front of it starts: the earliest slot to free
 * serves each waiter in turn for the median hold time. Null without enough history. */
export function estimateWaitMs(holds: number[], runningMs: number[], slots: number, ahead: number) {
  if (holds.length < MIN_HISTORY) return null;
  const sorted = holds.slice().sort((a, b) => a - b),
    median = sorted[Math.floor(sorted.length / 2)]!;
  // A holder past the median is assumed to need half a median more.
  const free = [
    ...runningMs.map(elapsed => (elapsed < median ? median - elapsed : median / 2)),
    ...Array(Math.max(0, slots - runningMs.length)).fill(0),
  ].sort((a, b) => a - b);
  for (let turn = 0; turn < ahead && free.length; turn++) {
    free[0]! += median;
    free.sort((a, b) => a - b);
  }
  return { estimateMs: Math.round(free[0] ?? 0), medianMs: median, samples: holds.length };
}
