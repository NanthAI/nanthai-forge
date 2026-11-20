// SPDX-License-Identifier: Apache-2.0
import { canonicalRoot } from './root-paths.js';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, constants, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { heavySlots, readClientSettings } from './client-settings.js';
import { watchLocal, type LocalWatcher } from './local-watcher.js';
import { invariant } from './errors.js';
import { ensureCoreBuild } from './heavy-build.js';
import { preloadRefusal } from './heavy-test-preloads.js';
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
/** One attempt over all slots; a slot whose holder died, or ran far past its bound, is reclaimed. */
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
    // An overdue holder is not signalled: its process may still be someone's live work.
    const dead =
      Number.isSafeInteger(holder) && holder > 0
        ? !holderAlive(slot, holder, deep) || holderOverdue(slot)
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
    /** The process the slot is held for (default this one): preflight claims it through a child. */
    holder?: number;
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
  if (!queuedNames(directory).length) {
    const slot = tryHeavySlot(directory, count, holder);
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
          const slot = tryHeavySlot(directory, current(), holder, deep);
          if (slot) return finish(slot);
        }
        if (rank >= 0 && rank + 1 !== reported) {
          reported = rank + 1;
          const running = heavyStatus(directory, count).holders.map(holder => holder.elapsedMs);
          const estimate = estimateWaitMs(readHolds(directory), running, count, rank);
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

/** How long a stopped command may take to exit before heavy kills it. */
export const HEAVY_KILL_GRACE_MS = 10_000;
/** This process still holds the slot (a waiter may have freed it as overdue since). */
function ownsSlot(slot: string) {
  try {
    return readFileSync(join(slot, 'pid'), 'utf8') === String(process.pid);
  } catch {
    return false;
  }
}

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
nforge heavy --status | status
nforge heavy --help | -h | help
Run bounded builds and test batches under the machine-wide slot limit.
Nested commands reuse their live parent slot; project-declared static commands run directly.
--no-build runs tests against the existing dist/ without rebuilding it (failing-first checks).
Callers wait first come, first served; a waiting caller prints its queue position and an estimate.
--status lists the holders and the queue by Lane, command and time, never folders or arguments,
and sums the last day of holds (per kind, busiest Lanes, CPU and load peaks).
A command still running after localHeavyMaxMinutes (nforge settings; default 60, 0 = no bound) is
stopped (exit 124) and frees its slot; a signal to heavy reaches the command, which is killed if it
has not exited 10 s later. A holder that never stopped itself is freed 5 min past its bound, unsignalled.
Run long-lived servers (Vite/dev servers) directly, outside heavy.
node --test with no test file path is refused (Node would run the whole suite); name the files.
`;
/** Metadata contains only the executable basename, never arguments or environment. */
export function heavyStatus(directory: string, slots: number, cwd = process.cwd()) {
  const holders = [];
  for (let index = 1; index <= slots; index++) {
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
        lane: laneOf(folder),
        elapsedMs,
        command: typeof metadata.command === 'string' ? basename(metadata.command) : null,
        selfHeld: folder !== null && canonicalRoot(folder) === canonicalRoot(cwd),
        ...(maxMs > 0 && elapsedMs > maxMs ? { overBound: true } : {}),
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
/** heavy-hold loads only for a heavy command, never on the paths that only take a slot (the MCP
 * startup graph reaches this module); a sibling URL keeps the CLI bundle from splitting it. */
const loadHold = async () =>
  (await import(
    /* @vite-ignore */ new URL('./heavy-hold.js', import.meta.url).href
  )) as typeof import('./heavy-hold.js');
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
    `heavy: waiting for one of ${slots} machine-wide slots, first come, first served. Queue position ${wait.position} of ${wait.waiting}` +
    (wait.estimateMs === null
      ? '; no estimate yet (needs a few finished heavy commands on this machine)'
      : `; estimated wait about ${minutes(wait.estimateMs)} (median heavy command ${minutes(wait.medianMs ?? 0)}, last ${wait.samples})`) +
    `. Running: ${who || 'none seen'}. Run nforge heavy --status for the queue.\n`
  );
};

/** Node options whose value is the next argument (a bare value is not a test file). */
const NODE_VALUE_OPTIONS = new Set([
  '--import',
  '--require',
  '-r',
  '--loader',
  '--experimental-loader',
  '--conditions',
  '-C',
  '--env-file',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-concurrency',
  '--test-timeout',
  '--test-shard',
]);
/**
 * True when the command is `node ... --test` with no test path: Node would then discover and run the
 * whole suite. An empty or fully filtered list (an unquoted zsh variable never word-splits) must stop
 * here instead of silently falling through to that default glob (friction e4ce373a).
 */
export function nodeTestWithoutPaths(args: string[]) {
  const paths = nodeTestPathCount(args);
  return paths === 0;
}
/** Number of test paths of a `node ... --test` command, or null when the command is not one. */
export function nodeTestPathCount(args: string[]): number | null {
  const name = basename(args[0] ?? '').replace(/\.exe$/i, '');
  if (name !== 'node' && args[0] !== process.execPath) return null;
  let testing = false;
  let paths = 0;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      paths += args.slice(index + 1).filter(path => path.trim()).length;
      break;
    }
    if (arg.startsWith('-')) {
      if (arg === '--test') testing = true;
      else if (NODE_VALUE_OPTIONS.has(arg)) index++;
    } else if (arg.trim()) paths++;
  }
  return testing ? paths : null;
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

/** Only commands the project already declares static bypass the build/test queue. */
async function staticHeavyCommand(args: string[], cwd: string): Promise<boolean> {
  try {
    // This emitted core sibling loads only for heavy commands. A bundle split here would
    // also split the shared config code onto unrelated agent commands' startup paths.
    const { declaredPreflight, FORGE_CONFIG_FILE } = (await import(
      /* @vite-ignore */ new URL('./project-config.js', import.meta.url).href
    )) as typeof import('./project-config.js');
    const text = (name: string) => {
      try {
        return readFileSync(join(cwd, name), 'utf8');
      } catch {
        return undefined;
      }
    };
    const declared = declaredPreflight('static', text('package.json'), text(FORGE_CONFIG_FILE))?.value;
    if (!Array.isArray(declared)) return false;
    const entries: Array<{ script?: string; command?: string[] }> = declared;
    return entries.some(
      entry =>
        JSON.stringify(entry.command) === JSON.stringify(args) ||
        ((args.length === 3 || (args.length === 4 && ['-s', '--silent'].includes(args[2]!))) &&
          /^(?:npm|pnpm|yarn|bun)(?:\.cmd)?$/.test(basename(args[0]!)) &&
          args[1] === 'run' &&
          entry.script === args.at(-1)),
    );
  } catch {
    return false;
  }
}

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
  const noBuild = args[0] === '--no-build';
  if (noBuild) args = args.slice(1);
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
    !nodeTestWithoutPaths(args),
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
  const { commandKind, sampleHold, slotCapEnv } = await loadHold();
  const inherited = inheritedHeavySlot(heavySlotDirectory());
  const queuedAt = Date.now();
  const slot =
    slots === 0 || inherited || (await staticHeavyCommand(args, process.cwd()))
      ? null
      : await acquireHeavySlot(
          heavySlotDirectory(),
          slotLimit,
          wait => process.stderr.write(waitingMessage(slotLimit(), heavySlotDirectory(), wait)),
          { command: args[0]!, cwd: process.cwd() },
        );
  const heldSince = Date.now();
  // Only the slot's own holder bounds the command; a nested command runs inside its parent's bound.
  const maxMs = slot ? Math.round(readClientSettings().localHeavyMaxMinutes * 60_000) : 0;
  // One compiled-module cache for every test file this command runs (Item dceb1bef): helpers that
  // read FORGE_TEST_MODULE_DIRECTORY reuse content-addressed outputs instead of each file
  // recompiling. Created on first use; an inherited directory belongs to the command that set it.
  const moduleCache = process.env.FORGE_TEST_MODULE_DIRECTORY
    ? null
    : join(tmpdir(), `forge-test-modules-${process.pid}-${heldSince.toString(36)}`);
  // Every runner the command (and the core build before it) starts, at any depth, gets the slot's
  // core share (Item 7008ff18). A command outside any slot (static, slots off) is not capped.
  const cap = slotCapEnv(process.env, availableParallelism(), slot || inherited ? slots : 0);
  const before = Object.keys(cap.env).map(name => [name, process.env[name]] as const);
  Object.assign(process.env, cap.env);
  let sampler: ReturnType<typeof sampleHold> | undefined;
  const release = () => {
    // A waiter may have freed this slot as overdue and another caller taken it: never remove theirs.
    if (slot && ownsSlot(slot)) rmSync(slot, { recursive: true, force: true });
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
      JSON.stringify({ cwd: process.cwd(), startedAt: Date.now(), command: basename(args[0]!), maxMs }),
    );
  try {
    writeHolder();
    // Inside the slot, so builds stay bounded; a fresh dist/ costs one stat pass (friction 6288d0c2).
    if (nodeTestPathCount(args) && !noBuild) {
      const built = await ensureCoreBuild(process.cwd());
      if (built !== 0) return built;
      // The bound runs from the command's start: a waiter's overdue clock restarts with it.
      writeHolder();
    }
    return await new Promise<number>((resolve, reject) => {
      const held = slot ?? inherited;
      const child = spawn(args[0]!, args.slice(1), {
        stdio: 'inherit',
        env: {
          ...process.env,
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
        child.kill(signal);
        kill ??= setTimeout(() => child.kill('SIGKILL'), grace);
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
        for (const [name, handler] of handlers) process.removeListener(name, handler);
        clearTimeout(bound);
        clearTimeout(kill);
        resolve(timedOut ? 124 : (code ?? 128 + (signal ? constants.signals[signal] : 0)));
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
        ...(sampler?.stop() ?? {}),
      });
  }
}
