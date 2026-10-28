// SPDX-License-Identifier: Apache-2.0
// Internal transaction and scheduling budgets; retained Work has no item ceiling.
// Current snapshots/output are stored once in private database pages.
export const RETURN_BUDGET = {
  states: 16,
  sourceBytes: 2 * 1024 * 1024,
  rows: 1000,
  rowBytes: 900000,
  commitMs: 1000,
  actionMs: 30000,
  actionSteps: 1000,
  metadataPages: 64,
  metadataBytes: 2 * 1024 * 1024,
};
