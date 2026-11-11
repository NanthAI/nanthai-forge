// SPDX-License-Identifier: Apache-2.0
import { ForgeError, invariant } from './errors.js';
import { validStateSize, type StateSize } from './state/size.js';

/** Twice the largest (max / median - 1) in the three-repeat spike, rounded up
 * to 5 percentage points: 2 * 9.5% -> 20%. Evidence and limits:
 * docs/research/source-step-memory.md#supported-source-step-envelope.
 * Temporary until P8 streaming (c3add134) replaces whole-manifest work. */
export const sourceMemoryMargin = 0.2;
export const sourceStateLimits = {
  save: { fileCount: 122400, manifestBytes: 19360000 },
  compose: { fileCount: 68800, manifestBytes: 11200000 },
  // A sync's conflicts are unknown before reading its inputs, so reserve the
  // smaller conflict-sync envelope for every sync (also covers resolve/revert).
  sync: { fileCount: 56800, manifestBytes: 9200000 },
  'conflict-sync': { fileCount: 56800, manifestBytes: 9200000 },
} as const;
export type SourceSizePhase = keyof typeof sourceStateLimits;
export const sourceSizeDocs =
  'https://github.com/NanthAI/nanthai-forge/blob/main/docs/operations/source-exchange.md#supported-repository-envelope';

/** Missing metadata is the approved legacy path, with no extra read or refusal. */
export function assertSourceStateSize(phase: SourceSizePhase, size: StateSize | undefined) {
  if (size === undefined) return;
  invariant(validStateSize(size), 'SOURCE_HASH_MISMATCH', 'Stored State dimensions are invalid.');
  const limits = sourceStateLimits[phase];
  for (const dimension of ['fileCount', 'manifestBytes'] as const) {
    if (size[dimension] <= limits[dimension]) continue;
    throw new ForgeError(
      'SOURCE_STATE_TOO_LARGE',
      `${phase}: ${dimension} ${size[dimension]} exceeds ${limits[dimension]} (source memory envelope). Split the repository. ${sourceSizeDocs}`,
    );
  }
}
export function sourceSizePhase(plan: { kind: string; work?: { mode: string } }): SourceSizePhase {
  if (plan.kind === 'forge-hosted-compose-input') return 'compose';
  if (plan.kind === 'forge-hosted-sync-input')
    return plan.work?.mode === 'resolve' || plan.work?.mode === 'resolution' ? 'conflict-sync' : 'sync';
  return 'save';
}
