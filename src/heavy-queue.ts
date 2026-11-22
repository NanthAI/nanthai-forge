// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

/** What a hold was spent on (Item 7008ff18); see commandKind in heavy-hold.ts. */
export type HeavyKind = 'test' | 'typecheck' | 'build' | 'other';
const LANE_FOLDER =
  /(?:^|[\\/])lanes[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\/]|$)/i;
/** A Lane id names who runs a command; a folder path never leaves the slot files. */
export const laneOf = (folder: string | null) =>
  folder ? (LANE_FOLDER.exec(folder)?.[1]?.toLowerCase() ?? null) : null;

/** One finished hold. `cpu`: peak cores the command's process tree used (sampled); `load`: peak
 * 1-minute load average seen while it held the slot. Null where the platform cannot tell. */
export type HeavyHold = {
  at: number;
  ms: number;
  lane: string | null;
  kind: HeavyKind;
  cpu: number | null;
  load: number | null;
  /** How long the command queued for its slot (ff33e9a6); absent on older lines. */
  wait?: number;
};
const HISTORY = 'holds.jsonl';
/** Rolling bound: past maxBytes the file is rewritten with its newest `keep` holds (~110 bytes
 * each: about a busy day of holds at 2 slots). Losing a line to a concurrent trim only blurs it. */
const LIMITS = { maxBytes: 512 * 1024, keep: 2048 };
const ESTIMATE_SAMPLES = 32;

export function recordHold(
  directory: string,
  ms: number,
  hold: Partial<Omit<HeavyHold, 'ms'>> = {},
  limits = LIMITS,
) {
  const entry: HeavyHold = {
    at: hold.at ?? Date.now() - ms,
    ms: Math.round(ms),
    lane: hold.lane ?? null,
    kind: hold.kind ?? 'other',
    cpu: hold.cpu ?? null,
    load: hold.load ?? null,
    ...(typeof hold.wait === 'number' && hold.wait >= 0 ? { wait: Math.round(hold.wait) } : {}),
  };
  try {
    const path = join(directory, HISTORY);
    // One small append per hold; a single write under PIPE_BUF lands whole.
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
    if (statSync(path).size <= limits.maxBytes) return;
    const kept = readFileSync(path, 'utf8').trimEnd().split('\n').slice(-limits.keep);
    const temporary = join(directory, `t-${HISTORY}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
    writeFileSync(temporary, `${kept.join('\n')}\n`);
    renameSync(temporary, path);
  } catch {}
}
const parse = (line: string): HeavyHold | null => {
  try {
    const value = JSON.parse(line) as HeavyHold;
    return Number.isFinite(value.at) && Number.isFinite(value.ms) && value.ms >= 0 ? value : null;
  } catch {
    return null;
  }
};
/** Holds newest last; `tailBytes` reads only the end of the file (wait estimates). */
export function readHoldHistory(directory: string, tailBytes?: number): HeavyHold[] {
  let text = '';
  try {
    const fd = openSync(join(directory, HISTORY), 'r');
    try {
      const size = fstatSync(fd).size,
        length = Math.min(size, tailBytes ?? size);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
      if (length < size) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
  return text.split('\n').flatMap(line => parse(line) ?? []);
}
/** Recent hold times for wait estimates, newest last. */
export const readHolds = (directory: string) =>
  readHoldHistory(directory, ESTIMATE_SAMPLES * 256)
    .slice(-ESTIMATE_SAMPLES)
    .map(hold => hold.ms);

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
