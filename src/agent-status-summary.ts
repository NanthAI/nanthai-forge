// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import { effectivePolicy } from './autonomy-policy.js';
import { pageSize } from './work-records.js';
import { laneReceipt, runReceipt } from './agent-receipts.js';
import { checkEnvironment } from './work-run.js';
import { readPolicy } from './work-autonomy.js';
import { statusMain, statusPositions, statusView } from './status-records.js';
import type { WorkStore } from './work-store.js';
import type { WorkCollection, WorkRecordTransaction } from './work-record-transaction.js';
import type { AgentAction } from './agent-workflow-schema.js';

/** Default project status reads selected pages, never reconstructs submissions,
 * costs, source ancestry or peer indexes. Explicit detail retains those readers. */
export function agentStatusSummary(
  store: WorkStore,
  command: Extract<AgentAction, { action: 'status' }>,
  tx: WorkRecordTransaction,
) {
  const { offset, limit, intentId } = command;
  invariant(!intentId || tx.positions('intents', intentId).length, 'NOT_FOUND', 'Intent not found.');
  const select = (collection: 'intents' | 'lanes' | 'views') =>
    intentId ? tx.positions(collection, intentId, collection === 'intents' ? 'id' : 'intentId') : undefined;
  const evidence = (collection: 'runs' | 'reviews') =>
    intentId
      ? tx
          .positions('views', intentId, 'intentId')
          .flatMap(position => tx.positions(collection, tx.fieldsAt('views', position).record.id, 'viewId'))
          .sort((a, b) => a - b)
      : undefined;
  const page = <T>(collection: WorkCollection, project: (position: number) => T, selected?: number[]) => {
    const result = statusPositions(tx, collection, offset, limit, selected);
    return { ...result, items: result.items.map(project) };
  };
  const policy = readPolicy(store),
    main = statusMain(tx);
  return {
    revision: tx.revision,
    result: {
      sections: {
        skipped: [
          'costs',
          'submissions',
          'merged-ancestry',
          'peer-index',
          'lane-detail',
          'unsaved-edits',
          'evidence-applicability',
          'other-channels',
        ],
        request: { action: 'status', detail: true },
      },
      engine: store.native ? 'forge-native' : 'git',
      autonomyPolicy: policy,
      checkRunner: { runner: 'local', ...policy.checks },
      environmentFingerprint: checkEnvironment().fingerprint,
      main: main ? { head: main.head, acceptanceId: main.id, acceptedAt: main.at } : null,
      channels: {
        scope: 'main',
        items: main ? [{ name: 'main', head: main.head, moveId: main.id, diagnostic: null }] : [],
        detailDeferred: true,
      },
      automaticActions: page(
        'automaticActions',
        position => tx.fieldsAt('automaticActions', position).record,
      ),
      intents: page(
        'intents',
        position => {
          const intent = tx.fieldsAt('intents', position).record;
          const lanes = statusPositions(tx, 'lanes', 0, limit, tx.positions('lanes', intent.id, 'intentId'));
          return {
            intentId: intent.id,
            outcome: intent.outcome,
            base: intent.base,
            status: intent.status,
            lanes: lanes.items.map(position => {
              const lane = tx.fieldsAt('lanes', position).record;
              return laneReceipt(lane, store.path(lane.id));
            }),
            lanePage: { total: lanes.total, nextOffset: lanes.nextOffset },
          };
        },
        select('intents'),
      ),
      lanes: page(
        'lanes',
        position => {
          const { record, counts } = tx.fieldsAt('lanes', position);
          return {
            ...laneReceipt(record, store.path(record.id)),
            saves: counts.checkpoints ?? 0,
            detailDeferred: true,
          };
        },
        select('lanes'),
      ),
      views: page(
        'views',
        position => {
          const view = statusView(tx, position);
          return {
            viewId: view.id,
            intentId: view.intentId,
            base: view.base,
            head: view.head ?? null,
            status: view.status,
            inputs: view.inputs,
            inputCount: view.inputCount,
            inputsMore: view.inputs.length < view.inputCount,
            dependencyCount: view.dependencyCount,
            detailDeferred: true,
          };
        },
        select('views'),
      ),
      checks: page('checks', position => {
        const check = tx.fieldsAt('checks', position).record;
        return { checkId: check.id, name: check.name, definition: check.definition };
      }),
      runs: page('runs', position => runReceipt(tx.fieldsAt('runs', position).record), evidence('runs')),
      reviews: page(
        'reviews',
        position => {
          const review = tx.fieldsAt('reviews', position).record;
          return {
            reviewId: review.id,
            viewId: review.viewId,
            head: review.head,
            reviewer: review.reviewer,
            decision: review.decision,
            provenance: review.provenance,
            detailDeferred: true,
          };
        },
        evidence('reviews'),
      ),
    },
  };
}

/** Legacy JSON must still be validated completely, but reading it never opts
 * into submission journals, ancestry, cost accounting or peer reconstruction. */
export function legacyAgentStatusSummary(
  store: WorkStore,
  command: Extract<AgentAction, { action: 'status' }>,
  data: import('./work-types.js').WorkData,
) {
  const { offset, limit, intentId } = command;
  invariant(
    !intentId || data.intents.some(intent => intent.id === intentId),
    'NOT_FOUND',
    'Intent not found.',
  );
  const selected = (id: string) => !intentId || id === intentId;
  const page = <T, U>(rows: T[], project: (row: T) => U) => ({
    total: rows.length,
    items: rows
      .slice()
      .reverse()
      .slice(offset, offset + limit)
      .map(project),
    more: offset + limit < rows.length,
    nextOffset: offset + limit < rows.length ? offset + limit : null,
  });
  const main = data.channelMoves.filter(move => move.channel === 'main' && move.status === 'accepted').at(-1);
  const viewIds = new Set(data.views.filter(view => selected(view.intentId)).map(view => view.id));
  const policy = effectivePolicy(data);
  return {
    revision: data.revision,
    result: {
      readMode: 'legacy-complete-validation',
      sections: {
        skipped: [
          'costs',
          'submissions',
          'merged-ancestry',
          'peer-index',
          'lane-detail',
          'unsaved-edits',
          'evidence-applicability',
          'other-channels',
        ],
        request: { action: 'status', detail: true },
      },
      engine: store.native ? 'forge-native' : 'git',
      autonomyPolicy: policy,
      checkRunner: { runner: 'local', ...policy.checks },
      environmentFingerprint: checkEnvironment().fingerprint,
      main: main ? { head: main.head, acceptanceId: main.id, acceptedAt: main.at } : null,
      channels: {
        scope: 'main',
        items: main ? [{ name: 'main', head: main.head, moveId: main.id, diagnostic: null }] : [],
        detailDeferred: true,
      },
      automaticActions: page(data.automaticActions ?? [], row => row),
      intents: page(
        data.intents.filter(intent => selected(intent.id)),
        intent => {
          const lanes = data.lanes.filter(lane => lane.intentId === intent.id);
          return {
            intentId: intent.id,
            outcome: intent.outcome,
            base: intent.base,
            status: intent.status,
            lanes: lanes
              .slice()
              .reverse()
              .slice(0, limit)
              .map(lane => laneReceipt(lane, store.path(lane.id))),
            lanePage: { total: lanes.length, nextOffset: lanes.length > limit ? limit : null },
          };
        },
      ),
      lanes: page(
        data.lanes.filter(lane => selected(lane.intentId)),
        lane => ({
          ...laneReceipt(lane, store.path(lane.id)),
          saves: lane.checkpoints.length,
          detailDeferred: true,
        }),
      ),
      views: page(
        data.views.filter(view => selected(view.intentId)),
        view => ({
          viewId: view.id,
          intentId: view.intentId,
          base: view.base,
          head: view.head ?? null,
          status: view.status,
          inputs: view.inputs.slice(0, pageSize),
          inputCount: view.inputs.length,
          inputsMore: view.inputs.length > pageSize,
          dependencyCount: view.dependencies?.length ?? 0,
          detailDeferred: true,
        }),
      ),
      checks: page(data.checks, check => ({
        checkId: check.id,
        name: check.name,
        definition: check.definition,
      })),
      runs: page(
        data.runs.filter(run => viewIds.has(run.viewId)),
        runReceipt,
      ),
      reviews: page(
        data.reviews.filter(review => viewIds.has(review.viewId)),
        review => ({
          reviewId: review.id,
          viewId: review.viewId,
          head: review.head,
          reviewer: review.reviewer,
          decision: review.decision,
          provenance: review.provenance,
          detailDeferred: true,
        }),
      ),
    },
  };
}
