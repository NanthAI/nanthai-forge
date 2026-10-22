// SPDX-License-Identifier: Apache-2.0
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import { WorkStore } from './work-store.js';
import { waitObservation } from './agent-wait-observation.js';
import type { WaitEvent } from './agent-wait-run.js';
export type { WaitEvent } from './agent-wait-run.js';

export const agentWaitSchema = z.object({
  laneIds: z.array(z.uuid()).default([]),
  operationIds: z.array(z.uuid()).default([]),
  until: z.enum(['terminal', 'any-change']).default('terminal'),
  timeoutSeconds: z.number().nonnegative().finite().default(600),
});
export type WaitSummary = {
  type: 'summary';
  status: 'terminal' | 'changed' | 'timeout' | 'cancelled';
  ok: boolean;
  exitCode: number;
  successful: boolean;
  targets: WaitEvent[];
};

/** Subscribe before the first read. A generation counter closes read-to-sleep races.
 * Only local missed-notification/dead-process fallback runs on the two-second timer. */
class WaitSignals {
  private watchers = new Map<string, FSWatcher>();
  private wake: (() => void) | undefined;
  generation = 0;
  private changed = () => {
    this.generation++;
    this.wake?.();
  };
  add(path: string) {
    if (this.watchers.has(path)) return;
    try {
      const watcher = watch(path, this.changed);
      watcher.on('error', () => {
        watcher.close();
        this.watchers.delete(path);
        this.changed();
      });
      this.watchers.set(path, watcher);
    } catch (error) {
      if (
        !['ENOENT', 'ENOSYS', 'ENOTSUP', 'EPERM', 'ENOSPC', 'EMFILE'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
      // Newly created directories and platforms without watch support use the local fallback.
    }
  }
  async next(generation: number, timeout: number, signal?: AbortSignal) {
    if (generation !== this.generation || signal?.aborted) return;
    await new Promise<void>(resolve => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, Math.min(2000, timeout));
      this.wake = done;
      signal?.addEventListener('abort', done, { once: true });
    });
  }
  close() {
    for (const watcher of this.watchers.values()) watcher.close();
  }
}

export async function agentWait(
  store: WorkStore,
  input: unknown,
  emit: (event: WaitEvent | WaitSummary) => void = () => {},
  signal?: AbortSignal,
): Promise<WaitSummary> {
  const parsed = agentWaitSchema.safeParse(input);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    'Use Lane/operation UUID arrays, terminal or any-change, and a finite nonnegative timeoutSeconds.',
  );
  const command = parsed.data;
  const targets: { kind: 'lane' | 'operation'; id: string }[] = [...new Set(command.laneIds)].map(id => ({
    kind: 'lane',
    id,
  }));
  targets.push(...[...new Set(command.operationIds)].map(id => ({ kind: 'operation' as const, id })));
  invariant(targets.length, 'BAD_ARGUMENT', 'Choose at least one Lane or operation to wait on.');
  const end = performance.now() + command.timeoutSeconds * 1000,
    signals = new WaitSignals();
  const seen = new Map<string, string>(),
    settled = new Set<string>(),
    current = new Map<string, WaitEvent>();
  for (const target of targets)
    current.set(`${target.kind}:${target.id}`, {
      type: target.kind,
      id: target.id,
      status: 'unknown',
      terminal: false,
      ok: false,
    });
  let baseline = true;
  const publish = (event: WaitEvent) => {
    const key = `${event.type}:${event.id}`,
      bytes = JSON.stringify(event);
    if (settled.has(key) || seen.get(key) === bytes) return false;
    seen.set(key, bytes);
    if (event.terminal) settled.add(key);
    emit(event);
    return true;
  };
  const summary = (status: WaitSummary['status']) => {
    const values = [...current.values()],
      ok = status === 'changed' || status === 'terminal';
    const result: WaitSummary = {
      type: 'summary',
      status,
      ok,
      exitCode: ok ? 0 : status === 'timeout' ? 2 : status === 'cancelled' ? 130 : 1,
      successful: values.length === targets.length && values.every(value => value.terminal && value.ok),
      targets: values,
    };
    emit(result);
    return result;
  };
  try {
    signals.add(store.directory);
    for (;;) {
      const generation = signals.generation;
      for (const name of ['agent-finish', 'agent-land', 'coordination'])
        signals.add(join(store.directory, name));
      let changed = false;
      for (const target of targets) {
        const key = `${target.kind}:${target.id}`;
        if (current.get(key)?.terminal) continue;
        let observed: ReturnType<typeof waitObservation>;
        try {
          observed = waitObservation(store, target.kind, target.id);
        } catch (error) {
          if (error instanceof ForgeError && error.code === 'SOURCE_CHANGED') continue;
          throw error;
        }
        for (const runId of observed.runIds) signals.add(join(store.directory, `check-${runId}`));
        // Read once more if a just-created run directory changed before its watch attached.
        if (observed.runIds.length) {
          const refreshed = waitObservation(store, target.kind, target.id);
          observed.events = refreshed.events;
          observed.target = refreshed.target;
        }
        for (const event of [...observed.events, observed.target]) changed = publish(event) || changed;
        current.set(key, observed.target);
      }
      if (current.size === targets.length && [...current.values()].every(value => value.terminal))
        return summary('terminal');
      if (!baseline && changed && command.until === 'any-change') return summary('changed');
      baseline = false;
      if (signal?.aborted) return summary('cancelled');
      if (performance.now() >= end) return summary('timeout');
      await signals.next(generation, end - performance.now(), signal);
    }
  } finally {
    signals.close();
  }
}
export function waitText(event: WaitEvent | WaitSummary): string {
  if (event.type === 'summary')
    return `wait ${event.status}${event.ok ? '' : ' (incomplete or unsuccessful)'}: ${JSON.stringify(event.targets)}`;
  return `${event.type} ${event.id}: ${event.status}${event.failureClass ? ` (${event.failureClass})` : ''}${event.reason ? ` — ${event.reason}` : ''}${event.logPath ? `; log: ${event.logPath}` : ''}${Array.isArray(event.failingShardLogPaths) && event.failingShardLogPaths.length ? `; failing shards: ${event.failingShardLogPaths.join(', ')}` : ''}`
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r');
}
export async function agentWaitCli(root: string, input: unknown, text: boolean) {
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await agentWait(
      new WorkStore(root),
      input,
      event => process.stdout.write(`${text ? waitText(event) : JSON.stringify(event)}\n`),
      controller.signal,
    );
    process.exitCode = result.exitCode;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
