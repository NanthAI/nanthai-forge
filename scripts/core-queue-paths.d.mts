// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
export const REGISTRY: string;
export function queueProofPaths(
  paths: readonly string[] | undefined,
): { source: string[]; receipts: string[] } | undefined;
