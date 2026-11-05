// SPDX-License-Identifier: Apache-2.0
// Pause-exempt, exact-manifest row removal; no storage delete or R2 operation.
import { maintenanceInternalMutation as internalMutation, internalQuery } from './server';
import { v } from 'convex/values';
import { benchTables, benchOwnershipSchema, approvedBenchCounts } from './legacyStorageBenchScope';
import { cleanupReceipt, recordCleanup, recentCleanup } from './legacyStorageReceipts';
import { requireCleanupWindow } from './legacyStoragePause';
import { maintenanceEnabled } from './r2Maintenance';
import schema from './schema';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';
export const deletePage = internalMutation({
  args: {
    operationId: v.string(),
    part: v.string(),
    projectId: v.id('hostedProjects'),
    manifestSha256: v.string(),
    table: v.union(...benchTables.map(t => v.literal(t))),
    backup: v.object({
      run: v.literal(41887010710),
      successful: v.literal(true),
      includeFileStorage: v.literal(true),
      checkedAt: v.string(),
    }),
    pins: v.array(
      v.object({
        id: v.string(),
        sha256: v.string(),
        bytes: v.number(),
        ownerProjectId: v.id('hostedProjects'),
      }),
    ),
  },
  returns: v.object({ deleted: v.number(), jsonBytes: v.number() }),
  handler: async (ctx, args) => {
    const request = digest(JSON.stringify(args)),
      old = await cleanupReceipt(ctx, args.operationId, args.part, request);
    if (old) return old;
    const pause = await requireCleanupWindow(ctx, args.operationId);
    maintenanceEnabled();
    invariant(
      recentCleanup(args.backup.checkedAt, pause.startedAt, 5 * 60_000),
      'LEGACY_STORAGE_BACKUP_REQUIRED',
      'Recheck the successful file-inclusive backup.',
    );
    const ownerField = benchOwnershipSchema(args.table),
      project = await ctx.db.get(args.projectId);
    invariant(
      project?.removal === 'deleted',
      'LEGACY_BENCH_PROJECT_CHANGED',
      'The approved project must remain deleted.',
    );
    invariant(
      /^[a-f0-9]{64}$/.test(args.manifestSha256) &&
        args.pins.length > 0 &&
        args.pins.length <= 1000 &&
        new Set(args.pins.map(p => p.id)).size === args.pins.length &&
        args.pins.reduce((n, p) => n + p.bytes, 0) <= 2_000_000,
      'BAD_ARGUMENT',
      'Use a unique bounded approved row page.',
    );
    if (args.table === 'hostedProjects')
      invariant(
        args.pins.length === 1 && args.pins[0]?.id === args.projectId,
        'LEGACY_BENCH_OWNER_CHANGED',
        'Only the approved root may be removed.',
      );
    const rows = [];
    for (const pin of args.pins) {
      const id = ctx.db.normalizeId(args.table, pin.id),
        row = id ? await ctx.db.get(id) : null;
      const owner = row && (ownerField === '_id' ? row._id : 'projectId' in row ? row.projectId : null);
      const json = JSON.stringify(row);
      invariant(
        row &&
          owner === args.projectId &&
          pin.ownerProjectId === args.projectId &&
          digest(json) === pin.sha256 &&
          new TextEncoder().encode(json).length === pin.bytes,
        'LEGACY_BENCH_OWNER_CHANGED',
        'A row owner or exact approved row changed; retain the page.',
      );
      rows.push(row);
    }
    // Validate the whole page before the first delete; Convex commits it atomically.
    for (const row of rows) await ctx.db.delete(row._id);
    const result = { deleted: rows.length, jsonBytes: args.pins.reduce((n, p) => n + p.bytes, 0) };
    await recordCleanup(ctx, args.operationId, args.part, request, result);
    return result;
  },
});

/** One bounded ownership/index description for the approved 58-table manifest. */
export const describe = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      table: v.string(),
      rows: v.number(),
      ownerField: v.string(),
      index: v.union(v.string(), v.null()),
    }),
  ),
  handler: async () =>
    benchTables.map(table => {
      const indexes = schema.tables[table][' indexes']().filter(i => i.fields[0] === 'projectId');
      return {
        table,
        rows: approvedBenchCounts[table],
        ownerField: benchOwnershipSchema(table),
        index:
          indexes.find(i => i.indexDescriptor === 'by_project')?.indexDescriptor ??
          indexes[0]?.indexDescriptor ??
          null,
      };
    }),
});
