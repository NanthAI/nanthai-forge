// SPDX-License-Identifier: Apache-2.0
export type QueueProofChanges = { source: string[]; receipts: string[]; scoped?: Record<string, string> };
export type QueueProofReads = {
  readText: (path: string) => string;
  digest: (path: string) => string | null;
  scoped?: (
    file: string,
    proof: { changes?: Record<string, unknown>; exercised?: Record<string, unknown> },
    proofPath: string,
  ) => boolean;
};
export type QueueProofGaps = {
  missing: string[];
  stale: Map<string, string[]>;
  scoped: Record<string, string>;
  scopable: string[];
};
export const REFRESH_QUEUE_PROOF: string;
export function queueProofGaps(changes: QueueProofChanges, reads: QueueProofReads): QueueProofGaps;
export function queueProofMessage(gaps: Pick<QueueProofGaps, 'missing' | 'stale'>): string;
export function assertQueueProof(changes: QueueProofChanges, reads: QueueProofReads): Record<string, string>;
export function planQueueProof(
  changes: QueueProofChanges,
  reads: Omit<QueueProofReads, 'scoped'> & {
    mainTexts: (paths: string[]) => Promise<Map<string, string | null>>;
  },
): Promise<{ error?: string; scoped?: Record<string, string> }>;
export function validExercisedScope(scope: unknown): boolean;
