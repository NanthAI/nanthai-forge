// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';
import type { Lane } from './work-types.js';

type Receipt = { revision: number; result: Record<string, unknown> };

/** Receipt metadata is part of the activation transaction and portable Work.
 * Filesystem paths are derived locally rather than uploaded with the receipt. */
export function readStartReceipt(store: WorkStore, lane: Lane, operationId: string): Receipt | undefined {
  const receipt = lane.startReceipt;
  if (!receipt) return;
  const siblings = receipt.result.siblingLanes as { laneId: string }[];
  invariant(
    receipt.result.operationId === operationId &&
      receipt.result.laneId === lane.id &&
      receipt.result.intentId === lane.intentId &&
      receipt.result.state === 'active' &&
      typeof receipt.result.head === 'string' &&
      (store.native ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).test(receipt.result.head) &&
      receipt.result.base === receipt.result.head &&
      receipt.result.currentHead === receipt.result.head &&
      Array.isArray(siblings) &&
      siblings.every(
        sibling => sibling && typeof sibling.laneId === 'string' && /^[0-9a-f-]{36}$/.test(sibling.laneId),
      ),
    'INVALID_WORK_STORE',
    'Retained start receipt differs from its original Lane.',
  );
  return {
    revision: receipt.revision,
    result: {
      ...receipt.result,
      ...(lane.stack ? { currentHead: lane.head } : {}),
      path: store.path(lane.id),
      siblingLanes: siblings.map(sibling => ({ ...sibling, path: store.path(sibling.laneId) })),
    },
  };
}
export function stageStartReceipt(tx: WorkRecordTransaction, laneId: string, receipt: Receipt) {
  const { path: _path, ...result } = receipt.result;
  void _path;
  const siblings = result.siblingLanes as Record<string, unknown>[];
  tx.patchFields('lanes', laneId, {
    startReceipt: {
      revision: receipt.revision,
      result: {
        ...result,
        siblingLanes: siblings.map(({ path: _siblingPath, ...sibling }) => {
          void _siblingPath;
          return sibling;
        }),
      },
    },
  });
}
