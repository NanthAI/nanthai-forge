// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { checkoutHostedLane, type LaneTransport } from './hosted-lane-checkout.js';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import { hostedLaneExpectationSchema } from './hosted-lane-checkout-marker.js';
import { ForgeError, invariant } from './errors.js';
const applySchema = z
  .object({
    operationId: z.uuid(),
    url: z.url(),
    from: hostedLaneExpectationSchema.extend({ laneId: z.uuid() }).strict(),
    lane: hostedLaneSelectionSchema,
    status: z.enum(['merged', 'up-to-date', 'resolved']),
  })
  .strict();
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
    if (error instanceof ForgeError && error.code === 'WORK_CONFLICT')
      throw new ForgeError(
        error.code,
        `${error.message} Source already completed; only local apply is pending. Retry the same original operation after resolving this local obstruction.`,
      );
    throw error;
  }
}
