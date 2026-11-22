// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
import type { BatchPut, BatchResult } from '../src/planning-batch';

export type Receipt = {
  kind: 'planning-close' | 'planning-undo-close';
  operationId: string;
  results: BatchResult[];
  detached: number;
  undo: BatchPut[];
};
export type CloseTarget = [id: string, parentId: string];
export type Progress = {
  parents: BatchPut[];
  offset: number;
  firstChild: number;
  receipt: Receipt;
  task?: Id<'_scheduled_functions'>;
} & (
  | { kind: 'close'; children: CloseTarget[] }
  | { kind: 'undo'; children: BatchPut[]; untouched?: CloseTarget[] }
);
export type Operation = Doc<'projectHostedOperations'>;

export const pendingPlanningApply = (operation: Operation) =>
  operation.planningApply ? (JSON.parse(operation.planningApply) as Progress) : null;

/** These fields belong to the visibility context only, outside its reply. */
export function publicPlanRoot<T>(row: {
  value: string;
  planningClose?: string | undefined;
  planningRestored?: string | undefined;
}) {
  const root = JSON.parse(row.value) as T & { planningClose?: string; planningRestored?: string };
  if (row.planningClose) root.planningClose = row.planningClose;
  if (row.planningRestored) root.planningRestored = row.planningRestored;
  return root;
}
