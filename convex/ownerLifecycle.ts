// SPDX-License-Identifier: Apache-2.0
import { mutation } from './cliServer';
import { ConvexError, v } from 'convex/values';
import { CUTOVER_UPGRADE } from '../src/cutover-version';

// Keep RPC addresses for installed clients; the owner relay no longer runs.
export const request = mutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), command: v.string() },
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
