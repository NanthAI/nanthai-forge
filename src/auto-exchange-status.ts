// SPDX-License-Identifier: Apache-2.0
import { effectivePolicy } from './autonomy-policy.js';
import { readHostState } from './host-binding.js';
import { readPendingExchange } from './pending-exchange.js';
import { AUTO_EXCHANGE_RESUME, AUTO_EXCHANGE_UNDO } from './auto-exchange-state.js';
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
  const status = !policy.enabled
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
    operationId: state?.operationId ?? null,
    nextAttemptAt: state?.nextAttemptAt ?? null,
    code: state?.code ?? null,
    spend: state?.spend ?? {
      availability: 'unknown',
      deltaUsd: null,
      paused: false,
      reason: 'unconfigured',
      resumeAt: null,
    },
    transport: host.exchangeObservation ?? null,
    resume: AUTO_EXCHANGE_RESUME,
    undo: AUTO_EXCHANGE_UNDO,
  };
}
export type AutoExchangeStatus = ReturnType<typeof readAutoExchangeStatus>;
