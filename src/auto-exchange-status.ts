// SPDX-License-Identifier: Apache-2.0
import { autoDriverStalled, pushStalled, PUSH_STALL_MS, PUSH_STALL_RESUME } from './push-progress-state.js';
import { effectivePolicy } from './autonomy-policy.js';
import { readHostState } from './host-binding.js';
import { readPendingExchange } from './pending-exchange.js';
import { AUTO_EXCHANGE_RESUME, AUTO_EXCHANGE_UNDO } from './auto-exchange-state.js';
import { SPEND_WINDOW_MS } from './auto-exchange-spend.js';
import type { WorkStore } from './work-store.js';

/** Local observations only; no usage reads, transport, export or Work mutation. */
export function readAutoExchangeStatus(store: WorkStore, now = Date.now()) {
  const host = readHostState(store),
    binding = host.binding;
  const policy = effectivePolicy(store.readRecords()?.data() ?? store.load()).autoExchange!;
  const queue = readPendingExchange(store.directory);
  const selected = host.autoExchange;
  const state =
    binding && selected?.projectId === binding.projectId && selected.deployment === binding.deployment
      ? selected
      : undefined;
  const retained = [host.push, ...(host.pendingPushes ?? [])].some(
    push => push?.projectId === binding?.projectId && push?.deployment === binding?.deployment,
  );
  const pending = !!queue?.pending.length || retained;
  const progress =
    binding &&
    host.pushProgress?.projectId === binding.projectId &&
    host.pushProgress.deployment === binding.deployment
      ? host.pushProgress
      : undefined;
  const stalled =
    pending && (pushStalled(progress, now) || (autoDriverStalled({ autoExchange: state }, now) && !progress));
  const status = stalled
    ? 'stalled'
    : progress
      ? 'pushing'
      : !policy.enabled
        ? 'disabled'
        : !binding
          ? 'unbound'
          : !queue && !retained
            ? 'unknown'
            : !pending
              ? 'idle'
              : state?.status === 'pushed' || !state
                ? 'queued'
                : state.status;
  const spend = state?.spend
    ? { ...state.spend }
    : {
        availability: 'unknown' as const,
        deltaUsd: null,
        paused: false,
        reason: binding?.spendCommand ? ('unavailable' as const) : ('unconfigured' as const),
        resumeAt: null,
      };
  if ('observedAt' in spend && spend.observedAt !== null && spend.observedAt <= now - SPEND_WINDOW_MS) {
    spend.availability = 'unknown';
    spend.deltaUsd = null;
    if ('measuredTotalUsd' in spend) spend.measuredTotalUsd = null;
    if ('estimatedTotalUsd' in spend) spend.estimatedTotalUsd = null;
    spend.reason = 'stale';
    spend.paused = false;
  }
  const resume =
    policy.pauseOnDailySpend && spend.availability !== 'measured'
      ? `Automatic pushes deferred: spend ${spend.reason}. ${
          spend.reason === 'unconfigured'
            ? 'Configure nforge host ROOT --spend-command /absolute/owner-owned/executable.'
            : 'Fix the owner spend command to return a fresh measured observation for this project and deployment.'
        } Retry on the next owner save/startup or by setting --spend-command again. Manual exchange push remains available.`
      : AUTO_EXCHANGE_RESUME;
  return {
    enabled: policy.enabled,
    status,
    debounceMs: policy.debounceMs,
    maxPendingAgeMs: policy.maxPendingAgeMs,
    pauseOnDailySpend: policy.pauseOnDailySpend ?? false,
    pendingSince: queue?.pending[0]?.firstPendingAt ?? null,
    pendingAgeMs: queue?.pending.length
      ? Math.max(0, now - Date.parse(queue.pending[0]!.firstPendingAt))
      : queue
        ? 0
        : null,
    phase: progress?.phase ?? null,
    lastProgressAt: progress?.lastProgressAt ?? (state?.status === 'pushing' ? state.at : null),
    stalledAfterMs: PUSH_STALL_MS,
    operationId: progress?.operationId ?? state?.operationId ?? null,
    nextAttemptAt: state?.nextAttemptAt ?? null,
    code: state?.code ?? null,
    spend,
    transport: host.exchangeObservation ?? null,
    resume: stalled ? PUSH_STALL_RESUME : resume,
    undo: AUTO_EXCHANGE_UNDO,
  };
}
export type AutoExchangeStatus = ReturnType<typeof readAutoExchangeStatus>;
