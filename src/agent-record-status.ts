import { readLaneSubmissions } from './landing-submission-read.js';
import { agentLaneStatus } from './agent-lane-status.js';
import { agentCostSummary } from './agent-cost-summary.js';
// SPDX-License-Identifier: Apache-2.0
import { readPolicy } from './work-autonomy.js';
import type { WorkStore } from './work-store.js';
import type { WorkRecordTransaction, WorkCollection, WorkRecord } from './work-record-transaction.js';
import type { AgentAction } from './agent-workflow-schema.js';
import type { CheckRun } from './work-types.js';
import { checkEnvironment } from './work-run.js';
import { nativeChannels } from './native-work.js';
import { channelStatus } from './work-channel.js';
import { evidenceApplicability, runApplicability } from './work-evidence.js';
import { laneReceipt, viewReceipt, runReceipt } from './agent-receipts.js';
import { annotateLanes } from './agent-lifecycle.js';
import { invariant } from './errors.js';
export function recordApplicability(store: WorkStore, run: CheckRun, tx = store.readRecords()) {
  if (!tx) return runApplicability(store.load(), run, checkEnvironment());
  const data = tx.data(),
    view = tx.find('views', run.viewId)?.record,
    check = tx.find('checks', run.check.id)?.record;
  if (view) {
    data.views.push(view);
    const latest = tx.find('views', view.intentId, 'intentId', true)?.record;
    if (latest && latest.id !== view.id) data.views.push(latest);
  }
  if (check) data.checks.push(check);
  return runApplicability(data, run, checkEnvironment());
}
export function agentRecordStatus(
  store: WorkStore,
  command: Extract<AgentAction, { action: 'status' }>,
  original: WorkRecordTransaction,
) {
  const tx = original,
    data = tx.data(),
    environment = checkEnvironment();
  const lane = command.laneId ? agentLaneStatus(store, command, tx) : undefined;
  if (lane && !command.detail) return { revision: tx.revision, result: { lane } };
  invariant(
    !command.intentId || tx.positions('intents', command.intentId).length,
    'NOT_FOUND',
    'Intent not found.',
  );
  const positions = (collection: WorkCollection) =>
    Array.from({ length: tx.manifest.collections[collection]!.count }, (_, index) => index);
  const selected = (collection: 'intents' | 'lanes' | 'views') =>
    command.intentId
      ? tx.positions(collection, command.intentId, collection === 'intents' ? 'id' : 'intentId')
      : positions(collection);
  const selectedViews = command.intentId
    ? new Set(selected('views').map(position => tx.fieldsAt('views', position).record.id))
    : undefined;
  const evidence = (collection: 'runs' | 'reviews') =>
    selectedViews
      ? [...selectedViews].flatMap(viewId => tx.positions(collection, viewId, 'viewId')).sort((a, b) => a - b)
      : positions(collection);
  const page = <T>(items: T[]) => ({
    total: items.length,
    items: items
      .slice()
      .reverse()
      .slice(command.offset, command.offset + command.limit),
    more: command.offset + command.limit < items.length,
    nextOffset: command.offset + command.limit < items.length ? command.offset + command.limit : null,
  });
  const records = <K extends WorkCollection, T>(
    collection: K,
    rows: number[],
    project: (record: WorkRecord<K>) => T,
    compact = false,
  ) => {
    const result = page(rows);
    return {
      ...result,
      items: result.items.map(position =>
        project(compact ? tx.fieldsAt(collection, position).record : tx.at(collection, position)),
      ),
    };
  };
  const submissions = readLaneSubmissions(store);
  // Channel receipts are a global namespace; only this collection is needed to reconcile refs.
  data.channelMoves = positions('channelMoves').map(position => tx.at('channelMoves', position));
  return {
    revision: tx.revision,
    result: {
      ...(lane ? { lane } : {}),
      ...agentCostSummary(store.root, tx),
      autonomyPolicy: readPolicy(store),
      checkRunner: { runner: 'local', ...readPolicy(store).checks },
      engine: store.native ? 'forge-native' : 'git',
      automaticActions: records(
        'automaticActions',
        Array.from({ length: tx.manifest.collections.automaticActions?.count ?? 0 }, (_, index) => index),
        value => value,
      ),
      channels: page(store.native ? nativeChannels(data) : channelStatus(store, data)),
      intents: records(
        'intents',
        selected('intents'),
        intent => ({
          intentId: intent.id,
          outcome: intent.outcome,
          base: intent.base,
          status: intent.status,
          lanes: tx.all('lanes', intent.id, 'intentId').map(lane => laneReceipt(lane, store.path(lane.id))),
        }),
        true,
      ),
      lanes: (() => {
        const section = records(
          'lanes',
          selected('lanes'),
          lane => ({
            ...laneReceipt(lane, store.path(lane.id)),
            submissions: submissions.filter(item => item.laneId === lane.id),
          }),
          true,
        );
        return { ...section, items: annotateLanes(store, section.items, data) };
      })(),
      views: records('views', selected('views'), viewReceipt),
      checks: records('checks', positions('checks'), check => ({
        checkId: check.id,
        name: check.name,
        definition: check.definition,
      })),
      environmentFingerprint: environment.fingerprint,
      runs: records('runs', evidence('runs'), run => ({
        ...runReceipt(run),
        ...recordApplicability(store, run, tx),
      })),
      reviews: records('reviews', evidence('reviews'), review => {
        const view = tx.find('views', review.viewId)?.record,
          context = tx.data();
        if (view) {
          context.views.push(view);
          const latest = tx.find('views', view.intentId, 'intentId', true)?.record;
          if (latest && latest.id !== view.id) context.views.push(latest);
        }
        return {
          reviewId: review.id,
          viewId: review.viewId,
          head: review.head,
          reviewer: review.reviewer,
          decision: review.decision,
          provenance: review.provenance,
          applicability: evidenceApplicability(context, review.viewId),
        };
      }),
    },
  };
}
