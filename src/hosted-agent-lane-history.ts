// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { invariant } from './errors.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import type { HostedAgentTransport } from './hosted-agent-transport.js';

export const hostedLaneHistorySchema = z.object({ laneId: z.uuid().optional() }).strict();
/** One Lane's open time, first and last synced base and landing (Issue b78ca196), from stored rows. */
export async function laneHistoryHostedSource(transport: HostedAgentTransport, input: unknown) {
  const parsed = hostedLaneHistorySchema.safeParse(input);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    'Invalid hosted lane-history parameters. Use lane-history --help.',
  );
  const laneId = parsed.data.laneId ?? readHostedLaneCheckout(transport.root)?.selection.laneId;
  invariant(laneId, 'BAD_ARGUMENT', 'Select laneId or open a hosted Lane.');
  return transport.query('projectHostedLaneHistory:read', { laneId });
}
