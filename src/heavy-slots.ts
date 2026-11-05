import { canonicalRoot } from './root-paths.js';
// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { heavySlots, readClientSettings } from './client-settings.js';
import { watchLocal } from './local-watcher.js';
import { invariant } from './errors.js';

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
/** One attempt over all slots; a slot whose holder died is reclaimed. */
export function tryHeavySlot(directory: string, slots: number, pid = process.pid): string | null {
  mkdirSync(directory, { recursive: true });
  for (let index = 1; index <= slots; index++) {
    const slot = join(directory, String(index));
    try {
      mkdirSync(slot);
      writeFileSync(join(slot, 'pid'), String(pid));
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
      Number.isSafeInteger(holder) && holder > 0 ? !alive(holder) : Date.now() - claimedAt > 60_000;
    if (dead) {
      rmSync(slot, { recursive: true, force: true });
      index--;
    }
  }
  return null;
}
/** Wait for a free slot: wake on a slot release, re-check stale holders every 30 s while waiting. */
export async function acquireHeavySlot(
  directory: string,
  slots: number,
  onWait: () => void = () => {},
): Promise<string> {
  let slot = tryHeavySlot(directory, slots);
  if (slot) return slot;
  onWait();
  while (!(slot ??= tryHeavySlot(directory, slots)))
    await new Promise<void>(resolve => {
      let finished = false;
      const watcher = watchLocal(
        directory,
        {
          onReady: () =>
            queueMicrotask(() => {
              // Attachment is asynchronous: a release before open need not replay.
              if (!finished && (slot = tryHeavySlot(directory, slots))) done();
            }),
        },
        () => done(),
      );
      const timer = setTimeout(() => done(), 30_000);
      function done() {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        void watcher.close();
        resolve();
      }
    });
  return slot;
}

export const HEAVY_HELP = `nforge heavy CMD [ARGS...]
nforge heavy --status
nforge heavy --help | -h
Run bounded builds and test batches under the machine-wide slot limit.
Run long-lived servers (Vite/dev servers) directly, outside heavy.
`;
/** Metadata contains only the executable basename, never arguments or environment. */
export function heavyStatus(directory: string, slots: number, cwd = process.cwd()) {
  const holders = [];
  for (let index = 1; index <= slots; index++) {
    const slot = join(directory, String(index));
    try {
      const pid = Number(readFileSync(join(slot, 'pid'), 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0 || !alive(pid)) continue;
      let metadata: { cwd?: string; startedAt?: number; command?: string } = {};
      try {
        metadata = JSON.parse(readFileSync(join(slot, 'holder.json'), 'utf8'));
      } catch {}
      const folder = typeof metadata.cwd === 'string' ? metadata.cwd : null;
      holders.push({
        slot: index,
        pid,
        folder,
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
  return { slots, holders, selfHeld: holders.some(holder => holder.selfHeld) };
}

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
      : await acquireHeavySlot(heavySlotDirectory(), slots, () =>
          process.stderr.write(
            `heavy: all ${slots} local slots busy; waiting. ${JSON.stringify(heavyStatus(heavySlotDirectory(), slots))} Run nforge heavy --status to inspect holders.\n`,
          ),
        );
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
  }
}
