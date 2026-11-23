// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v, ConvexError } from 'convex/values';
import { action } from './cliServer';
import { CUTOVER_UPGRADE } from '../src/cutover-version';

// Retain the old RPC address so installed clients receive an actionable error.
export const returnSource = action({
  args: {
    projectId: v.id('hostedProjects'),
    backupId: v.id('projectBackups'),
    expectedBackupId: v.id('projectBackups'),
    revision: v.number(),
    operationId: v.string(),
    continuation: v.optional(v.boolean()),
    statusOnly: v.optional(v.boolean()),
    ownerDerived: v.optional(v.object({ sha256: v.string(), size: v.number() })),
  },
  returns: v.null(),
  handler: async () => {
    throw new ConvexError({ code: 'CLI_UPGRADE_REQUIRED', message: CUTOVER_UPGRADE });
  },
});
