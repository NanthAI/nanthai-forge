// SPDX-License-Identifier: Apache-2.0
// Synthetic records shared by the focused state-table tests and local visual preview.
export const now = Date.parse('2026-10-23T19:50:00Z');
export function s16Work() {
  const at = minute => `2026-10-23T19:${minute}:00Z`;
  const states = ['queued', 'checking', 'review', 'machine', 'failed', 'infra', 'unknown', 'later', 'landed', 'dirty', 'parent', 'dependency'];
  const heads = states.map((_, index) => (index + 1).toString(16).repeat(64));
  const names = ['Batch projection commits', 'Record check cost', 'Cost history export', 'Modal cost estimate tracks spend', 'Rate-limit the sync endpoint', 'Record delta after Work format change', 'Retain check outcome', 'Repair notices carry check evidence', 'Accepted source', 'Owner-lock reads outside the writer', 'Shared types', 'Use shared types'];
  const work = { revision: 1, intents: [{ id: 'intent', outcome: 'Landing speed', constraints: '', status: 'active', createdAt: at('00'), notes: [] }], lanes: [], views: [], runs: [], channelMoves: [], landingEntries: [], landingBatches: [] };
  for (const [index, state] of states.entries()) {
    const id = state;
    const head = heads[index];
    const changed = state === 'later' || state === 'dirty';
    work.lanes.push({ id, name: names[index], head: changed ? 'e'.repeat(64) : head, base: '0'.repeat(64), state: 'active', intentId: 'intent', assignment: '', checkpoints: [{ head, at: at('11'), message: 'Saved' }, ...(changed ? [{ head: 'd'.repeat(64), at: at('41'), message: 'Saved again' }, { head: 'e'.repeat(64), at: at('42'), message: 'Saved again' }] : [])], ...(state === 'dependency' ? { stack: { laneId: 'parent', head: heads[10] } } : {}) });
    work.views.push({ id: `view-${id}`, intentId: 'intent', base: '0'.repeat(64), head, status: 'clean', at: at('12'), inputs: [{ laneId: id, head }], dependencies: [] });
    if (state === 'parent') continue;
    const entryStatus = state === 'queued' || state === 'dependency' ? 'queued' : state === 'review' ? 'awaiting-review' : state === 'checking' || state === 'machine' ? 'checking' : ['landed', 'dirty'].includes(state) ? 'accepted' : state === 'infra' ? 'interrupted' : state === 'later' ? 'awaiting-review' : 'failed';
    work.landingEntries.push({ id: `entry-${id}`, channel: 'main', viewId: `view-${id}`, head, status: entryStatus, arrivedAt: at('23'), ...(!['queued', 'dependency'].includes(state) ? { runId: `run-${id}` } : {}), ...(['landed', 'dirty'].includes(state) ? { acceptanceId: `move-${id}` } : {}) });
    if (!['queued', 'dependency'].includes(state)) work.runs.push({ id: `run-${id}`, viewId: `view-${id}`, head, check: { name: 'build-and-test' }, status: state === 'machine' ? 'interrupted' : state === 'checking' ? 'running' : state === 'infra' ? 'interrupted' : ['failed', 'unknown'].includes(state) ? 'failed' : 'passed', exitCode: state === 'unknown' ? null : state === 'failed' ? 1 : 0, startedAt: at('24'), ...(!['checking', 'machine'].includes(state) ? { endedAt: at('31') } : {}), ...(state === 'machine' ? { error: { code: 'GITHUB_ACTIONS_PENDING_INFRA' } } : {}) });
    if (['landed', 'dirty'].includes(state)) work.channelMoves.push({ id: `move-${id}`, viewId: `view-${id}`, head, channel: 'main', status: 'accepted', at: at('40'), automatic: { summary: 'Accepted automatically', undo: 'Revert this acceptance in a Lane.' } });
  }
  return work;
}
export function s16Notice(work, applicability = 'current') {
  const lane = work.lanes.find(lane => lane.id === 'failed');
  return { noticeId: `notice-${applicability}`, kind: 'conflict-notice', applicability, repairIntentId: 'repair', participants: [{ lane: lane.id, head: lane.head }], evidence: [{ kind: 'check', runId: 'run-failed', viewId: 'view-failed', status: 'failed', cause: 'check-failed', main: '0'.repeat(64) }], conflicts: [] };
}
