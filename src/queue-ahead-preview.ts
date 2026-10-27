import { finishChild } from './finish-child.js';
// SPDX-License-Identifier: Apache-2.0
/** Advisory work window only; never limits admission or changes queue order. */
export const QUEUE_AHEAD_LIMIT = 8;
export type QueueAheadEntry = {
  id: string;
  head: string;
  lanes: string[];
  status: string;
};
export type QueueAheadConflict = {
  entryId: string;
  laneIds: string[];
  head: string;
  confidence: 'actionable' | 'fyi';
  paths: string[];
  text: string;
  next?: {
    action: 'start';
    operationId: string;
    stackOn: string;
    stackEntry: string;
    outcome: string;
    shell: string;
  };
};
export type QueueAheadPreview = {
  main: string | null;
  considered: number;
  more: boolean;
  conflicts: QueueAheadConflict[];
  unavailable: string[];
  cost: {
    composeCalls: number;
    cacheHits: number;
    durationMs: number;
    maxComposeCalls: number;
    objectResolutions?: number;
  };
};
export type QueueAheadSource = {
  compose(left: string, right: string, message: string, at: string): { head?: string; conflicts: string[] };
};
export type QueueAheadCache = {
  read<T>(key: string): T | undefined;
  write(key: string, value: unknown): void;
};
export const queueAheadPending = (status: string) => ['queued', 'checking', 'ready'].includes(status);
export const queueAheadKey = (main: string, mine: string, peer: string) =>
  `queue-ahead-v1:${main}:${mine}:${peer}`;
/** The ordinary source reducer supplies both merges. No check or project code runs.
 * A peer conflicting with main cannot establish what would happen if it landed. */
export function composeQueueAhead(source: QueueAheadSource, main: string, mine: string, peer: string) {
  const projected = source.compose(main, peer, 'Queue-ahead preview', '');
  if (!projected.head) return { paths: [] as string[], unavailable: true, composeCalls: 1 };
  const merged = source.compose(projected.head, mine, 'Queue-ahead preview', '');
  return { paths: merged.conflicts, unavailable: false, composeCalls: 2 };
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
export function queueAheadAdvice(
  root: string,
  entry: QueueAheadEntry,
  paths: string[],
  mine = '',
): QueueAheadConflict {
  const confidence = entry.status === 'queued' ? 'fyi' : 'actionable';
  const parent = entry.lanes[0];
  const command = parent
    ? {
        action: 'start' as const,
        operationId: finishChild(entry.id, `queue-ahead-stack:${mine}`),
        stackOn: parent,
        stackEntry: entry.id,
        outcome: `Resolve queue-ahead overlap with ${entry.id}`,
      }
    : undefined;
  return {
    entryId: entry.id,
    laneIds: entry.lanes,
    head: entry.head,
    confidence,
    paths,
    text: `if entry ${entry.id}${parent ? ` / Lane ${parent}` : ''} lands, ${paths.join(', ')} conflict`,
    ...(confidence === 'actionable' && command
      ? {
          next: {
            ...command,
            shell: `nforge agent ${quote(root)} start ${quote(JSON.stringify({ operationId: command.operationId, stackOn: command.stackOn, stackEntry: command.stackEntry, outcome: command.outcome }))}`,
          },
        }
      : {}),
  };
}
/** Status is joined afresh, never cached with source verdicts: a terminal event
 * immediately retracts its advice, including when source-cache entries survive. */
export function queueAheadPreview(
  source: QueueAheadSource,
  cache: QueueAheadCache,
  root: string,
  main: string,
  mine: string,
  ahead: QueueAheadEntry[],
): QueueAheadPreview {
  const started = performance.now(),
    pending = ahead.filter(entry => queueAheadPending(entry.status));
  const selected = pending.slice(0, QUEUE_AHEAD_LIMIT);
  const result: QueueAheadPreview = {
    main,
    considered: selected.length,
    more: pending.length > selected.length,
    conflicts: [],
    unavailable: [],
    cost: { composeCalls: 0, cacheHits: 0, durationMs: 0, maxComposeCalls: QUEUE_AHEAD_LIMIT * 2 },
  };
  for (const entry of selected) {
    try {
      const key = queueAheadKey(main, mine, entry.head);
      let verdict = cache.read<ReturnType<typeof composeQueueAhead>>(key);
      if (verdict) result.cost.cacheHits++;
      else {
        verdict = composeQueueAhead(
          {
            compose(...args) {
              result.cost.composeCalls++;
              return source.compose(...args);
            },
          },
          main,
          mine,
          entry.head,
        );
        cache.write(key, verdict);
      }
      if (verdict.unavailable) result.unavailable.push(entry.id);
      else if (verdict.paths.length)
        result.conflicts.push(queueAheadAdvice(root, entry, verdict.paths, mine));
    } catch {
      result.unavailable.push(entry.id);
    }
  }
  result.cost.durationMs = Math.round(performance.now() - started);
  return result;
}
