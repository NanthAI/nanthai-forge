// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { AutoExchangeState } from './auto-exchange-state.js';
/** Longer than one long-action attempt; heartbeats never renew this observation. */
export const PUSH_STALL_MS = 11 * 60_000;
export const PUSH_STALL_RESUME =
  'Push stalled. Retry on the next owner save/startup or run nforge exchange ROOT push. Recovery reuses the retained operation after the previous driver releases its queue slots.';
export const pushProgressSchema = z.object({
  projectId: z.string(),
  deployment: z.string(),
  operationId: z.string().optional(),
  worker: z.object({ pid: z.number(), startTime: z.string() }),
  phase: z.string(),
  lastProgressAt: z.number(),
});
export const pushStalled = (progress: z.infer<typeof pushProgressSchema> | undefined, now = Date.now()) =>
  !!progress && now - progress.lastProgressAt >= PUSH_STALL_MS;

/** Legacy drivers have only their pushing timestamp. Never confuse a manual
 * push's progress with the automatic driver's process identity. */
export function autoDriverStalled(
  host: {
    autoExchange?: AutoExchangeState | undefined;
    pushProgress?: z.infer<typeof pushProgressSchema> | undefined;
  },
  now = Date.now(),
) {
  const auto = host.autoExchange,
    progress = host.pushProgress;
  if (auto?.status !== 'pushing') return false;
  const owned =
    progress &&
    progress.worker.pid === auto.worker?.pid &&
    progress.worker.startTime === auto.worker.startTime;
  return now - (owned ? progress.lastProgressAt : auto.at) >= PUSH_STALL_MS;
}
