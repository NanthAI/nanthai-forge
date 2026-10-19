// SPDX-License-Identifier: Apache-2.0
import { checkStatus } from '../ui/status';

export function latestRun<T extends { viewId: string; startedAt?: string }>(
  runs: readonly T[],
  viewId: string,
): T | undefined {
  return runs
    .filter(run => run.viewId === viewId)
    .reduce<T | undefined>(
      (best, run) => (!best || (run.startedAt ?? '') >= (best.startedAt ?? '') ? run : best),
      undefined,
    );
}

/** H17 family identity: one Intent and the same input Lanes, regardless of their saved heads. */
export function checkMeaning(
  work: {
    views: readonly { id: string; intentId?: string; at?: string; inputs?: readonly { laneId: string }[] }[];
    runs: readonly { viewId: string; status: string; startedAt?: string }[];
  },
  viewId: string,
  status: string,
): ReturnType<typeof checkStatus> & { laterViewId?: string } {
  const state = checkStatus(status);
  const view = work.views.find(view => view.id === viewId);
  if (status !== 'failed' || !view?.intentId || !view.at || !view.inputs?.length) return state;
  const family = (v: typeof view) => JSON.stringify([v.intentId, v.inputs?.map(i => i.laneId).sort()]);
  const latest = work.views
    .filter(v => family(v) === family(view))
    .reduce((a, b) => ((b.at ?? '') >= (a.at ?? '') ? b : a), view);
  if (latest.id === view.id) return state;
  const passed = latestRun(work.runs, latest.id)?.status === 'passed';
  return {
    tone: 'plain' as const,
    glyph: 'plain' as const,
    label: passed
      ? 'Check failed · fixed in a later View (passed)'
      : 'Check failed · superseded by a later View',
    laterViewId: latest.id,
  };
}
