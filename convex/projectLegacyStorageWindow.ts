// SPDX-License-Identifier: Apache-2.0
// Pause-exempt control only: no project/file deletion or application policy.
import { maintenanceInternalMutation as internalMutation } from './server';
import { v } from 'convex/values';
import { requireStoragePause, configuredStoragePause } from './legacyStoragePause';
import { invariant } from '../src/errors';
const args = { operationId: v.string() };
export const begin = internalMutation({
  args,
  returns: v.object({ active: v.literal(true) }),
  handler: async (ctx, { operationId }) => {
    const pause = requireStoragePause(operationId);
    const old = await ctx.db
      .query('legacyStorageCleanupWindows')
      .withIndex('by_operation', q => q.eq('operationId', operationId))
      .unique();
    invariant(
      !old || (old.active && old.startedAt === pause.startedAt && old.expiresAt === pause.expiresAt),
      'LEGACY_STORAGE_WINDOW_ENDED',
      'A closed window cannot be reopened.',
    );
    if (!old) await ctx.db.insert('legacyStorageCleanupWindows', { ...pause, active: true });
    return { active: true as const };
  },
});
export const end = internalMutation({
  args,
  returns: v.object({ ended: v.literal(true) }),
  handler: async (ctx, { operationId }) => {
    const pause = configuredStoragePause();
    invariant(
      !pause || pause.operationId === operationId,
      'LEGACY_STORAGE_WINDOW_CHANGED',
      'Resume the exact original window.',
    );
    const old = await ctx.db
      .query('legacyStorageCleanupWindows')
      .withIndex('by_operation', q => q.eq('operationId', operationId))
      .unique();
    invariant(
      !old ||
        (old.deployment.startsWith('dev:') &&
          process.env.CONVEX_CLOUD_URL === `https://${old.deployment.slice(4)}.convex.cloud`),
      'LEGACY_STORAGE_WINDOW_CHANGED',
      'Resume only the original dev deployment.',
    );
    if (old?.active) await ctx.db.patch(old._id, { active: false, endedAt: Date.now() });
    return { ended: true as const };
  },
});
