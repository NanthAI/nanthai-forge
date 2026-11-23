// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
export const REGISTRY: string;
export function coreQueuePath(path: string): boolean;
export function headerOnlyChange(
  path: string,
  before: string | null | undefined,
  after: string | null | undefined,
): boolean;
export function queueProofPaths(
  paths: readonly string[] | undefined,
  read?: (path: string) => readonly [string | null | undefined, string | null | undefined],
): { source: string[]; receipts: string[] } | undefined;
