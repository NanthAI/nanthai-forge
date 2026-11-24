// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { canonicalRoot } from './root-paths.js';
import { spawn } from 'node:child_process';
import { isatty } from 'node:tty';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { HeavyAdmission, HeavyHolderUse } from './heavy-admission.js';
import { availableParallelism, constants, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { heavySlots, readClientSettings } from './client-settings.js';
import { watchLocal, type LocalWatcher } from './local-watcher.js';
import { invariant } from './errors.js';
import { ensureCoreBuild } from './heavy-build.js';
import {
  isExplicitFullTestScript,
  needsCoreBuild,
  nodeTestPathCount,
  nodeTestWithoutPaths,
  preloadRefusal,
} from './heavy-test-preloads.js';
export { needsCoreBuild, nodeTestPathCount, nodeTestWithoutPaths };
import { processAlive } from './local-process.js';
import {
  estimateWaitMs,
  joinQueue,
  laneOf,
  leaveQueue,
  queuedNames,
  readHoldHistory,
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
/** Default hold bound (client setting localHeavyMaxMinutes): a hung command frees its slot. Holds on
 * this machine take seconds to about 10 min, so an hour is far past any live build or test batch. */
export const HEAVY_MAX_MS = 60 * 60_000;
/** A holder past its bound by this much did not stop itself (a CLI from before the bound, or a wedged
 * holder): the next waiter frees the slot without signalling the process. */
export const HEAVY_OVERDUE_GRACE_MS = 5 * 60_000;
/** The holder's declared bound and start (holder.json); older holders declare no bound. */
function holderBound(slot: string): { startedAt?: number; maxMs: number } {
  try {
    const record = JSON.parse(readFileSync(join(slot, 'holder.json'), 'utf8')) as {
      startedAt?: unknown;
      maxMs?: unknown;
    };
    return {
      ...(typeof record.startedAt === 'number' ? { startedAt: record.startedAt } : {}),
      maxMs: typeof record.maxMs === 'number' && record.maxMs >= 0 ? record.maxMs : HEAVY_MAX_MS,
    };
  } catch {
    return { maxMs: HEAVY_MAX_MS };
  }
}
/** A live holder still running past its own bound plus the grace (0 = unbounded, never overdue). */
export const holderOverdue = (slot: string, now = Date.now()) => {
  const { startedAt, maxMs } = holderBound(slot);
  return startedAt !== undefined && maxMs > 0 && now - startedAt > maxMs + HEAVY_OVERDUE_GRACE_MS;
};
/** Claim `slot` for `pid`; false when someone else has it. */
function claimSlot(slot: string, pid: number) {
  try {
    mkdirSync(slot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  }
  try {
    writeFileSync(join(slot, 'pid'), String(pid));
    const startTime = startIdentity(pid);
    if (startTime) writeFileSync(join(slot, 'start'), startTime);
  } catch (error) {
    // A half-written claim would hold the folder for a live process until it exits.
    rmSync(slot, { recursive: true, force: true });
    throw error;
  }
  return true;
}
/** An existing slot's holder, and whether it is dead: its process gone, or running far past its bound.
 * A slot without a pid file is still being claimed (pid 0), unless its claimer died a minute ago. An
 * overdue holder is not signalled: its process may still be someone's live work. Removes nothing. */
function inspectHolder(slot: string, deep: boolean): { pid: number; claimedAt: number; dead: boolean } {
  let holder = NaN,
    claimedAt = Date.now();
  try {
    claimedAt = statSync(slot).mtimeMs;
    holder = Number(readFileSync(join(slot, 'pid'), 'utf8'));
  } catch {}
  const valid = Number.isSafeInteger(holder) && holder > 0;
  const dead = valid
    ? !holderAlive(slot, holder, deep) || holderOverdue(slot)
    : Date.now() - claimedAt > 60_000;
  return { pid: valid ? holder : 0, claimedAt, dead };
}
const pidOf = (slot: string) => {
  try {
    const holder = Number(readFileSync(join(slot, 'pid'), 'utf8'));
    return Number.isSafeInteger(holder) && holder > 0 ? holder : 0;
  } catch {
    return 0;
  }
};
/**
 * Remove `slot` only while `pid` still holds it (0 = a claim without a pid file yet). The folder is
 * moved aside by rename, which one caller wins, and its holder checked there: a claim made after the
 * caller looked is put back, never removed. Only a third claim of the same path in the instant
 * between the move and the put-back loses the displaced one. True when the folder is gone.
 */
function removeIfHolder(slot: string, pid: number): boolean {
  const aside = `${slot}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(slot, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return true;
  }
  const same = pidOf(aside) === pid;
  if (!same)
    try {
      renameSync(aside, slot);
    } catch {} // Claimed again meanwhile: the displaced claim is dropped with the folder below.
  rmSync(aside, { recursive: true, force: true });
  return same;
}
/** An existing slot's holder, or null after removing a dead one. Only the admission lock's holder
 * may call it: two callers that both see a dead holder would each remove the slot, and the second
 * removal would take the claim the first had just made (Item ff33e9a6). */
function liveHolder(slot: string, deep: boolean): { pid: number; claimedAt: number } | null {
  const seen = inspectHolder(slot, deep);
  if (!seen.dead) return seen;
  return removeIfHolder(slot, seen.pid) ? null : { pid: seen.pid, claimedAt: seen.claimedAt };
}
const ADMIT_LOCK = 'admit.lock';
/**
 * Take the directory's admission lock (one folder, claimed like a slot by this process), or null when
 * another live caller holds it. A lock whose holder died is moved aside by rename, which one caller
 * wins, and the moved folder is checked to be the dead one seen: a fresh lock taken in between is
 * put back, never removed.
 */
function takeAdmitLock(directory: string, deep: boolean): string | null {
  const lock = join(directory, ADMIT_LOCK);
  if (claimSlot(lock, process.pid)) return lock;
  const seen = inspectHolder(lock, deep);
  if (!seen.dead || !removeIfHolder(lock, seen.pid)) return null;
  return claimSlot(lock, process.pid) ? lock : null;
}
/**
 * One attempt over all slots. A slot whose holder died, or ran far past its bound, is reclaimed
 * under the admission lock: the dead check is repeated there, so a slot another caller reclaimed and
 * claimed first is seen as live and left alone. A busy lock leaves the slot to the next attempt.
 */
export function tryHeavySlot(
  directory: string,
  slots: number,
  pid = process.pid,
  deep = true,
  createDirectory = true,
): string | null {
  if (createDirectory) mkdirSync(directory, { recursive: true });
  for (let index = 1; index <= slots; index++) {
    const slot = join(directory, String(index));
    if (claimSlot(slot, pid)) return slot;
    if (!inspectHolder(slot, deep).dead) continue;
    const lock = takeAdmitLock(directory, deep);
    if (!lock) continue;
    try {
      if (existsSync(slot)) {
        const again = inspectHolder(slot, deep);
        if (!again.dead || !removeIfHolder(slot, again.pid)) continue;
      }
      if (claimSlot(slot, pid)) return slot;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  return null;
}
/** Numbered slot folders present, with 1..`at least`; a slot above the current limit still counts. */
function slotIndexes(directory: string, atLeast: number) {
  const indexes = new Set(Array.from({ length: atLeast }, (_, index) => index + 1));
  try {
    for (const name of readdirSync(directory)) if (/^[1-9][0-9]*$/.test(name)) indexes.add(Number(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return [...indexes].sort((a, b) => a - b);
}
/** The live holders as the admission sees them: pid, time held and declared cores (holder.json). */
function holderUses(directory: string, indexes: number[], deep: boolean, now = Date.now()) {
  const holders: (HeavyHolderUse & { index: number })[] = [];
  for (const index of indexes) {
    const slot = join(directory, String(index));
    if (!existsSync(slot)) continue;
    const live = liveHolder(slot, deep);
    if (!live) continue;
    let record: { startedAt?: unknown; cores?: unknown } = {};
    try {
      record = JSON.parse(readFileSync(join(slot, 'holder.json'), 'utf8'));
    } catch {}
    const startedAt = typeof record.startedAt === 'number' ? record.startedAt : live.claimedAt;
    holders.push({
      index,
      pid: live.pid,
      elapsedMs: Math.max(0, now - startedAt),
      declared: typeof record.cores === 'number' && record.cores > 0 ? record.cores : null,
    });
  }
  return holders;
}
/**
 * One measured attempt (Item ff33e9a6): the base slots as before, then extra slots up to the
 * admission's limit while it finds room. Measured attempts decide and claim under one lock (the
 * caller at the front of the queue, plus a caller finding no queue), so two never both take the
 * last room; a busy lock is a retry on the next change or tick.
 */
export function tryHeavyAdmission(
  directory: string,
  base: number,
  admission: HeavyAdmission,
  pid = process.pid,
  deep = true,
  now = Date.now(),
): { slot: string | null; reason: string | null } {
  mkdirSync(directory, { recursive: true });
  // Held by the deciding process (a preflight claims for its parent through a child); one folder,
  // removed whole, so nothing stays behind. A lock whose holder died is reclaimed.
  const lock = takeAdmitLock(directory, deep);
  if (!lock) return { slot: null, reason: null };
  try {
    const limit = admission.limit(base);
    const holders = holderUses(directory, slotIndexes(directory, limit), deep, now);
    const decision = admission.decide(base, holders);
    if (!decision.admit) return { slot: null, reason: decision.reason };
    const taken = new Set(holders.map(holder => holder.index));
    for (let index = 1; index <= limit; index++)
      if (!taken.has(index) && claimSlot(join(directory, String(index)), pid))
        return { slot: join(directory, String(index)), reason: null };
    return { slot: null, reason: null };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
export type HeavyWait = {
  /** 1 = next to run. */
  position: number;
  waiting: number;
  estimateMs: number | null;
  medianMs: number | null;
  samples: number;
  /** Why the measured admission holds the caller although a base slot or burst room was asked for. */
  reason?: string | null;
};
/**
 * Slots go first come, first served. A caller finding anyone queued joins the back of the queue;
 * only the caller at the front tries the slots. Every change in the directory (a release, a new
 * or departed waiter) and a `tickMs` timer re-run one synchronous attempt; the timer also compares
 * start times, so a dead holder or waiter (even behind a reused PID) never blocks the queue.
 * `slots` may be read again on every attempt, so a raised limit is used by the waiters already
 * queued; `wakeHeavyWaiters` makes that attempt immediate (friction 25f56c0a).
 */
export function acquireHeavySlot(
  directory: string,
  slots: number | (() => number),
  onWait: (wait: HeavyWait) => void = () => {},
  info: {
    command?: string | null;
    cwd?: string | null;
    tickMs?: number;
    /** The request is about to join the queue, even if its first retry gets the slot. */
    onQueue?: () => void;
    /** The process the slot is held for (default this one): preflight claims it through a child. */
    holder?: number;
    /** Measured admission (Item ff33e9a6): extra slots while CPU, load and memory leave room, and a
     * memory freeze guard on every slot. Without it the count is fixed, as for the locks built on slots. */
    admission?: HeavyAdmission;
  } = {},
): Promise<string> {
  mkdirSync(directory, { recursive: true });
  const holder = info.holder ?? process.pid;
  let count = typeof slots === 'number' ? slots : slots();
  const current = () => {
    if (typeof slots === 'number') return count;
    try {
      return (count = slots());
    } catch {
      return count; // A settings file mid-edit keeps the last good limit.
    }
  };
  let reason: string | null = null;
  const tryOnce = (limit: number, deep: boolean) => {
    if (!info.admission) return tryHeavySlot(directory, limit, holder, deep);
    const result = tryHeavyAdmission(directory, limit, info.admission, holder, deep);
    reason = result.reason;
    return result.slot;
  };
  if (!queuedNames(directory).length) {
    const slot = tryOnce(count, true);
    if (slot) return Promise.resolve(slot);
  }
  info.onQueue?.();
  let ticket = joinQueue(directory, info),
    reported = 0,
    reportedReason: string | null = null;
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
          const slot = tryOnce(current(), deep);
          if (slot) return finish(slot);
        }
        // A held caller says why once; reasons that only change their numbers rescan nothing.
        if (rank >= 0 && (rank + 1 !== reported || (rank === 0 && !reportedReason && reason))) {
          reported = rank + 1;
          reportedReason = rank === 0 ? reason : null;
          const running = heavyStatus(directory, count).holders.map(holder => holder.elapsedMs);
          const estimate = estimateWaitMs(readHolds(directory), running, count, rank);
          onWait({
            position: reported,
            waiting: queue.length,
            estimateMs: estimate?.estimateMs ?? null,
            medianMs: estimate?.medianMs ?? null,
            samples: estimate?.samples ?? 0,
            ...(reportedReason ? { reason: reportedReason } : {}),
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

/** How long a stopped command may take to exit before heavy kills it. */
export const HEAVY_KILL_GRACE_MS = 10_000;
const WAKE = 'slots-changed';
/** Touch the slot directory so every waiter re-runs its attempt now (its watcher fires) and reads
 * the slot count again; local only, nothing is created where no one has waited. */
export function wakeHeavyWaiters(directory = heavySlotDirectory()) {
  try {
    writeFileSync(join(directory, WAKE), String(Date.now()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export const HEAVY_HELP = `nforge heavy [--] CMD [ARGS...]
nforge heavy --no-build [--] CMD [ARGS...]
nforge heavy --cores N [--max-minutes M] [--] CMD [ARGS...]
nforge heavy --status | status
nforge heavy --help | -h | help
Run bounded builds and test batches under the machine-wide slot limit.
Nested commands reuse their live parent slot.
--no-build runs tests against the existing dist/ without rebuilding it (failing-first checks).
Callers wait first come, first served; a waiting caller prints its queue position and an estimate.
Past the localHeavySlots base, extra slots (up to twice the base, at most the cores) open one at a time
while measured load plus the holders' CPU leaves room for the next command and a quarter of memory is
free. Admission also counts resident memory outside heavy's own slots and macOS kernel memory pressure,
holding new slots when total projected RAM passes the floor (90% base, 75% extra) or under 10% free memory.
--cores N declares and caps a command's cores (test concurrency, GOMAXPROCS); it counts N, not a slot's
share. --max-minutes M sets its own bound; a bound past localHeavyMaxMinutes needs --cores below the
slot share (long one-core work such as a model check).
--status lists the holders and the queue by Lane, command and time, never folders or arguments,
and sums the last day of holds (per kind, busiest Lanes, CPU and load peaks).
A command still running after localHeavyMaxMinutes (nforge settings; default 60, 0 = no bound) is
stopped (exit 124) and frees its slot; a signal to heavy reaches the command, which is killed if it
has not exited 10 s later. When the command ends, anything it started that is still running stops too. A holder that never stopped itself is freed 5 min past its bound, unsignalled.
Run long-lived servers (Vite/dev servers) directly, outside heavy.
node --test with no test file path is refused (including inside sh -c, npm scripts or empty globs); name the files, or run nforge heavy npm test on purpose.
`;
/** Metadata contains only the executable basename, never arguments or environment. */
export function heavySlotHolders(
  directory: string,
  slots: number,
  cwd = process.cwd(),
  identifyLane = laneOf,
) {
  const holders = [];
  // Extra slots above the base limit are holders too.
  for (const index of slotIndexes(directory, slots)) {
    const slot = join(directory, String(index));
    try {
      const pid = Number(readFileSync(join(slot, 'pid'), 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0 || !holderAlive(slot, pid, true)) continue;
      let metadata: { cwd?: string; startedAt?: number; command?: string; maxMs?: number } = {};
      try {
        metadata = JSON.parse(readFileSync(join(slot, 'holder.json'), 'utf8'));
      } catch {}
      const folder = typeof metadata.cwd === 'string' ? metadata.cwd : null;
      const elapsedMs = Math.max(
        0,
        Date.now() - (typeof metadata.startedAt === 'number' ? metadata.startedAt : statSync(slot).mtimeMs),
      );
      const maxMs = typeof metadata.maxMs === 'number' ? metadata.maxMs : HEAVY_MAX_MS;
      holders.push({
        slot: index,
        pid,
        lane: identifyLane(folder),
        elapsedMs,
        command: typeof metadata.command === 'string' ? basename(metadata.command) : null,
        selfHeld: folder !== null && canonicalRoot(folder) === canonicalRoot(cwd),
        ...(maxMs > 0 && elapsedMs > maxMs ? { overBound: true } : {}),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return holders;
}

export function heavyStatus(directory: string, slots: number, cwd = process.cwd()) {
  const holders = heavySlotHolders(directory, slots, cwd);
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
/** heavy-hold loads only for a heavy command, never on the paths that only take a slot (the MCP
 * startup graph reaches this module); a sibling URL keeps the CLI bundle from splitting it. */
const loadHold = async () =>
  (await import(
    /* @vite-ignore */ new URL('./heavy-hold.js', import.meta.url).href
  )) as typeof import('./heavy-hold.js');
/** The measured admission, loaded like heavy-hold: only for a heavy command. */
const loadAdmission = async () =>
  (await import(
    /* @vite-ignore */ new URL('./heavy-admission.js', import.meta.url).href
  )) as typeof import('./heavy-admission.js');
/** The measured admission for any machine-wide heavy lease (nforge heavy, preflight, a shared
 * dependency install, a CLI update build); private locks built on slots keep a fixed count. */
export const measuredHeavyAdmission = async (declared: number | null = null) =>
  (await loadAdmission()).heavyAdmission({ cores: availableParallelism(), declared });
/** Stopping a command's process group, loaded like heavy-hold: only for a heavy command. */
const loadStop = async () =>
  (await import(
    /* @vite-ignore */ new URL('./stop-process-tree.js', import.meta.url).href
  )) as typeof import('./stop-process-tree.js');
/** `nforge heavy --status`: the live slots plus the last day of holds (when, who, what kind, peaks). */
async function heavyStatusReport(directory: string, slots: number) {
  const { holdSummary } = await loadHold();
  return { ...heavyStatus(directory, slots), today: holdSummary(readHoldHistory(directory)) };
}
const minutes = (ms: number) =>
  ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
export const waitingMessage = (slots: number, directory: string, wait: HeavyWait) => {
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
    `heavy: waiting for one of ${slots} machine-wide slots (more while CPU, load and memory leave room), first come, first served. Queue position ${wait.position} of ${wait.waiting}` +
    (wait.reason ? `; next in line but held: ${wait.reason}` : '') +
    (wait.estimateMs === null
      ? '; no estimate yet (needs a few finished heavy commands on this machine)'
      : `; estimated wait about ${minutes(wait.estimateMs)} (median heavy command ${minutes(wait.medianMs ?? 0)}, last ${wait.samples})`) +
    `. Running: ${who || 'none seen'}. Run nforge heavy --status for the queue.\n`
  );
};

/**
 * True for Forge's own `nforge agent ROOT preflight|land|finish` (also run as `node .../cli-entry.js`):
 * it checks its arguments and preconditions first, then takes its own heavy slot for the build and
 * tests only. Wrapped in `nforge heavy`, a slot would be held through its queue wait, those checks and
 * any hosted wait, and a refusal comes only after the slot (friction 7c0ed580).
 */
export function slotsItself(args: string[]) {
  const at = /(^|[\\/])nforge(\.cmd|\.exe)?$/i.test(args[0] ?? '')
    ? 0
    : (basename(args[0] ?? '').replace(/\.exe$/i, '') === 'node' || args[0] === process.execPath) &&
        /(^|[\\/])cli-entry\.js$/.test(args[1] ?? '')
      ? 1
      : -1;
  return at >= 0 && args[at + 1] === 'agent' && ['preflight', 'land', 'finish'].includes(args[at + 3] ?? '');
}
/** An inherited holder is a scheduling lease, never source or user authority. */
export function inheritedHeavySlot(directory: string): string | null {
  try {
    const inherited = JSON.parse(process.env.FORGE_HEAVY_PARENT ?? 'null');
    if (
      !inherited ||
      inherited.directory !== canonicalRoot(directory) ||
      !/^[1-9][0-9]*$/.test(inherited.slot)
    )
      return null;
    const slot = join(directory, inherited.slot);
    const pid = Number(readFileSync(join(slot, 'pid'), 'utf8'));
    if (pid !== inherited.pid || !holderAlive(slot, pid, true)) return null;
    return slot;
  } catch {
    return null;
  }
}

const HEAVY_OPTION = /^--(no-build|cores|max-minutes)(?:=(.*))?$/;
/** nforge heavy CMD [ARGS...]: run one heavy local command under the machine-wide slot limit. */
export async function heavyCli(
  args: string[],
  beforeRun?: () => Promise<boolean>,
  beforeLocal?: () => Promise<void>,
): Promise<number> {
  // A bare `status` or `help` is heavy's own option, never a command to queue (593fc2d7); a program
  // of that name still runs after --.
  if (args.length === 1 && (args[0] === 'status' || args[0] === 'help'))
    args = [args[0] === 'status' ? '--status' : '--help'];
  let noBuild = false,
    cores: number | null = null,
    maxMinutes: number | null = null;
  // heavy's own options, in any order, before the command (or its --).
  for (let option; (option = HEAVY_OPTION.exec(args[0] ?? ''));) {
    const [, name, inline] = option;
    if (name === 'no-build') {
      invariant(inline === undefined, 'BAD_ARGUMENT', 'heavy --no-build takes no value.');
      noBuild = true;
      args = args.slice(1);
      continue;
    }
    const text = inline ?? args[1];
    const value = Number(text);
    args = args.slice(inline === undefined ? 2 : 1);
    if (name === 'cores') {
      invariant(
        text !== undefined && /^[1-9][0-9]*$/.test(text) && value <= availableParallelism(),
        'BAD_ARGUMENT',
        `heavy --cores takes a whole number from 1 to ${availableParallelism()} (this machine's cores).`,
      );
      cores = value;
    } else {
      invariant(
        text !== undefined && text.trim() !== '' && Number.isFinite(value) && value > 0 && value <= 1440,
        'BAD_ARGUMENT',
        'heavy --max-minutes takes minutes above 0, at most 1440.',
      );
      maxMinutes = value;
    }
  }
  // A leading -- ends heavy's own options, as in most CLIs; everything after it is the command.
  const endOfOptions = args[0] === '--';
  if (endOfOptions) {
    args = args.slice(1);
    invariant(
      args.length > 0,
      'BAD_ARGUMENT',
      'heavy -- needs a command after it: nforge heavy -- CMD [ARGS...].',
    );
  }
  if (!endOfOptions && (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]!)))) {
    await beforeLocal?.();
    process.stdout.write(HEAVY_HELP);
    return 0;
  }
  invariant(
    endOfOptions || !args[0]!.startsWith('-') || args[0] === '--status',
    'BAD_ARGUMENT',
    'Unknown heavy option. Run nforge heavy --help; use heavy CMD [ARGS...] for a bounded batch.',
  );
  invariant(
    endOfOptions || args[0] !== '--status' || args.length === 1,
    'BAD_ARGUMENT',
    'heavy --status takes no command. Run nforge heavy --status.',
  );
  invariant(
    !nodeTestWithoutPaths(args, process.cwd()),
    'BAD_ARGUMENT',
    'heavy: node --test received no test file paths, so Node would run the whole suite. Pass the selected files as separate arguments (zsh does not word-split a plain $VAR: use an array with "${files[@]}" or ${=VAR}), or run nforge heavy npm test for the full suite on purpose.',
  );
  // Before a slot, the build or any command: a test missing the project's preloads fails only in its
  // own process, after the work before it ran (friction dfb2a8d6). Refuse, never rewrite.
  const preloadProblem = preloadRefusal(args, process.cwd());
  invariant(!preloadProblem, 'BAD_ARGUMENT', preloadProblem ?? '');
  const slotLimit = () => heavySlots(readClientSettings().localHeavySlots);
  const slots = slotLimit();
  if (!endOfOptions && args[0] === '--status') {
    await beforeLocal?.();
    process.stdout.write(`${JSON.stringify(await heavyStatusReport(heavySlotDirectory(), slots))}\n`);
    return 0;
  }
  if (beforeRun && !(await beforeRun())) return Number(process.exitCode ?? 0);
  // Loaded before a slot is taken, so a failure here can never leave one held.
  const { commandKind, sampleHold, slotCapEnv, testWorkersPerSlot } = await loadHold();
  const machineBound = readClientSettings().localHeavyMaxMinutes;
  // A bound past the machine's is for long light work only: it must leave most of a slot's share free.
  invariant(
    maxMinutes === null ||
      machineBound === 0 ||
      maxMinutes <= machineBound ||
      (cores !== null && cores < testWorkersPerSlot(availableParallelism(), Math.max(1, slots))),
    'BAD_ARGUMENT',
    `heavy --max-minutes ${maxMinutes} is past localHeavyMaxMinutes (${machineBound}); that needs --cores below the slot share (${testWorkersPerSlot(availableParallelism(), Math.max(1, slots))}), as for a one-core model check.`,
  );
  const { stopLeftovers, stopProcessTree } = await loadStop();
  const inherited = inheritedHeavySlot(heavySlotDirectory());
  const queuedAt = Date.now();
  const ownSlot = slotsItself(args);
  if (ownSlot && slots !== 0 && !inherited)
    process.stderr.write(
      'heavy: nforge agent preflight/land take their own slot after their checks; running it without holding one.\n',
    );
  const slot =
    slots === 0 || inherited || ownSlot
      ? null
      : await acquireHeavySlot(
          heavySlotDirectory(),
          slotLimit,
          wait => process.stderr.write(waitingMessage(slotLimit(), heavySlotDirectory(), wait)),
          {
            command: args[0]!,
            cwd: process.cwd(),
            admission: await measuredHeavyAdmission(cores),
          },
        );
  const heldSince = Date.now();
  // Only the slot's own holder bounds the command; a nested command runs inside its parent's bound.
  const maxMs = slot ? Math.round((maxMinutes ?? machineBound) * 60_000) : 0;
  // One compiled-module cache for every test file this command runs (Item dceb1bef): helpers that
  // read FORGE_TEST_MODULE_DIRECTORY reuse content-addressed outputs instead of each file
  // recompiling. Created on first use; an inherited directory belongs to the command that set it.
  const moduleCache = process.env.FORGE_TEST_MODULE_DIRECTORY
    ? null
    : join(tmpdir(), `forge-test-modules-${process.pid}-${heldSince.toString(36)}`);
  // Every runner the command (and the core build before it) starts, at any depth, gets the slot's
  // core share (Item 7008ff18) when slots are enabled.
  // --cores N lowers that share to N for every capped runner, slots on or off (an outer, smaller
  // cap still wins), since the declaration is what earns a long bound.
  const capped = (name: string, limit: number) => {
    const outer = Number(process.env[name]);
    return String(Number.isSafeInteger(outer) && outer > 0 ? Math.min(outer, limit) : limit);
  };
  const cap = slotCapEnv(
    cores === null
      ? process.env
      : {
          ...process.env,
          FORGE_HEAVY_TEST_CONCURRENCY: capped('FORGE_HEAVY_TEST_CONCURRENCY', cores),
          GOMAXPROCS: capped('GOMAXPROCS', cores),
          RAYON_NUM_THREADS: capped('RAYON_NUM_THREADS', cores),
        },
    availableParallelism(),
    slot || inherited || cores !== null ? Math.max(1, slots) : 0,
    true,
  );
  const before = Object.keys(cap.env).map(name => [name, process.env[name]] as const);
  Object.assign(process.env, cap.env);
  let sampler: ReturnType<typeof sampleHold> | undefined;
  const release = () => {
    // A waiter may have freed this slot as overdue and another caller taken it: never remove theirs.
    if (slot) removeIfHolder(slot, process.pid);
    if (moduleCache) rmSync(moduleCache, { recursive: true, force: true, maxRetries: 3 });
    // An in-process caller keeps its own environment, never a removed preload.
    for (const [name, value] of before)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    cap.dispose();
  };
  process.once('exit', release);
  const writeHolder = () =>
    slot &&
    writeFileSync(
      join(slot, 'holder.json'),
      JSON.stringify({
        cwd: process.cwd(),
        startedAt: Date.now(),
        command: basename(args[0]!),
        maxMs,
        ...(cores === null ? {} : { cores }),
      }),
    );
  try {
    writeHolder();
    // Inside the slot, so builds stay bounded; a fresh dist/ costs one stat pass (friction 6288d0c2).
    if (needsCoreBuild(args) && !noBuild) {
      const built = await ensureCoreBuild(process.cwd());
      if (built !== 0) return built;
      // The bound runs from the command's start: a waiter's overdue clock restarts with it.
      writeHolder();
    }
    return await new Promise<number>((resolve, reject) => {
      const held = slot ?? inherited;
      // The outermost heavy runs its command in its own process group (Unix), so whatever it starts
      // stops with it (orphaned `tsc` children of a killed preflight ran 18 min outside heavy,
      // ff33e9a6); signals to heavy are forwarded below. A nested command stays in its parent's group,
      // which the parent stops as a whole. A command on a terminal keeps the terminal's session (a new
      // one could not open /dev/tty to prompt); Ctrl-C there reaches its whole group anyway.
      const group = !inherited && process.platform !== 'win32' && !isatty(0);
      const child = spawn(args[0]!, args.slice(1), {
        stdio: 'inherit',
        detached: group,
        env: {
          ...process.env,
          // Refuse wrapped `node --test` invocations that expand to zero paths (empty globs, vars,
          // npm scripts; friction 8e386100), while allowing explicit full-suite `npm test` (direct
          // or entered inside the command). If heavy itself was invoked from an outer `npm test`,
          // use 'strict' so an inherited npm_lifecycle_event='test' cannot bypass the guard.
          FORGE_HEAVY_REFUSE_EMPTY_TEST: isExplicitFullTestScript(args)
            ? ''
            : process.env.npm_lifecycle_event === 'test'
              ? 'strict'
              : '1',
          ...(moduleCache ? { FORGE_TEST_MODULE_DIRECTORY: moduleCache } : {}),
          FORGE_HEAVY_PARENT: held
            ? JSON.stringify({
                directory: canonicalRoot(heavySlotDirectory()),
                slot: basename(held),
                pid: Number(readFileSync(join(held, 'pid'), 'utf8')),
                // How long this command queued for its slot: a preflight refused for edits made
                // meanwhile says so (ad80e037). A nested heavy reuses the slot and adds no wait.
                ...(slot ? { waitedMs: heldSince - queuedAt } : {}),
              })
            : '',
        },
      });
      // A command that ignores the stop signal is killed after the grace, so the slot is freed
      // (a finished reviewer's hung test held one for 71 min, 593fc2d7).
      const grace = maxMs > 0 ? Math.min(HEAVY_KILL_GRACE_MS, Math.max(500, maxMs / 4)) : HEAVY_KILL_GRACE_MS;
      let kill: NodeJS.Timeout | undefined,
        timedOut = false;
      const stop = (signal: NodeJS.Signals) => {
        if (group) stopProcessTree(child, signal);
        else child.kill(signal);
        kill ??= setTimeout(() => (group ? stopProcessTree(child, 'SIGKILL') : child.kill('SIGKILL')), grace);
      };
      const bound =
        maxMs > 0
          ? setTimeout(() => {
              timedOut = true;
              process.stderr.write(
                `heavy: ${basename(args[0]!)} still running after ${minutes(maxMs)} (localHeavyMaxMinutes); stopping it to free its slot. For a longer command: nforge settings localHeavyMaxMinutes N (0 = no bound).\n`,
              );
              stop('SIGTERM');
            }, maxMs)
          : undefined;
      const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(
        signal => [signal, () => stop(signal)] as const,
      );
      for (const [signal, handler] of handlers) process.on(signal, handler);
      if (slot && child.pid) sampler = sampleHold(child.pid);
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        clearTimeout(bound);
        clearTimeout(kill);
        kill = undefined;
        const status = timedOut ? 124 : (code ?? 128 + (signal ? constants.signals[signal] : 0));
        // Signal handlers stay until the leftovers are gone: a Ctrl-C meanwhile still reaches them.
        const settle = () => {
          for (const [name, handler] of handlers) process.removeListener(name, handler);
          clearTimeout(kill);
        };
        if (!group) {
          settle();
          resolve(status);
          return;
        }
        stopLeftovers(child)
          .finally(settle)
          .then(() => resolve(status), reject);
      });
    });
  } finally {
    release();
    process.removeListener('exit', release);
    if (slot)
      recordHold(heavySlotDirectory(), Date.now() - heldSince, {
        at: heldSince,
        lane: laneOf(process.cwd()),
        kind: commandKind(args),
        wait: heldSince - queuedAt,
        ...(sampler?.stop() ?? {}),
      });
  }
}
