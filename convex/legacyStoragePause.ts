// SPDX-License-Identifier: Apache-2.0
import { invariant } from '../src/errors';
import type { MutationCtx } from './_generated/server';

export const pauseFlag = 'FORGE_LEGACY_STORAGE_PAUSE';
export type StoragePause = { deployment: string; operationId: string; startedAt: number; expiresAt: number };
/** No DB calls and no idle work. Invalid/expired configuration never authorizes cleanup. */
export function configuredStoragePause(now = Date.now()): StoragePause | null {
  const value = process.env[pauseFlag];
  if (!value) return null;
  let pause: StoragePause;
  try {
    pause = JSON.parse(value);
  } catch {
    return null;
  }
  if (!pause || typeof pause !== 'object' || Array.isArray(pause)) return null;
  if (
    !/^dev:[a-z0-9-]+$/.test(pause.deployment) ||
    process.env.CONVEX_CLOUD_URL !== `https://${pause.deployment.slice(4)}.convex.cloud` ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(pause.operationId) ||
    !Number.isSafeInteger(pause.startedAt) ||
    !Number.isSafeInteger(pause.expiresAt) ||
    pause.startedAt > now ||
    pause.expiresAt - pause.startedAt > 30 * 60_000 ||
    pause.expiresAt <= pause.startedAt
  )
    return null;
  return pause;
}
export function activeStoragePause(now = Date.now()): StoragePause | null {
  const pause = configuredStoragePause(now);
  return pause && pause.expiresAt > now ? pause : null;
}
export function storageWritesAvailable() {
  invariant(
    !activeStoragePause(),
    'LEGACY_STORAGE_WRITES_PAUSED',
    'Dev writes are temporarily paused for approved storage maintenance.',
  );
}
export function requireStoragePause(operationId: string) {
  const pause = activeStoragePause();
  invariant(
    pause?.operationId === operationId,
    'LEGACY_STORAGE_PAUSE_REQUIRED',
    'Use the current approved dev storage maintenance window.',
  );
  return pause;
}

/** Only an expired configured window adds DB work to an ordinary mutation.
 * Its first resumed writer closes the fence in the same transaction, invalidating
 * any older cleanup transaction before it can publish a new reference. */
export async function storageMutationAvailable(ctx: MutationCtx) {
  storageWritesAvailable();
  const pause = configuredStoragePause();
  if (!pause || pause.expiresAt > Date.now()) return;
  const window = await ctx.db
    .query('legacyStorageCleanupWindows')
    .withIndex('by_operation', q => q.eq('operationId', pause.operationId))
    .unique();
  if (window?.active) await ctx.db.patch(window._id, { active: false, endedAt: Date.now() });
}
/** The indexed read is part of every destructive transaction's OCC read set. */
export async function requireCleanupWindow(ctx: MutationCtx, operationId: string) {
  const pause = requireStoragePause(operationId);
  const window = await ctx.db
    .query('legacyStorageCleanupWindows')
    .withIndex('by_operation', q => q.eq('operationId', operationId))
    .unique();
  invariant(
    window?.active &&
      window.deployment === pause.deployment &&
      window.startedAt === pause.startedAt &&
      window.expiresAt === pause.expiresAt,
    'LEGACY_STORAGE_WINDOW_ENDED',
    'The cleanup transaction fence is closed.',
  );
  return pause;
}
