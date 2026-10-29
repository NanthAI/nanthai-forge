// SPDX-License-Identifier: Apache-2.0
import { v, ConvexError } from 'convex/values';
import { mutation } from './cliServer';
import { CUTOVER_UPGRADE } from '../src/cutover-version';

// Compatibility only: old clients must receive a structured upgrade error.
export const supersede = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    pushOperationId: v.string(),
    expectedBackupId: v.id('projectBackups'),
    revision: v.number(),
    replacementId: v.string(),
  },
  returns: v.null(),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
