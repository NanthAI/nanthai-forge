// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { internalMutation } from './server';
import { activeOwnedProject } from './projectAuthority';
import { seedRow } from './projectHostedSeedObjects';
import { seedWorkBytes, seedWorkRows } from './projectHostedSeedWorkLimits';
import { recordHead } from './projectHostedRecords';
import { storeIntent, storeVersion } from './projectWorkStore';
import { hostedRecordValue } from '../src/hosted-records';
import { seedRequestSchema } from '../src/hosted-seed-protocol';
import { invariant } from '../src/errors';
import { requireSourceAuthority } from '../src/hosted-source-authority';
import { workStoreRecord, workStoreSources, type WorkStoreSource } from '../src/work-store-records';

const fragmentAt = (number: number) => -number - 1;

export const stage = internalMutation({
  args: {
    backupId: v.optional(v.id('projectBackups')),
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    operationId: v.string(),
    digest: v.string(),
    next: v.number(),
    total: v.number(),
    body: v.string(),
    fragment: v.optional(v.number()),
    final: v.optional(v.boolean()),
  },
  returns: v.object({ digest: v.string(), total: v.number(), next: v.number(), fragment: v.number() }),
  handler: async (ctx, input) => {
    const project = await activeOwnedProject(ctx, input.projectId, input.owner);
    if (input.backupId) return stageStoredBackup(ctx, project, { ...input, backupId: input.backupId });
    const seed = await seedRow(ctx, input.projectId);
    invariant(
      seed && seed.owner === input.owner && seed.operationId === input.operationId && !seed.aborting,
      'WORK_OPERATION_CHANGED',
      'Resume the original Work import operation.',
    );
    const request = seedRequestSchema.parse(JSON.parse(seed.request));
    invariant(
      request.work.sha256 === input.digest && seed.nextPage === request.pages && seed.chain === request.chain,
      'INVALID_WORK_BACKUP',
      'Complete the verified seed pages before importing Work.',
    );
    const progress = seed.workImport ?? { digest: input.digest, total: input.total, next: 0, fragment: 0 };
    invariant(
      progress.digest === input.digest &&
        progress.total === input.total &&
        Number.isSafeInteger(input.total) &&
        input.total >= 0,
      'WORK_OPERATION_CHANGED',
      'Resume at the original Work snapshot and record count.',
    );
    if (
      progress.next > input.next ||
      (progress.next === progress.total && seed.workImport) ||
      (progress.next === input.next && (input.fragment ?? 0) < progress.fragment)
    )
      return progress;
    invariant(
      !project.currentBackup && project.revision === seed.projectRevision,
      'CHANNEL_CHANGED',
      'Selected source moved after seed start.',
    );
    invariant(
      !seed.backupId &&
        progress.next === input.next &&
        progress.fragment === (input.fragment ?? 0) &&
        new TextEncoder().encode(input.body).length <= seedWorkBytes,
      'WORK_OPERATION_CHANGED',
      'Write only the next bounded page of the unselected seed.',
    );
    requireSourceAuthority(project, seed.authority);

    const rows = await workPage(ctx, seed._id, input);
    if (!rows) {
      const next = { ...progress, fragment: progress.fragment + 1 };
      await ctx.db.patch(seed._id, { workImport: next });
      return next;
    }
    await writeRows(ctx, project._id, project.owner, progress, rows);
    const next = { ...progress, next: progress.next + rows.length, fragment: 0 };
    await ctx.db.patch(seed._id, { workImport: next });
    return next;
  },
});

type WorkRow = { collection: WorkStoreSource; value: string; bound?: true };
type Progress = { digest: string; total: number; next: number; fragment: number };
async function writeRows(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  progress: Progress,
  rows: WorkRow[],
) {
  invariant(
    Array.isArray(rows) &&
      rows.length <= seedWorkRows &&
      progress.next + rows.length <= progress.total &&
      (rows.length > 0 || progress.total === 0),
    'INVALID_WORK_BACKUP',
    'The Work import page exceeds its pinned record count.',
  );
  for (const row of rows) {
    invariant(workStoreSources.includes(row.collection), 'INVALID_WORK_BACKUP', 'Unknown Work collection.');
    const value: unknown = JSON.parse(row.value);
    if (row.collection === 'intents') {
      const result = await storeIntent(ctx, projectId, owner, value, true, undefined, {
        migrationDigests: false,
        bound: row.bound === true,
      });
      invariant(
        result === 'copied' || result === 'same' || result === 'hosted',
        'WORK_OPERATION_CHANGED',
        'An Intent has already been claimed.',
      );
    } else {
      const encoded = hostedRecordValue(workStoreRecord(row.collection, value));
      const result = await storeVersion(
        ctx,
        { _id: projectId, workStore: 'records' },
        encoded,
        undefined,
        false,
      );
      invariant(
        result !== 'different',
        'WORK_OPERATION_CHANGED',
        'A Work record has different stored bytes.',
      );
    }
  }
}

async function stageStoredBackup(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  input: Omit<Progress, 'fragment'> & {
    backupId: Id<'projectBackups'>;
    operationId: string;
    body: string;
    fragment?: number;
    final?: boolean;
  },
) {
  const backup = await ctx.db.get(input.backupId);
  invariant(
    backup?.projectId === project._id &&
      backup.status === 'stored' &&
      project.currentBackup === backup._id &&
      !project.work,
    'WORK_OPERATION_CHANGED',
    'Resume initialization of the selected, stored backup.',
  );
  const progress = backup.initialWorkImport ?? {
    operationId: input.operationId,
    digest: input.digest,
    total: input.total,
    next: 0,
    fragment: 0,
  };
  invariant(
    progress.operationId === input.operationId &&
      progress.digest === input.digest &&
      progress.total === input.total &&
      Number.isSafeInteger(input.total) &&
      input.total >= 0,
    'WORK_OPERATION_CHANGED',
    'Resume the original Work initialization.',
  );
  const current = {
    digest: progress.digest,
    total: progress.total,
    next: progress.next,
    fragment: progress.fragment,
  };
  if (
    progress.next > input.next ||
    (progress.next === progress.total && backup.initialWorkImport) ||
    (progress.next === input.next && (input.fragment ?? 0) < progress.fragment)
  )
    return current;
  invariant(
    progress.next === input.next &&
      progress.fragment === (input.fragment ?? 0) &&
      new TextEncoder().encode(input.body).length <= seedWorkBytes,
    'WORK_OPERATION_CHANGED',
    'Write only the next bounded page of the stored backup.',
  );
  const rows = await workPage(ctx, backup._id, { ...input, projectId: project._id });
  if (!rows) {
    const next = { ...current, fragment: current.fragment + 1 };
    await ctx.db.patch(backup._id, { initialWorkImport: { ...next, operationId: input.operationId } });
    return next;
  }
  await writeRows(ctx, project._id, project.owner, current, rows);
  const next = { ...current, next: current.next + rows.length, fragment: 0 };
  await ctx.db.patch(backup._id, { initialWorkImport: { ...next, operationId: input.operationId } });
  return next;
}

/** Large records share the bounded fragment store for seed and archive initialization. */
async function workPage(
  ctx: MutationCtx,
  seedId: Id<'projectHostedSeeds'> | Id<'projectBackups'>,
  input: {
    projectId: Id<'hostedProjects'>;
    digest: string;
    body: string;
    fragment?: number;
    final?: boolean;
  },
): Promise<WorkRow[] | null> {
  if (input.fragment === undefined) return JSON.parse(input.body);
  if (!input.final) {
    await ctx.db.insert('projectHostedSeedPages', {
      projectId: input.projectId,
      seedId,
      index: fragmentAt(input.fragment),
      body: input.body,
      previous: input.digest,
      chain: input.digest,
    });
    return null;
  }
  const fragments = await ctx.db
    .query('projectHostedSeedPages')
    .withIndex('by_seed_and_index', q => q.eq('seedId', seedId).lt('index', 0))
    .order('desc')
    .take(input.fragment + 1);
  invariant(
    fragments.length === input.fragment &&
      fragments.every((part, index) => part.index === fragmentAt(index) && part.chain === input.digest),
    'WORK_OPERATION_CHANGED',
    'Resume the original fragments of this Work record.',
  );
  const row = JSON.parse(fragments.map(part => part.body).join('') + input.body);
  for (const part of fragments) await ctx.db.delete(part._id);
  return [row];
}

/** No Work reads have been selected. Remove just the canonical rows written by this fresh seed
 * before allowing the existing abort path to release its reservation. */
export async function abortSeedWork(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const rows = await ctx.db
    .query('projectHostedRecords')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .take(8);
  for (const row of rows) {
    const head = await recordHead(ctx, projectId, row.kind, row.key);
    if (head?.recordId === row._id) await ctx.db.delete(head._id);
    await ctx.db.delete(row.bodyId);
    await ctx.db.delete(row._id);
  }
  return rows.length;
}
