// SPDX-License-Identifier: Apache-2.0
import { basename, dirname } from 'node:path';
import { ForgeError } from './errors.js';
import { appendSelfMetric } from './self-metrics-journal.js';

const phases = ['slotWait', 'cacheVerify', 'copyHash', 'durability', 'index', 'publish'] as const;
export type CheckoutOpenMeasurement = {
  phasesMs: Record<(typeof phases)[number], number>;
  totalMs: number;
  laneId: string;
  files: number;
  replayed: boolean;
  maxRssKiB: number;
  ioBudget: { volumeWorkers: number; localWorkers: number } | null;
  outcome: 'completed' | 'failed';
};
/** One bounded receipt in the existing operation journal, including failed opens.
 * Only local monotonic clocks and process counters; never sends metrics to Convex. */
export async function withCheckoutOpenMetrics<T>(
  root: string,
  request: { operationId: string; laneId: string },
  run: (metrics: CheckoutOpenMetrics) => Promise<T>,
): Promise<T> {
  const metrics = new CheckoutOpenMetrics(),
    start = performance.now();
  let outcome: CheckoutOpenMeasurement['outcome'] = 'failed',
    errorCode: string | undefined;
  try {
    const result = await run(metrics);
    outcome = 'completed';
    return result;
  } catch (error) {
    errorCode = error instanceof ForgeError ? error.code : 'INTERNAL_ERROR';
    throw error;
  } finally {
    appendSelfMetric(
      dirname(root),
      {
        schema: 1,
        kind: 'checkout',
        action: 'open',
        operationId: request.operationId,
        actor: { kind: 'system', name: 'Lane checkout' },
        origin: 'command',
        at: new Date().toISOString(),
        ...(errorCode ? { errorCode } : {}),
        checkout: {
          laneId: request.laneId,
          phasesMs: metrics.phasesMs,
          totalMs: performance.now() - start,
          files: metrics.files,
          replayed: metrics.replayed,
          maxRssKiB: process.resourceUsage().maxRSS,
          ioBudget: metrics.ioBudget,
          outcome,
        },
      },
      `${basename(root)}.forge-metrics.jsonl`,
    );
  }
}
export class CheckoutOpenMetrics {
  readonly phasesMs = Object.fromEntries(
    phases.map(phase => [phase, 0]),
  ) as CheckoutOpenMeasurement['phasesMs'];
  ioBudget: CheckoutOpenMeasurement['ioBudget'] = null;
  files = 0;
  replayed = false;
  async measure<T>(phase: keyof CheckoutOpenMeasurement['phasesMs'], run: () => Promise<T>): Promise<T> {
    const start = performance.now(),
      waiting = this.phasesMs.slotWait;
    try {
      return await run();
    } finally {
      this.phasesMs[phase] += Math.max(0, performance.now() - start - (this.phasesMs.slotWait - waiting));
    }
  }
  measureSync<T>(phase: keyof CheckoutOpenMeasurement['phasesMs'], run: () => T): T {
    const start = performance.now();
    try {
      return run();
    } finally {
      this.phasesMs[phase] += performance.now() - start;
    }
  }
}
