// SPDX-License-Identifier: Apache-2.0
export type RepairInput = { laneId: string; head: string };
/** Advisory diagnostics retain their provenance; none is transferable check authority. */
export type ConflictEvidence = {
  inputs: RepairInput[];
  errors: string[];
} & (
  | { kind: 'text'; source: 'native-merge' }
  | { kind: 'contract'; source: 'contract'; head: string }
  | {
      kind: 'combined-static';
      source: 'integration-preview';
      main: string;
      head?: string | undefined;
      configuration: string;
      environment: string;
      checks: {
        name: string;
        executable: string;
        args: string[];
        id?: string | undefined;
        definition?: string | undefined;
      }[];
      minimization: 'incomplete';
      controls: { inputs: RepairInput[]; status: string; head?: string | undefined; errors: string[] }[];
    }
  | {
      kind: 'check';
      source: 'forge-recorded';
      main: string;
      head: string;
      viewId: string;
      runId: string;
      checkId: string;
      definition: string;
      environment: string;
      status: string;
      cause?: string;
      selection: { known: boolean; scope?: string; tests?: string[]; plan?: string };
      logs: { operationId: string; streams: readonly ['stdout', 'stderr'] };
      minimization: 'incomplete';
    }
);
export type SyncLineage = {
  laneId: string;
  operationId: string;
  status: 'merged' | 'conflict';
  resolvedHead?: string;
  parent: string;
  head: string;
  target: string;
  undo: { action: 'undo-sync'; laneId: string; syncOperationId: string; force: false };
  undoneBy: { operationId: string; head: string; preservedHead: string }[];
};
export type RepairResolution = {
  noticeId: string;
  intentId: string;
  laneId: string;
  head: string;
  handoffId?: string | undefined;
  applicability: 'current' | 'historical';
  /** A declared repair and its subsequent evidence, not an assertion of semantic correctness. */
  candidates: {
    viewId: string;
    head?: string | undefined;
    status: string;
    checks: { runId: string; head: string; definition: string; status: string }[];
    acceptances: { id: string; head: string; undo?: string }[];
  }[];
};
