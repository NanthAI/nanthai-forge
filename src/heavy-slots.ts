// SPDX-License-Identifier: Apache-2.0
import { canonicalRoot } from './root-paths.js';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { heavySlots, readClientSettings } from './client-settings.js';
import { watchLocal, type LocalWatcher } from './local-watcher.js';
import { invariant } from './errors.js';
import { processAlive } from './local-process.js';
import {
  estimateWaitMs,
  joinQueue,
  leaveQueue,
  queuedNames,
  readHolds,
  readQueue,
  recordHold,
  startIdentity,
} from './heavy-queue.js';

/** Shared with every Lane and agent on this machine (and lane.sh's same-named slots). */
export function heavySlotDirectory() {
  return (
    process.env.FORGE_HEAVY_DIR ||
    (process.platform === 'win32' ? join(tmpdir(), 'forge-heavy-slots') : '/tmp/forge-heavy-slots')
  );
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
/** `deep` also compares the holder's start time (PID reuse); a holder without one is checked by pid. */
const holderAlive = (slot: string, pid: number, deep: boolean) => {
  if (!deep || !alive(pid)) return alive(pid);
  let startTime: string | undefined;
  try {
    startTime = readFileSync(join(slot, 'start'), 'utf8') || undefined;
  } catch {}
  return processAlive({ pid, startTime });
};
/** One attempt over all slots; a slot whose holder died is reclaimed. */
export function tryHeavySlot(
  directory: string,
  slots: number,
  pid = process.pid,
  deep = true,
): string | null {
  mkdirSync(directory, { recursive: true });
  for (let index = 1; index <= slots; index++) {
    const slot = join(directory, String(index));
    try {
      mkdirSync(slot);
      writeFileSync(join(slot, 'pid'), String(pid));
      const startTime = startIdentity(pid);
      if (startTime) writeFileSync(join(slot, 'start'), startTime);
      return slot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder = NaN,
      claimedAt = Date.now();
    try {
      claimedAt = statSync(slot).mtimeMs;
      holder = Number(readFileSync(join(slot, 'pid'), 'utf8'));
    } catch {}
    // A slot without a pid file is still being claimed, unless its claimer died a minute ago.
    const dead =
      Number.isSafeInteger(holder) && holder > 0
        ? !holderAlive(slot, holder, deep)
        : Date.now() - claimedAt > 60_000;
    if (dead) {
      rmSync(slot, { recursive: true, force: true });
      index--;
    }
  }
  return null;
}
export type HeavyWait = {
  /** 1 = next to run. */
  position: number;
  waiting: number;
  estimateMs: number | null;
  medianMs: number | null;
  samples: number;
};
/**
 * Slots go first come, first served. A caller finding anyone queued joins the back of the queue;
 * only the caller at the front tries the slots. Every change in the directory (a release, a new
 * or departed waiter) and a `tickMs` timer re-run one synchronous attempt; the timer also compares
 * start times, so a dead holder or waiter (even behind a reused PID) never blocks the queue.
 */
export function acquireHeavySlot(
  directory: string,
  slots: number,
  onWait: (wait: HeavyWait) => void = () => {},
  info: { command?: string | null; cwd?: string | null; tickMs?: number } = {},
): Promise<string> {
  mkdirSync(directory, { recursive: true });
  if (!queuedNames(directory).length) {
    const slot = tryHeavySlot(directory, slots);
    if (slot) return Promise.resolve(slot);
  }
  let ticket = joinQueue(directory, info),
    reported = 0;
  return new Promise<string>((resolve, reject) => {
    let finished = false;
    const handles: { watcher?: LocalWatcher; timer?: NodeJS.Timeout } = {};
    const finish = (slot?: string, error?: unknown) => {
      if (finished) return;
      finished = true;
      clearInterval(handles.timer);
      void handles.watcher?.close();
      leaveQueue(directory, ticket);
      if (slot) resolve(slot);
      else reject(error);
    };
    const attempt = (deep: boolean) => {
      if (finished) return;
      try {
        const queue = readQueue(directory, { deep, reap: true });
        const rank = queue.findIndex(item => item.name === ticket.name);
        if (rank < 0) ticket = joinQueue(directory, { ...info, seq: ticket.seq });
        else if (rank === 0) {
          const slot = tryHeavySlot(directory, slots, process.pid, deep);
          if (slot) return finish(slot);
        }
        if (rank >= 0 && rank + 1 !== reported) {
          reported = rank + 1;
          const running = heavyStatus(directory, slots).holders.map(holder => holder.elapsedMs);
          const estimate = estimateWaitMs(readHolds(directory), running, slots, rank);
          onWait({
            position: reported,
            waiting: queue.length,
            estimateMs: estimate?.estimateMs ?? null,
            medianMs: estimate?.medianMs ?? null,
            samples: estimate?.samples ?? 0,
          });
        }
      } catch (error) {
        finish(undefined, error);
      }
    };
    attempt(true);
    if (finished) return;
    // Attachment is asynchronous: a change before it opens is seen by the attempt after onReady.
    handles.watcher = watchLocal(directory, { onReady: () => queueMicrotask(() => attempt(false)) }, () =>
      attempt(false),
    );
    handles.timer = setInterval(() => attempt(true), info.tickMs ?? 3000);
  });
}

export const HEAVY_HELP = `nforge heavy CMD [ARGS...]
nforge heavy --status
nforge heavy --help | -h
Run bounded builds and test batches under the machine-wide slot limit.
Callers wait first come, first served; a waiting caller prints its queue position and an estimate.
--status lists the holders and the queue by Lane, command and time, never folders or arguments.
Run long-lived servers (Vite/dev servers) directly, outside heavy.
`;
const LANE_FOLDER =
  /(?:^|[\\/])lanes[\\/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[\\/]|$)/i;
/** A Lane id names who runs a command; a folder path never leaves the slot files. */
const laneOf = (folder: string | null) =>
  folder ? (LANE_FOLDER.exec(folder)?.[1]?.toLowerCase() ?? null) : null;
/** Metadata contains only the executable basename, never arguments or environment. */
export function heavyStatus(directory: string, slots: number, cwd = process.cwd()) {
  const holders = [];
  for (let index = 1; index <= slots; index++) {
    const slot = join(directory, String(index));
    try {
      const pid = Number(readFileSync(join(slot, 'pid'), 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0 || !holderAlive(slot, pid, true)) continue;
      let metadata: { cwd?: string; startedAt?: number; command?: string } = {};
      try {
        metadata = JSON.parse(readFileSync(join(slot, 'holder.json'), 'utf8'));
      } catch {}
      const folder = typeof metadata.cwd === 'string' ? metadata.cwd : null;
      holders.push({
        slot: index,
        pid,
        lane: laneOf(folder),
        elapsedMs: Math.max(
          0,
          Date.now() - (typeof metadata.startedAt === 'number' ? metadata.startedAt : statSync(slot).mtimeMs),
        ),
        command: typeof metadata.command === 'string' ? basename(metadata.command) : null,
        selfHeld: folder !== null && canonicalRoot(folder) === canonicalRoot(cwd),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const queue = readQueue(directory, { deep: true }).map((ticket, index) => ({
    position: index + 1,
    pid: ticket.pid,
    lane: laneOf(ticket.cwd),
    command: ticket.command,
    waitedMs: Math.max(0, Date.now() - ticket.queuedAt),
    self: ticket.pid === process.pid,
  }));
  const holds = readHolds(directory);
  const medianMs = holds.length ? holds.slice().sort((a, b) => a - b)[Math.floor(holds.length / 2)]! : null;
  return { slots, holders, queue, medianHoldMs: medianMs, selfHeld: holders.some(holder => holder.selfHeld) };
}
const minutes = (ms: number) =>
  ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
const waitingMessage = (slots: number, directory: string, wait: HeavyWait) => {
  const { holders } = heavyStatus(directory, slots);
  const who = holders
    .map(holder =>
      `${holder.lane ? `Lane ${holder.lane.slice(0, 8)}` : 'pid ' + holder.pid} ${holder.command ?? ''} ${minutes(holder.elapsedMs)}`.replace(
        / +/g,
        ' ',
      ),
    )
    .join('; ');
  return (
    `heavy: waiting for one of ${slots} machine-wide slots, first come, first served. Queue position ${wait.position} of ${wait.waiting}` +
    (wait.estimateMs === null
      ? '; no estimate yet (needs a few finished heavy commands on this machine)'
      : `; estimated wait about ${minutes(wait.estimateMs)} (median heavy command ${minutes(wait.medianMs ?? 0)}, last ${wait.samples})`) +
    `. Running: ${who || 'none seen'}. Run nforge heavy --status for the queue.\n`
  );
};

/** nforge heavy CMD [ARGS...]: run one heavy local command under the machine-wide slot limit. */
export async function heavyCli(
  args: string[],
  beforeRun?: () => Promise<boolean>,
  beforeLocal?: () => Promise<void>,
): Promise<number> {
  if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]!))) {
    await beforeLocal?.();
    process.stdout.write(HEAVY_HELP);
    return 0;
  }
  invariant(
    !args[0]!.startsWith('-') || args[0] === '--status',
    'BAD_ARGUMENT',
    'Unknown heavy option. Run nforge heavy --help; use heavy CMD [ARGS...] for a bounded batch.',
  );
  invariant(
    args[0] !== '--status' || args.length === 1,
    'BAD_ARGUMENT',
    'heavy --status takes no command. Run nforge heavy --status.',
  );
  const slots = heavySlots(readClientSettings().localHeavySlots);
  if (args[0] === '--status') {
    await beforeLocal?.();
    process.stdout.write(`${JSON.stringify(heavyStatus(heavySlotDirectory(), slots))}\n`);
    return 0;
  }
  if (beforeRun && !(await beforeRun())) return Number(process.exitCode ?? 0);
  const slot =
    slots === 0
      ? null
      : await acquireHeavySlot(
          heavySlotDirectory(),
          slots,
          wait => process.stderr.write(waitingMessage(slots, heavySlotDirectory(), wait)),
          { command: args[0]!, cwd: process.cwd() },
        );
  const heldSince = Date.now();
  const release = () => {
    if (slot) rmSync(slot, { recursive: true, force: true });
  };
  process.once('exit', release);
  try {
    if (slot)
      writeFileSync(
        join(slot, 'holder.json'),
        JSON.stringify({ cwd: process.cwd(), startedAt: Date.now(), command: basename(args[0]!) }),
      );
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(args[0]!, args.slice(1), { stdio: 'inherit' });
      const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
      const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(
        signal => [signal, forward(signal)] as const,
      );
      for (const [signal, handler] of handlers) process.on(signal, handler);
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        for (const [name, handler] of handlers) process.removeListener(name, handler);
        resolve(code ?? 128 + (signal ? constants.signals[signal] : 0));
      });
    });
  } finally {
    release();
    process.removeListener('exit', release);
    if (slot) recordHold(heavySlotDirectory(), Date.now() - heldSince);
  }
}
