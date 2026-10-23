// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import { noticeParticipant } from './agent-conflict-notice.js';
import type { Lane } from './work-types.js';
import type { WorkStore } from './work-store.js';
import type { PeersSource } from './agent-peers-source.js';
import type { PreviewResult } from './integration-preview.js';
import type { PreviewObservation } from './integration-preview-checks.js';

/** Only observed failures with passing same-plan controls establish interaction.
 * Deletion minimization is advisory, never a claim of global minimality. */
export function diagnosePreview(
  result: PreviewResult,
  lanes: Lane[],
  evaluate: (lanes: Lane[]) => PreviewObservation,
  store: WorkStore,
  source: PeersSource,
) {
  result.combined = evaluate(lanes);
  result.status =
    result.combined.status === 'passed'
      ? 'clean'
      : result.combined.status === 'text-conflict'
        ? 'text-conflict'
        : result.combined.status === 'inconclusive'
          ? 'inconclusive'
          : 'failed';
  if (result.combined.status !== 'failed') return;
  result.baseline = evaluate([]);
  if (result.baseline.status !== 'passed') {
    result.status = result.baseline.status === 'failed' ? 'baseline-failed' : 'inconclusive';
    return;
  }
  result.individual = lanes.map(lane => ({ laneId: lane.id, result: evaluate([lane]) }));
  const passing = lanes.filter(lane => evaluate([lane]).status === 'passed');
  const interaction = (group: Lane[], observed: PreviewObservation) => {
    const laneIds = group.map(lane => lane.id),
      noticeId = digest(JSON.stringify([result.key, laneIds, observed]));
    const failure = { laneIds, heads: group.map(lane => lane.head), errors: observed.errors, noticeId };
    result.interactions.push({ ...failure, minimization: 'incomplete' });
    if (group.length === 2) result.pairs.push(failure);
    result.notices.push({
      noticeId,
      kind: 'conflict-notice',
      granularity: 'symbol',
      participants: group.map(lane => noticeParticipant(store, source, lane)),
      proposedOrder: [],
      choices: [],
      conflicts: [],
      reason: `Integration preview: Lanes ${laneIds.join(' and ')} pass alone (with dependency closure) on main ${result.main} but fail together. Observed failing set; global minimization incomplete. ${observed.errors.join('\n')}`,
      integration: { main: result.main, key: result.key, inputs: result.inputs, errors: observed.errors },
    });
  };
  for (let i = 0; i < passing.length; i++)
    for (const right of passing.slice(i + 1)) {
      const pair = [passing[i]!, right],
        observed = evaluate(pair);
      if (observed.status === 'failed') interaction(pair, observed);
    }
  if (!result.pairs.length && passing.length === lanes.length) {
    let group = lanes;
    // Never discard the observed higher-order failure because every pair passed.
    for (const lane of lanes) {
      const subset = group.filter(item => item.id !== lane.id);
      if (subset.length > 1 && evaluate(subset).status === 'failed') group = subset;
    }
    if (group.length > 1) interaction(group, evaluate(group));
  }
  if (result.interactions.length) result.status = 'clash';
  else if (result.individual.some(item => item.result.status === 'inconclusive'))
    result.status = 'inconclusive';
}
