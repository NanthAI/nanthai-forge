// SPDX-License-Identifier: Apache-2.0
// The only pause-exempt mutations. Every write below requires the exact active
// dev pause, pinned bodies, complete frozen reference coverage and retry identity.
import { maintenanceInternalMutation as internalMutation, internalQuery } from './server';
import { v, type Infer } from 'convex/values';
import type { QueryCtx } from './server';
import type { Id } from './_generated/dataModel';
import { cleanupPin, cleanupResult } from './legacyStorageCleanupFields';
import { requireCleanupWindow, activeStoragePause } from './legacyStoragePause';
import { storageDigest } from './storageDigest';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';
import schema from './schema';
import {
  cleanupReceipt as receipt,
  recordCleanup as record,
  recentCleanup as recent,
} from './legacyStorageReceipts';
import { maintenanceEnabled } from './r2Maintenance';

const identity = { operationId: v.string(), part: v.string() };
const coverage = v.object({
  pauseOperationId: v.string(),
  startedAt: v.string(),
  finishedAt: v.string(),
  fullyPaged: v.literal(true),
  tables: v.array(v.string()),
  sha256: v.string(),
  bodyCoverage: v.object({
    complete: v.literal(true),
    sha256: v.string(),
    catalogDigest: v.string(),
    rootDigest: v.string(),
    checkedAt: v.string(),
  }),
});
const backup = v.object({
  run: v.literal(41887010710),
  successful: v.literal(true),
  includeFileStorage: v.literal(true),
  checkedAt: v.string(),
});
/** Keep every existing indexed guard, including the original archive alias path.
 * Frozen all-table coverage handles unindexed/nested source/task/Work references. */
async function indexedReferences(ctx: QueryCtx, storageId: Id<'_storage'>) {
  return (
    await Promise.all([
      ctx.db
        .query('projectObjects')
        .withIndex('by_storage', q => q.eq('storageId', storageId))
        .take(3),
      ctx.db
        .query('projectBackups')
        .withIndex('by_storage', q => q.eq('storageId', storageId))
        .take(3),
      ctx.db
        .query('projectProposals')
        .withIndex('by_storage', q => q.eq('storageId', storageId))
        .take(3),
      ctx.db
        .query('projectBackups')
        .withIndex('by_archive_storage', q => q.eq('archiveReceipt.storageId', storageId))
        .take(3),
      ctx.db
        .query('imports')
        .withIndex('by_artifactKey', q => q.eq('artifactKey', storageId))
        .take(3),
      ctx.db
        .query('importArtifacts')
        .withIndex('by_artifactKey', q => q.eq('artifactKey', storageId))
        .take(3),
    ])
  ).flat();
}
type Pin = Infer<typeof cleanupPin>;
/** The single per-file delete guard. deletePage evaluates it inside the pause;
 * planPage evaluates the same code read-only in the dry run, so plan and delete
 * cannot disagree on any data check. Last failing check wins (stable codes). */
async function pinExclusion(ctx: QueryCtx, pin: Pin, recheckSince: number) {
  const file = await ctx.db.system.get(pin.storageId);
  // No absent-file success without an original committed page receipt.
  let code: string | null = !file
    ? 'FILE_ABSENT'
    : file.size !== pin.size || storageDigest(file.sha256) !== pin.digest
      ? 'FILE_CHANGED'
      : null;
  // Class 4 has no R2 copy to recheck; its approved manifest pins Convex metadata only.
  if (
    !recent(pin.verifiedAt, 0, 86400_000) ||
    (pin.class !== 4 &&
      (!pin.keys.length || pin.keys.some(k => !k.startsWith('v1/') || k.split('/').at(-1) !== pin.digest)))
  )
    code = 'FULL_DIGEST_REQUIRED';
  if (pin.class !== 1 && pin.owners.length) code = 'REFERENCE_REMAINS';
  if (!recent(pin.recheckedAt, recheckSince, 5 * 60_000)) code = 'R2_HEAD_REQUIRED';
  const refs = await indexedReferences(ctx, pin.storageId);
  if (refs.length !== pin.owners.length || refs.some(r => !pin.owners.some(o => o.id === r._id)))
    code = 'REFERENCE_CHANGED';
  const owners = [];
  let unset = false;
  for (const owner of pin.owners) {
    const id = ctx.db.normalizeId(owner.table, owner.id),
      row = id ? await ctx.db.get(id) : null;
    if (
      !row ||
      row.storageId !== pin.storageId ||
      row.digest !== pin.digest ||
      row.size !== pin.size ||
      row.location !== 'r2' ||
      !row.r2Committed ||
      row.r2ConvexPurged ||
      !pin.keys.includes(row.r2Key ?? '') ||
      row.r2Key !== `v1/p/${row.projectId}/o/${pin.digest}`
    )
      code = 'OWNER_CHANGED';
    else if (row.r2BackfilledAt === undefined) unset = true;
    else if (row.r2BackfilledAt > Date.parse(pin.verifiedAt)) code = 'OWNER_CHANGED';
    if (row) owners.push(row);
  }
  // R2-native rows (inserted already committed) never got a backfill time. Report
  // it apart only when nothing else fails, so the bounded owner-scoped repair
  // (projectLegacyStorageRepair) can record it after a fresh R2 digest check.
  if (unset) code ??= 'OWNER_BACKFILL_UNSET';
  return { code, owners };
}
export const deletePage = internalMutation({
  args: {
    ...identity,
    scopeSha256: v.string(),
    scan: coverage,
    backup,
    pins: v.array(cleanupPin),
    class4Sha256: v.optional(v.string()),
  },
  returns: cleanupResult,
  handler: async (ctx, args) => {
    const request = digest(new TextEncoder().encode(JSON.stringify(args)));
    const old = await receipt(ctx, args.operationId, args.part, request);
    if (old) return old;
    const pause = await requireCleanupWindow(ctx, args.operationId);
    maintenanceEnabled();
    invariant(
      args.scan.pauseOperationId === args.operationId &&
        recent(args.scan.startedAt, pause.startedAt, 30 * 60_000) &&
        recent(args.scan.finishedAt, Date.parse(args.scan.startedAt), 30 * 60_000) &&
        Object.keys(schema.tables).every(t => args.scan.tables.includes(t)) &&
        /^[a-f0-9]{64}$/.test(args.scan.sha256) &&
        args.scan.bodyCoverage.complete === true &&
        [
          args.scan.bodyCoverage.sha256,
          args.scan.bodyCoverage.catalogDigest,
          args.scan.bodyCoverage.rootDigest,
        ].every(s => /^[a-f0-9]{64}$/.test(s)) &&
        recent(args.scan.bodyCoverage.checkedAt, Date.parse(args.scan.finishedAt), 30 * 60_000) &&
        /^[a-f0-9]{64}$/.test(args.scopeSha256),
      'LEGACY_STORAGE_COVERAGE_REQUIRED',
      'Complete every deployment table and recursive cursor body in this same write pause.',
    );
    invariant(
      recent(args.backup.checkedAt, pause.startedAt, 5 * 60_000),
      'LEGACY_STORAGE_BACKUP_REQUIRED',
      'Recheck successful file-inclusive backup 41887010710 immediately before deletion.',
    );
    invariant(
      args.pins.length > 0 &&
        args.pins.length <= 100 &&
        args.pins.every(
          p =>
            p.class === 1 ||
            p.class === 2 ||
            p.class === 3 ||
            (p.class === 4 &&
              /^[a-f0-9]{64}$/.test(args.class4Sha256 ?? '') &&
              p.keys.length === 0 &&
              p.owners.length === 0),
        ) &&
        new Set(args.pins.map(p => p.storageId)).size === args.pins.length &&
        args.pins.every(
          p => p.owners.length <= 2 && new Set(p.owners.map(o => o.id)).size === p.owners.length,
        ),
      'BAD_ARGUMENT',
      'Use a unique bounded file page.',
    );
    const result = {
      deleted: 0,
      bytes: 0,
      changedRows: 0,
      excluded: [] as { storageId: string; code: string }[],
    };
    for (const pin of args.pins) {
      const { code, owners } = await pinExclusion(ctx, pin, pause.startedAt);
      if (code) {
        result.excluded.push({ storageId: pin.storageId, code });
        continue;
      }
      // Never cascade into derived files outside the approved manifest.
      await ctx.storage.delete(pin.storageId);
      for (const row of owners) {
        await ctx.db.patch(row._id, { r2ConvexPurged: true });
        result.changedRows++;
      }
      result.deleted++;
      result.bytes += pin.size;
    }
    await record(ctx, args.operationId, args.part, request, result);
    return result;
  },
});
/** Read-only dry-run twin of deletePage: the same per-file guard on live rows,
 * with the call time standing in for the pause start. No window, scan or backup
 * checks (those exist only inside the pause). At most 100 pins, like a page. */
export const planPage = internalQuery({
  args: { pins: v.array(cleanupPin) },
  returns: v.array(v.object({ storageId: v.string(), code: v.string() })),
  handler: async (ctx, args) => {
    invariant(
      args.pins.length > 0 &&
        args.pins.length <= 100 &&
        new Set(args.pins.map(p => p.storageId)).size === args.pins.length,
      'BAD_ARGUMENT',
      'Use a unique bounded file page.',
    );
    const excluded = [];
    for (const pin of args.pins) {
      const { code } = await pinExclusion(ctx, pin, Date.now() - 5 * 60_000);
      if (code) excluded.push({ storageId: pin.storageId, code });
    }
    return excluded;
  },
});
export const migrateCursors = internalMutation({
  args: {
    ...identity,
    pins: v.array(
      v.object({
        id: v.id('projectSourceSteps'),
        storageId: v.id('_storage'),
        digest: v.string(),
        size: v.number(),
        key: v.string(),
        verifiedAt: v.string(),
      }),
    ),
  },
  returns: v.object({ changedRows: v.number() }),
  handler: async (ctx, args) => {
    const request = digest(new TextEncoder().encode(JSON.stringify(args)));
    const old = await receipt(ctx, args.operationId, args.part, request);
    if (old) return old;
    await requireCleanupWindow(ctx, args.operationId);
    invariant(args.pins.length <= 100, 'BAD_ARGUMENT', 'Use one migration page.');
    for (const pin of args.pins) {
      const row = await ctx.db.get(pin.id),
        file = await ctx.db.system.get(pin.storageId);
      invariant(
        row?.cursor === pin.storageId &&
          file?.size === pin.size &&
          storageDigest(file.sha256) === pin.digest &&
          pin.key === `v1/p/${row.projectId}/o/${pin.digest}` &&
          recent(pin.verifiedAt, 0, 86400_000),
        'LEGACY_STORAGE_CURSOR_CHANGED',
        'The verified legacy cursor pins changed.',
      );
      await ctx.db.patch(row._id, { cursor: `r2source:${pin.digest}:${pin.size}` });
    }
    const result = { changedRows: args.pins.length };
    await record(ctx, args.operationId, args.part, request, result);
    return result;
  },
});

/** Read-only deployment/quiet-window preflight; no configuration values leave it. */
export const status = internalQuery({
  args: { operationId: v.optional(v.string()) },
  returns: v.object({
    version: v.literal(2),
    paused: v.boolean(),
    pauseMatches: v.boolean(),
    sourceActive: v.number(),
  }),
  handler: async (ctx, args) => {
    const pools = await ctx.db
      .query('projectSourcePools')
      .withIndex('by_key', q => q.eq('key', 'source'))
      .take(2);
    return {
      version: 2 as const,
      paused: !!activeStoragePause(),
      pauseMatches: !!args.operationId && activeStoragePause()?.operationId === args.operationId,
      sourceActive: pools.reduce((sum, p) => sum + p.active.length, 0),
    };
  },
});
