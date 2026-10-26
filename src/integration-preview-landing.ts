// SPDX-License-Identifier: Apache-2.0
import { readPolicy } from './work-autonomy.js';
import { previewPinned } from './integration-preview.js';
import type { WorkStore } from './work-store.js';

export type PreviewExclusion = { laneId: string; head: string; errors: string[]; pair?: string[] };
export type LandingPreview = {
  main?: string;
  key?: string;
  status: string;
  inputs: { laneId: string; head: string }[];
  excluded: PreviewExclusion[];
};
/** Exact saved inputs only. Keep the caller's first Lane in a failing pair; every
 * retained subset still needs its normal landing check. Unavailable advice never denies work. */
export function previewLanding(
  store: WorkStore,
  inputs: { laneId: string; head: string }[],
  options: { skip?: boolean; base?: string; protectedLaneIds?: string[] } = {},
): LandingPreview | undefined {
  if (options.skip || !readPolicy(store).integrationPreview?.auto) return;
  const unique = [...new Map(inputs.map(pin => [pin.laneId, pin])).values()];
  try {
    const result = previewPinned(store, undefined, unique, options.base).result;
    const excluded: PreviewExclusion[] = [];
    const protectedIds = new Set(options.protectedLaneIds);
    const exclude = (laneId: string, errors: string[], pair?: string[]) => {
      if (protectedIds.has(laneId) || excluded.some(item => item.laneId === laneId)) return;
      excluded.push({ ...unique.find(pin => pin.laneId === laneId)!, errors, ...(pair ? { pair } : {}) });
    };
    for (const item of result.individual ?? [])
      if (item.result.status === 'failed') exclude(item.laneId, item.result.errors);
    for (const pair of result.pairs) {
      if (pair.laneIds.some(id => excluded.some(item => item.laneId === id))) continue;
      const later = unique
        .filter(pin => pair.laneIds.includes(pin.laneId) && !protectedIds.has(pin.laneId))
        .at(-1);
      if (later) exclude(later.laneId, pair.errors, pair.laneIds);
    }
    return { main: result.main, key: result.key, inputs: result.inputs, status: result.status, excluded };
  } catch (error) {
    return {
      inputs: unique,
      status: (error as { code?: string }).code ?? 'INTEGRATION_PREVIEW_ERROR',
      excluded: [],
    };
  }
}
export const previewExclusionMessage =
  'Local integration preview excluded saved Lane inputs before the landing check. Retry with preview:"skip" to override; ordinary landing checks still apply.';
