// SPDX-License-Identifier: Apache-2.0
import { autoDriverStalled } from './push-progress-state.js';
import { withExchangeProgress } from './exchange-progress.js';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch } from 'node:fs';
import { WorkStore } from './work-store.js';
import { effectivePolicy } from './autonomy-policy.js';
import { boundExchange } from './bound-exchange.js';
import { withQueueSlot } from './landing-queue.js';
import { readHostState, updateHostState } from './host-binding.js';
import { readPendingExchange, type PendingExchange } from './pending-exchange.js';
import { processIdentity } from './local-process.js';
import { observeSpend, type UsageAdapter, type UsageContext } from './auto-exchange-spend.js';
import { commandUsage, USAGE_CACHE_MS } from './auto-exchange-usage-command.js';
import type { AutoExchangeState } from './auto-exchange-state.js';
import { ForgeError } from './errors.js';
import { wakeAutoExchange } from './auto-exchange-wake.js';
import { openAutoExchangeNotifications } from './auto-exchange-notify.js';

/** Trailing quiet period, bounded by the oldest unprotected save. */
export function autoExchangeDue(queue: PendingExchange, debounceMs: number, maxPendingAgeMs: number) {
  if (!queue.pending.length) return null;
  return Math.min(
    Date.parse(queue.pending.at(-1)!.lastPendingAt) + debounceMs,
    Date.parse(queue.pending[0]!.firstPendingAt) + maxPendingAgeMs,
  );
}
function input(store: WorkStore) {
  const host = readHostState(store),
    binding = host.binding;
  const policy = effectivePolicy(store.readRecords()?.data() ?? store.load()).autoExchange!;
  const queue = readPendingExchange(store.directory);
  const retained = [host.push, ...(host.pendingPushes ?? [])].find(
    push => push?.projectId === binding?.projectId && push?.deployment === binding?.deployment,
  );
  return { host, binding, policy, queue, retained };
}
const pendingKey = (value: ReturnType<typeof input>) =>
  JSON.stringify([
    value.binding,
    value.policy,
    value.queue?.sequence,
    value.queue?.pending,
    value.retained?.operationId,
  ]);
/** Filesystem events only while pending. Rebinding/disable and new saves wake a
 * pending timer without idle polling or responding to our own bookkeeping. */
export function waitForPendingChange(
  store: WorkStore,
  ms: number,
  subscribe?: (listener: () => void) => () => void,
  expectedKey?: string,
) {
  const key = () => pendingKey(input(store));
  const before = expectedKey ?? key();
  return new Promise<'changed' | 'deadline'>((resolveWait, reject) => {
    const changed = () => {
      try {
        if (key() !== before) stop('changed');
      } catch {
        stop('changed');
      }
    };
    const unsubscribe = subscribe?.(changed);
    const watcher = watch(store.directory, (_event, filename) => {
      if (!['work.json', 'pending-exchange.json', 'hosted-binding.json'].includes(String(filename))) return;
      try {
        if (key() !== before) stop('changed');
      } catch {
        stop('changed');
      }
    });
    const timer = setTimeout(() => stop('deadline'), Math.min(ms, 2_147_483_647));
    function stop(reason: 'changed' | 'deadline') {
      clearTimeout(timer);
      watcher.close();
      unsubscribe?.();
      resolveWait(reason);
    }
    watcher.on('error', error => {
      clearTimeout(timer);
      watcher.close();
      unsubscribe?.();
      reject(error);
    });
    // Close the publication-before-watch race.
    if (key() !== before) stop('changed');
  });
}
export type AutoExchangeOptions = {
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  usage?: UsageAdapter;
  /** Test seam must honor the shared bound queue and invoke admission inside it. */
  push?: (admission: () => Promise<void>) => Promise<unknown>;
};
/** One owner driver. The existing bound queue also serializes manual overlap.
 * Pending operations are owned by boundExchange; never mint replacement IDs here. */
export async function drainAutoExchange(store: WorkStore, options: AutoExchangeOptions = {}) {
  const now = options.now ?? Date.now;
  let observed: string | undefined;
  const result = await withQueueSlot(
    join(store.directory, 'auto-exchange-queue'),
    async () => {
      const initial = input(store);
      observed = pendingKey(initial);
      if (
        !initial.binding ||
        !initial.policy.enabled ||
        initial.host.hosting ||
        (!initial.queue?.pending.length && !initial.retained)
      )
        return;
      const worker = processIdentity();
      const notifications = await openAutoExchangeNotifications();
      const controller = new AbortController();
      const unsubscribe = notifications.subscribe(() => {
        if (autoDriverStalled(readHostState(store), now()))
          controller.abort(
            new ForgeError(
              'AUTO_EXCHANGE_STALLED',
              'Stalled push yielded. Retry the retained operation after queue release.',
            ),
          );
      });
      let attempts = 0;
      let context: UsageContext | undefined;
      const update = (patch: Partial<AutoExchangeState>) =>
        updateHostState(store, host => {
          const binding = host.binding;
          if (
            !binding ||
            binding.projectId !== context?.projectId ||
            binding.deployment !== context.deployment
          )
            return;
          const previous = host.autoExchange;
          host.autoExchange = {
            ...(previous?.projectId === binding.projectId && previous.deployment === binding.deployment
              ? previous
              : {}),
            projectId: binding.projectId,
            deployment: binding.deployment,
            status: 'queued',
            ...patch,
            at: now(),
            worker,
            wakeEndpoint: notifications.endpoint,
          };
        });
      try {
        for (;;) {
          const selected = input(store),
            { binding, policy, queue, retained } = selected;
          observed = pendingKey(selected);
          if (!binding || !policy.enabled || selected.host.hosting || (!queue?.pending.length && !retained))
            return;
          context = binding;
          const old = selected.host.autoExchange;
          const sameBinding = old?.projectId === binding.projectId && old.deployment === binding.deployment;
          if (
            !retained &&
            sameBinding &&
            old.status === 'incomplete' &&
            old.handledSequence === queue?.sequence
          )
            return;
          const due = Math.max(
            retained ? now() : (autoExchangeDue(queue!, policy.debounceMs, policy.maxPendingAgeMs) ?? now()),
            sameBinding && (old.status !== 'paused' || policy.pauseOnDailySpend)
              ? (old.nextAttemptAt ?? 0)
              : 0,
          );
          if (due > now()) {
            update({
              status: sameBinding && old.status === 'paused' ? 'paused' : 'queued',
              nextAttemptAt: due,
            });
            if (options.sleep) await options.sleep(due - now());
            else
              await waitForPendingChange(store, due - now(), notifications.subscribe, pendingKey(selected));
            continue;
          }
          const admission = async () => {
            // Re-read after manual push queueing: disable/rebind/pause cannot start
            // a fresh automatic attempt based on the old pre-wait observation.
            const current = input(store);
            if (
              !current.policy.enabled ||
              current.host.hosting ||
              current.binding?.projectId !== binding.projectId ||
              current.binding.deployment !== binding.deployment ||
              (!current.queue?.pending.length && !current.retained)
            )
              throw new ForgeError('AUTO_EXCHANGE_CHANGED', 'Automatic exchange selection changed.');
            if (current.policy.pauseOnDailySpend) {
              const samples = sameBinding ? (current.host.autoExchange?.samples ?? []) : [];
              const checked = current.host.autoExchange?.spendCheck;
              const cached =
                !options.usage &&
                checked?.command === current.binding.spendCommand &&
                checked &&
                checked.at <= now() &&
                now() - checked.at < USAGE_CACHE_MS &&
                current.host.autoExchange?.spend?.availability === 'measured' &&
                samples.at(-1);
              const observation = await observeSpend(
                binding,
                samples,
                now,
                options.usage ?? (cached ? async () => cached : commandUsage(current.binding.spendCommand)),
              );
              const fresh = input(store);
              if (
                !fresh.policy.enabled ||
                fresh.binding?.projectId !== binding.projectId ||
                fresh.binding.deployment !== binding.deployment ||
                fresh.binding.spendCommand !== current.binding.spendCommand
              )
                throw new ForgeError('AUTO_EXCHANGE_CHANGED', 'Automatic exchange selection changed.');
              update({
                ...observation,
                spendCheck:
                  !options.usage && current.binding.spendCommand
                    ? { command: current.binding.spendCommand, at: cached ? checked!.at : now() }
                    : undefined,
              });
              if (fresh.policy.pauseOnDailySpend && observation.spend.availability !== 'measured') {
                update({
                  status: 'paused',
                  code: 'AUTO_EXCHANGE_SPEND_UNAVAILABLE',
                  nextAttemptAt: undefined,
                });
                throw new ForgeError(
                  'AUTO_EXCHANGE_SPEND_UNAVAILABLE',
                  'Automatic push deferred: spend cannot be observed.',
                );
              }
              if (fresh.policy.pauseOnDailySpend && observation.spend.paused) {
                update({ status: 'paused', code: undefined, nextAttemptAt: observation.spend.resumeAt! });
                throw new ForgeError(
                  'AUTO_EXCHANGE_PAUSED',
                  'Automatic pushes paused by observed daily spend.',
                );
              }
            }
            update({
              status: 'pushing',
              nextAttemptAt: undefined,
              code: undefined,
              ...(current.retained ? { operationId: current.retained.operationId } : {}),
            });
          };
          try {
            const pushed = (await withExchangeProgress({ signal: controller.signal }, async () =>
              options.push
                ? await options.push(admission)
                : await boundExchange(store.root, 'push', undefined, false, {
                    beforePush: admission,
                    expectedBinding: binding,
                  }),
            )) as
              | { operationId?: string; pendingCoverage?: { capture: { throughSequence: number } } }
              | undefined;
            attempts = 0;
            const after = input(store);
            if (
              after.binding?.projectId !== binding.projectId ||
              after.binding.deployment !== binding.deployment
            )
              continue;
            // Missing evidence/incomplete history stays visible without uploading
            // the identical capture repeatedly. A new save or manual push can retry.
            const capturedThrough = pushed?.pendingCoverage?.capture.throughSequence ?? queue?.sequence;
            const incomplete = after.queue?.pending.some(
              batch => batch.throughSequence <= (capturedThrough ?? 0),
            );
            update({
              status: incomplete ? 'incomplete' : 'pushed',
              handledSequence: capturedThrough,
              operationId: pushed?.operationId,
              nextAttemptAt: undefined,
              code: undefined,
            });
          } catch (error) {
            if (controller.signal.aborted) return;
            const code = error instanceof ForgeError ? error.code : 'HOSTED_ACTION_FAILED';
            if (code === 'AUTO_EXCHANGE_SPEND_UNAVAILABLE') return;
            if (code === 'AUTO_EXCHANGE_CHANGED' || code === 'AUTO_EXCHANGE_PAUSED') continue;
            const pending = input(store).retained;
            const transient = [
              'WORK_BUSY',
              'WORK_STALE',
              'PROJECT_CHANGED',
              'EXCHANGE_REQUEST_FAILED',
              'EXCHANGE_REQUEST_TIMEOUT',
              'EXCHANGE_UPLOAD_UNKNOWN',
              'HOSTED_ACTION_FAILED',
            ].includes(code);
            update({
              status: transient ? 'retrying' : 'failed',
              code,
              operationId: pending?.operationId,
              nextAttemptAt: transient
                ? now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts++, 6))
                : undefined,
            });
            if (!transient) return;
          }
        }
      } finally {
        unsubscribe();
        try {
          updateHostState(store, host => {
            if (
              host.autoExchange?.worker?.pid === worker.pid &&
              host.autoExchange.worker.startTime === worker.startTime
            ) {
              delete host.autoExchange.worker;
              delete host.autoExchange.wakeEndpoint;
            }
          });
        } finally {
          await notifications.close();
        }
      }
    },
    {
      anchor: store.directory,
      waitMs: autoDriverStalled(readHostState(store), now()) ? 5000 : 0,
      phase: 'automatic hosted push',
    },
  );
  const state = readHostState(store).autoExchange;
  if (
    !options.push &&
    ((observed && pendingKey(input(store)) !== observed) ||
      (state && ['pushed', 'incomplete'].includes(state.status)))
  )
    wakeAutoExchange(store, true);
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  drainAutoExchange(new WorkStore(process.argv[2]!)).catch(() => {
    process.exitCode = 1;
  });
}
