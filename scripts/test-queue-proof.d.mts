// SPDX-License-Identifier: Apache-2.0
export function assertQueueProof(
  changes: { source: string[]; receipts: string[] },
  reads: { readText: (path: string) => string; digest: (path: string) => string | null },
): void;
