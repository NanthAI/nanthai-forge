// SPDX-License-Identifier: Apache-2.0
import { basename, dirname } from 'node:path';
import { ForgeError } from './errors.js';
import { waitEventLine } from './hosted-wait-line.js';
import { canonicalRoot, rootSibling } from './root-paths.js';
import { appendSelfMetric } from './self-metrics-journal.js';

export type LandWaitMeasurement = {
  phase: 'start' | 'end';
  waitingFor: 'acceptance' | 'run';
  budgetMs: number;
  durationMs?: number;
  /** The wait's own result status: terminal, timeout, cancelled, or failed when it threw. */
  status?: string;
  /** Observation events received, and transport retries among them. */
  events?: number;
  retries?: number;
  /** Time since the last event that changed what the agent sees (phase, state, queue, outcome). */
  sinceChangeMs?: number;
  /** The last server state seen: the compact wait line (phase, state, reason, version, queue). */
  last?: Record<string, unknown> | null;
};

/**
 * The land command's own wait, as two local receipts in the existing operation journal (Issue 4f60d57a).
 * The start receipt is written before the wait begins, so a client that is killed while waiting still
 * leaves a record that names the phase. The end receipt names the last server state it saw and how long
 * nothing changed. Local clocks and file appends only: no network call, timer or reader.
 */
export async function withLandWaitMetrics<T>(
  root: string,
  request: { operationId: string; waitingFor: LandWaitMeasurement['waitingFor']; budgetSeconds: number },
  emit: (event: unknown) => void,
  run: (emit: (event: unknown) => void) => Promise<T>,
): Promise<T> {
  root = canonicalRoot(root);
  const start = performance.now(),
    budgetMs = Math.round(request.budgetSeconds * 1000);
  let events = 0,
    retries = 0,
    changedAt = start,
    lastKey = '',
    last: Record<string, unknown> | null = null,
    status = 'failed',
    errorCode: string | undefined;
  const record = (wait: LandWaitMeasurement) =>
    appendSelfMetric(
      dirname(root),
      {
        schema: 1,
        kind: 'wait',
        action: 'land',
        operationId: request.operationId,
        actor: { kind: 'system', name: 'Land wait' },
        origin: 'command',
        at: new Date().toISOString(),
        ...(errorCode ? { errorCode } : {}),
        wait,
      },
      basename(rootSibling(root, '.forge-metrics.jsonl')),
    );
  record({ phase: 'start', waitingFor: request.waitingFor, budgetMs });
  try {
    const result = await run(event => {
      events++;
      if ((event as { type?: string }).type === 'observation-retry') retries++;
      else {
        const compact = waitEventLine(event);
        if (compact && compact.key !== lastKey) {
          lastKey = compact.key;
          last = compact.line;
          changedAt = performance.now();
        }
      }
      emit(event);
    });
    status = String((result as { result?: { status?: unknown } } | undefined)?.result?.status ?? 'none');
    return result;
  } catch (error) {
    errorCode = error instanceof ForgeError ? error.code : 'INTERNAL_ERROR';
    throw error;
  } finally {
    const now = performance.now();
    record({
      phase: 'end',
      waitingFor: request.waitingFor,
      budgetMs,
      durationMs: Math.round(now - start),
      status,
      events,
      retries,
      sinceChangeMs: Math.round(now - changedAt),
      last,
    });
  }
}
