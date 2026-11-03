// SPDX-License-Identifier: Apache-2.0
import { localApplyBlocked } from './hosted-apply-recovery-records.js';
import { checkoutHostedLane, type LaneTransport } from './hosted-lane-checkout.js';
import { ForgeError, invariant } from './errors.js';
import { applySchema } from './hosted-sync-contract.js';
export { applySchema } from './hosted-sync-contract.js';
/** An explicit, bounded apply. Original checkout receipt guards both the old
 * client marker and exact new server pins; later on-disk edits survive retries. */
export async function applyHostedSync(root: string, input: unknown, transport: LaneTransport) {
  const request = applySchema.parse(input),
    { from, lane } = request;
  invariant(
    from.laneId === lane.laneId,
    'WORK_OPERATION_CHANGED',
    'Apply sync to its original Lane checkout.',
  );
  try {
    return await checkoutHostedLane(
      root,
      {
        operationId: request.operationId,
        url: request.url,
        projectId: lane.projectId,
        laneId: lane.laneId,
        previous: { head: from.head, version: from.version, sourceVersion: from.sourceVersion },
        expected: { head: lane.head, version: lane.version, sourceVersion: lane.sourceVersion },
        // Preserve sparse scope. [] expands nothing and retains earlier scope roots.
        paths: [],
      },
      transport,
    );
  } catch (error) {
    if (
      error instanceof ForgeError &&
      (error.code === 'WORK_CONFLICT' || (error.code === 'WORK_STALE' && error.recovery?.obstruction))
    )
      throw localApplyBlocked(root, request, error);
    throw error;
  }
}
