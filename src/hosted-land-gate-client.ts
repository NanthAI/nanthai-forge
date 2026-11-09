// SPDX-License-Identifier: Apache-2.0
import { canonicalPayload } from './hosted-source-operation.js';
import { GATED_LANES, landGatesSchema, type LandGateEntry } from './hosted-land-gates.js';
import type { HostedAgentJournal } from './hosted-agent-journal.js';

/** The Lanes and heads one finish composed, from the compose request its journal retains (no call).
 * Empty when this operation did not compose (a named Candidate from another operation). */
export function composedLanes(journal: HostedAgentJournal, composeOperationId: string) {
  const prepared = journal.get<{ pages?: { kind?: string; value?: { entries?: unknown[] } }[] }>(
    `compose:${composeOperationId}`,
  );
  const lanes: { laneId: string; head: string }[] = [];
  for (const page of prepared?.pages ?? [])
    if (page.kind === 'inputs')
      for (const entry of page.value?.entries ?? []) {
        const { laneId, head } = entry as { laneId?: unknown; head?: unknown };
        if (typeof laneId === 'string' && typeof head === 'string') lanes.push({ laneId, head });
      }
  return lanes.slice(0, GATED_LANES);
}

/** The `gates` argument for a landing (feature land-gates, Issue 029138ef): one entry per composed
 * Lane head, no call. The checkout's saved head carries its finish-gate preflight result; any other
 * Lane (landed by id, a resolution, a named Candidate) has nothing local to test. */
export function landGatesArgument(
  lanes: { laneId: string; head: string }[],
  gated: LandGateEntry | undefined,
) {
  if (!lanes.length) return undefined;
  const entries = lanes.map(lane =>
    gated && gated.laneId === lane.laneId && gated.head === lane.head
      ? gated
      : { ...lane, preflight: 'no-checkout' as const },
  );
  return canonicalPayload(landGatesSchema.parse({ lanes: entries }));
}
