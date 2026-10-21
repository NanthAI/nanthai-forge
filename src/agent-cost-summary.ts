// SPDX-License-Identifier: Apache-2.0
import { PeersCache } from './agent-peers-cache.js';
import { digest } from './hash.js';
import { modalMonthCost } from './check-backend.js';
import { runnerMonthCosts } from './check-cost.js';
import { pageSize } from './work-records.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import type { CheckRun } from './work-types.js';

type CostRun = Pick<CheckRun, 'id' | 'startedAt' | 'backend'>;
type Summary = {
  modalCost: ReturnType<typeof modalMonthCost>;
  checkCosts: ReturnType<typeof runnerMonthCosts>;
};

/** Exact immutable page summaries survive CLI processes and unrelated Work
 * revisions. A changed page reads at most pageSize records; a warm collection
 * reads no run records. Missing caches reconstruct from the same pinned pages. */
export function agentCostSummary(root: string, tx: WorkRecordTransaction, now = new Date()): Summary {
  const collection = tx.manifest.collections.runs;
  const cache = new PeersCache(root);
  const key = `agent-cost-v1:${now.toISOString().slice(0, 7)}:${digest(JSON.stringify(collection ?? null))}`;
  const cached = cache.read<Summary>(key);
  if (cached) return cached;
  const runs = (collection?.pages ?? []).flatMap((hash, page) => {
    const pageKey = `agent-cost-page-v1:${hash}`;
    const cached = cache.read<CostRun[]>(pageKey);
    if (cached) return cached;
    const rows = Array.from(
      { length: Math.min(pageSize, collection!.count - page * pageSize) },
      (_, offset) => {
        const { id, startedAt, backend } = tx.at('runs', page * pageSize + offset);
        return { id, startedAt, ...(backend ? { backend } : {}) };
      },
    );
    cache.write(pageKey, rows);
    return rows;
  });
  const result = { modalCost: modalMonthCost(runs, now), checkCosts: runnerMonthCosts(runs) };
  cache.write(key, result);
  return result;
}
