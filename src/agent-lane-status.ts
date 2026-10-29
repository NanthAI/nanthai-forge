import { checkFileSummary } from './check-file-summary.js';
// SPDX-License-Identifier: Apache-2.0
import { readLaneSubmissions } from './landing-submission-read.js';
import { stackStatus } from './agent-stack.js';
import { latestHandoff, handoffSummary } from './agent-handoff-types.js';
import { ForgeError, invariant } from './errors.js';
import { NativeSource } from './native-source.js';
import { changedPaths } from './agent-sync.js';
import { workGit } from './work-git.js';
import { laneReceipt } from './agent-receipts.js';
import { autoSnapshotNotice } from './lane-auto-snapshot.js';
import type { AgentAction } from './agent-workflow-schema.js';
import type { WorkStore } from './work-store.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import type { WorkData } from './work-types.js';

type Status = Extract<AgentAction, { action: 'status' }>;
/** Exact saved source only: unsaved edits remain available through review. */
export function agentLaneStatus(
  store: WorkStore,
  command: Status,
  tx?: WorkRecordTransaction,
  data?: WorkData,
) {
  const lane =
    tx?.find('lanes', command.laneId!)?.record ?? data?.lanes.find(item => item.id === command.laneId);
  invariant(lane, 'NOT_FOUND', 'Lane not found.');
  invariant(
    !command.intentId || command.intentId === lane.intentId,
    'NOT_FOUND',
    'Lane is not in the selected Intent.',
  );
  const views = (
    tx
      ? tx.all('views', lane.intentId, 'intentId')
      : data!.views.filter(view => view.intentId === lane.intentId)
  ).filter(view => view.inputs.some(input => input.laneId === lane.id));
  const viewIds = new Set(views.map(view => view.id));
  const runPosition = tx
    ? views
        .flatMap(view => tx.positions('runs', view.id, 'viewId'))
        .sort((a, b) => a - b)
        .at(-1)
    : undefined;
  const lastCheck = tx
    ? runPosition === undefined
      ? undefined
      : tx.at('runs', runPosition)
    : data!.runs.filter(run => viewIds.has(run.viewId)).at(-1);
  let changedPathCount: number | null = null;
  let changedPathsError: { code: string; message: string } | undefined;
  try {
    if (lane.base === lane.head) changedPathCount = 0;
    else if (store.native) {
      const source = new NativeSource(store.root);
      changedPathCount = changedPaths(source.state(lane.base).files, source.state(lane.head).files).length;
    } else
      changedPathCount = workGit(store.root, [
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        '--no-ext-diff',
        '--no-textconv',
        lane.base,
        lane.head,
        '--',
      ])
        .split('\0')
        .filter(Boolean).length;
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    changedPathsError = { code: error.code, message: error.message };
  }
  const end = command.offset + command.limit;
  const autoSnapshot = store.native ? autoSnapshotNotice(store, lane) : undefined;
  const submissions = readLaneSubmissions(store, lane.id);
  const landing = [...submissions]
    .reverse()
    .find(
      item => !item.terminal || ['main-audit', 'github-mirror-push'].includes(item.phases?.current ?? ''),
    );

  return {
    ...laneReceipt(lane, store.path(lane.id)),
    ...(autoSnapshot ? { autoSnapshot } : {}),
    submissions,
    ...(landing ? { landing: { operationId: landing.operationId, phases: landing.phases } } : {}),
    ...(lane.stack ? { stackStatus: stackStatus(store, lane) } : {}),
    handoff: handoffSummary(
      latestHandoff(
        (
          tx?.find('intents', lane.intentId)?.record ??
          data?.intents.find(intent => intent.id === lane.intentId)
        )?.notes ?? [],
        lane.id,
      ),
    ),
    saves: lane.checkpoints.length,
    changedPathCount,
    changedPathsSource: 'saved-head' as const,
    ...(changedPathsError ? { changedPathsError } : {}),
    candidates: {
      total: views.length,
      items: views
        .slice()
        .reverse()
        .slice(command.offset, end)
        .map(view => ({
          viewId: view.id,
          head: view.head ?? null,
          status: view.status,
          at: view.at,
          laneHead: view.inputs.find(input => input.laneId === lane.id)!.head,
        })),
      more: end < views.length,
      nextOffset: end < views.length ? end : null,
    },
    lastCheck: lastCheck
      ? {
          operationId: lastCheck.id,
          viewId: lastCheck.viewId,
          head: lastCheck.head,
          checkId: lastCheck.check.id,
          status: lastCheck.status,
          ...(lastCheck.backend?.fileReports
            ? { testFiles: checkFileSummary(lastCheck.backend.fileReports) }
            : {}),
          startedAt: lastCheck.startedAt,
          endedAt: lastCheck.endedAt ?? null,
          exitCode: lastCheck.exitCode ?? null,
        }
      : null,
  };
}
