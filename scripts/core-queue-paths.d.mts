// SPDX-License-Identifier: Apache-2.0
export const REGISTRY: string;
export function queueProofPaths(
  paths: readonly string[] | undefined,
): { source: string[]; receipts: string[] } | undefined;
