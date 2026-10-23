import { previewMeasurements } from './preview-accounting.js';
// SPDX-License-Identifier: Apache-2.0
import { PeersCache } from './agent-peers-cache.js';
import { digest } from './hash.js';
import { modalMonthCost } from './check-backend.js';
import { runnerMonthCosts } from './check-cost.js';
import { accountingContext, accountingRecords } from './accounting-records.js';
import { trainAccounting, type CostRun } from './train-accounting.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';

type Summary = {
  modalCost: ReturnType<typeof modalMonthCost>;
  checkCosts: ReturnType<typeof runnerMonthCosts> & {
    train: Omit<ReturnType<typeof trainAccounting>, 'submissions'>;
  };
};

/** Exact immutable page summaries survive CLI processes and unrelated Work
 * revisions. A changed page reads at most pageSize records; a warm collection
 * reads no run records. Missing caches reconstruct from the same pinned pages. */
export function agentCostSummary(root: string, tx: WorkRecordTransaction, now = new Date()): Summary {
  const collection = tx.manifest.collections.runs;
  const cache = new PeersCache(root);
  const key = `agent-cost-v4:${now.toISOString().slice(0, 7)}:${digest(JSON.stringify([previewMeasurements(tx.directory).version, collection, ...['landingBatches', 'landingEntries', 'channelMoves'].map(key => tx.manifest.collections[key])]))}`;
  const cached = cache.read<Summary>(key);
  if (cached) return cached;
  const runs = accountingRecords(
    root,
    tx,
    'runs',
    ({ id, startedAt, backend, mainCheck, queuedAt, endedAt, status, viewId }): CostRun => ({
      id,
      startedAt,
      ...(backend ? { backend } : {}),
      ...(mainCheck ? { mainCheck } : {}),
      ...(queuedAt ? { queuedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      status,
      viewId,
    }),
  );
  // Project status returns fixed-size totals. Per-submission rows belong to selected making-of records.
  const { submissions, ...train } = trainAccounting(runs, accountingContext(root, tx), now);
  void submissions;
  const result = { modalCost: modalMonthCost(runs, now), checkCosts: { ...runnerMonthCosts(runs), train } };
  cache.write(key, result);
  return result;
}
