// SPDX-License-Identifier: Apache-2.0
import { mutation } from './cliServer';
import { ConvexError, v } from 'convex/values';
import { CUTOVER_UPGRADE } from '../src/cutover-version';

// Keep RPC addresses for installed clients; the owner relay no longer runs.
export const publish = mutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), metadata: v.string() },
  returns: v.null(),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
