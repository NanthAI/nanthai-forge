// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { heavySlots, readClientSettings } from './client-settings.js';
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
  while (!(slot = tryHeavySlot(directory, slots)))
    await new Promise<void>(resolve => {
      const watcher = watch(directory, () => done());
      const timer = setTimeout(() => done(), 30_000);
      function done() {
        clearTimeout(timer);
        watcher.close();
        resolve();
      }
    });
  return slot;
}

/** nforge heavy CMD [ARGS...]: run one heavy local command under the machine-wide slot limit. */
export async function heavyCli(args: string[]): Promise<number> {
  invariant(args.length > 0, 'BAD_ARGUMENT', 'Use heavy CMD [ARGS...].');
  const slots = heavySlots(readClientSettings().localHeavySlots);
  const slot =
    slots === 0
      ? null
      : await acquireHeavySlot(heavySlotDirectory(), slots, () =>
          process.stderr.write(`heavy: all ${slots} local slots busy; waiting\n`),
        );
  const release = () => {
    if (slot) rmSync(slot, { recursive: true, force: true });
  };
  process.once('exit', release);
  try {
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
