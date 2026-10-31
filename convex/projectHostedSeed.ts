// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, internalMutation, internalQuery } from './cliServer';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { activeOwnedProject } from './projectAuthority';
import { channelRow } from './projectHostedChannels';
import { isStored } from './projectObjectFields';
import { requireSourceAuthority, sourceAuthority } from '../src/hosted-source-authority';
import { canonicalPayload } from '../src/hosted-source-operation';
import { hostedMainV2Schema } from '../src/hosted-main';
import {
  seedRequestSchema,
  seedPageSchema,
  validateSeedPage,
  seedPageChain,
  SEED_EMPTY,
} from '../src/hosted-seed-protocol';
import { invariant } from '../src/errors';
import { report } from './errors';
import { findObject } from './projectObjectFind';

const identity = { projectId: v.id('hostedProjects'), operationId: v.string() };
async function caller(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to seed your project.');
  await activeOwnedProject(ctx, projectId, user.subject);
  return user.subject;
}
const rowFor = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHostedSeeds')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
const workHead = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectWorkHeads')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
const serialized = (value: unknown) => (value === null ? null : canonicalPayload(value));
const progress = (row: NonNullable<Awaited<ReturnType<typeof rowFor>>>) =>
  canonicalPayload({
    nextPage: row.nextPage,
    chain: row.chain,
    backupId: row.backupId ?? null,
    mainDigest: row.mainDigest ?? null,
  });

export const begin = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const owner = await caller(ctx, input.projectId),
        project = await activeOwnedProject(ctx, input.projectId, owner);
      const request = seedRequestSchema.parse(JSON.parse(input.request)),
        body = canonicalPayload(request);
      const old = await rowFor(ctx, input.projectId);
      if (old) {
        invariant(
          old.owner === owner && old.operationId === request.operationId && old.request === body,
          'WORK_OPERATION_CHANGED',
          'Resume this project’s original seed.',
        );
        return progress(old);
      }
      const main = await channelRow(ctx, input.projectId),
        journal = await workHead(ctx, input.projectId);
      invariant(
        !main && !project.currentBackup && !journal,
        'CHANNEL_CHANGED',
        'Seed a fresh hosted project without replacing selected work.',
      );
      const id = await ctx.db.insert('projectHostedSeeds', {
        projectId: input.projectId,
        owner,
        operationId: request.operationId,
        request: body,
        authority: sourceAuthority(project),
        previous: project.currentBackup,
        projectRevision: project.revision,
        journal: serialized(journal),
        mainSelection: null,
        nextPage: 0,
        objects: 0,
        chain: SEED_EMPTY,
        lastDigest: null,
      });
      return progress((await ctx.db.get(id))!);
    } catch (error) {
      return report(error);
    }
  },
});
export const inspect = internalQuery({
  args: { ...identity, owner: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.owner);
    const row = await rowFor(ctx, input.projectId);
    invariant(
      row && row.owner === input.owner && row.operationId === input.operationId,
      'WORK_OPERATION_CHANGED',
      'Select the original seed operation.',
    );
    return canonicalPayload(row);
  },
});
export const commitPage = internalMutation({
  args: { ...identity, owner: v.string(), index: v.number(), body: v.string(), previous: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.owner);
    const row = await rowFor(ctx, input.projectId);
    invariant(
      row && row.owner === input.owner && row.operationId === input.operationId,
      'WORK_OPERATION_CHANGED',
      'Select the original seed operation.',
    );
    const request = seedRequestSchema.parse(JSON.parse(row.request)),
      entries = seedPageSchema.parse(JSON.parse(input.body));
    validateSeedPage(entries);
    const body = canonicalPayload(entries),
      chain = seedPageChain(input.previous, input.index, entries);
    invariant(
      Number.isSafeInteger(input.index) && input.index >= 0 && input.index < request.pages,
      'BAD_ARGUMENT',
      'Select a page in the original seed.',
    );
    if (input.index < row.nextPage) {
      const old = await ctx.db
        .query('projectHostedSeedPages')
        .withIndex('by_seed_and_index', q => q.eq('seedId', row._id).eq('index', input.index))
        .unique();
      invariant(
        old?.body === body && old.previous === input.previous && old.chain === chain,
        'WORK_OPERATION_CHANGED',
        'Retry the original committed page.',
      );
      return progress(row);
    }
    invariant(
      !row.backupId && input.index === row.nextPage && input.previous === row.chain,
      'WORK_OPERATION_CHANGED',
      'Resume the last committed seed page.',
    );
    let last = row.lastDigest;
    for (const pin of entries) {
      invariant(
        last === null || pin.sha256 > last,
        'INVALID_WORK_BACKUP',
        'Seed objects must be unique and ordered across pages.',
      );
      last = pin.sha256;
      const stored = await findObject(ctx, input.projectId, pin.sha256);
      invariant(
        stored && !stored.removed && isStored(stored) && stored.size === pin.size,
        'INVALID_WORK_BACKUP',
        'A seed page has missing or mismatched committed bytes.',
      );
    }
    const next = {
      nextPage: row.nextPage + 1,
      objects: row.objects + entries.length,
      chain,
      lastDigest: last,
    };
    invariant(
      next.objects <= request.objects &&
        (next.nextPage !== request.pages ||
          (next.objects === request.objects && next.chain === request.chain)),
      'INVALID_WORK_BACKUP',
      'The complete seed differs from its pinned closure.',
    );
    await ctx.db.insert('projectHostedSeedPages', {
      projectId: input.projectId,
      seedId: row._id,
      index: input.index,
      body,
      previous: input.previous,
      chain,
    });
    await ctx.db.patch(row._id, next);
    return progress({ ...row, ...next });
  },
});
export const commit = internalMutation({
  args: {
    ...identity,
    owner: v.string(),
    mainDigest: v.union(v.string(), v.null()),
    validatedWorkRecords: v.optional(v.literal(1)),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const project = await activeOwnedProject(ctx, input.projectId, input.owner),
      row = await rowFor(ctx, input.projectId);
    invariant(
      row && row.owner === input.owner && row.operationId === input.operationId,
      'WORK_OPERATION_CHANGED',
      'Select the original seed operation.',
    );
    if (row.backupId) return progress(row);
    const request = seedRequestSchema.parse(JSON.parse(row.request));
    invariant(
      row.nextPage === request.pages && row.objects === request.objects && row.chain === request.chain,
      'INVALID_WORK_BACKUP',
      'Commit every validated seed page before selecting main.',
    );
    invariant(
      request.format !== 'native' || input.mainDigest === request.head,
      'SOURCE_HASH_MISMATCH',
      'Seeded hosted main differs from pinned native main.',
    );
    // The authority pinned at seed start must still hold (B1.2a writer fence).
    requireSourceAuthority(project, row.authority);
    invariant(
      project.currentBackup === row.previous &&
        project.revision === row.projectRevision &&
        serialized(await workHead(ctx, input.projectId)) === row.journal &&
        ((await channelRow(ctx, input.projectId))?.selection ?? null) === row.mainSelection,
      'CHANNEL_CHANGED',
      'Selected source or journal moved after seed start.',
    );
    const content = await findObject(ctx, input.projectId, request.root.sha256);
    invariant(
      content && isStored(content) && !content.removed && content.size === request.root.size,
      'INVALID_WORK_BACKUP',
      'The seed root is unavailable.',
    );
    const backupId = await ctx.db.insert('projectBackups', {
      projectId: input.projectId,
      operationId: input.operationId,
      request: row.request,
      nonce: content.nonce,
      previous: row.previous,
      digest: request.root.sha256,
      size: request.root.size,
      transport: 'objects',
      status: 'stored',
      validatedClosure: 1,
      ...(request.format === 'native' && input.validatedWorkRecords
        ? { validatedWorkRecords: 1 as const }
        : {}),
      ...(content.storageId ? { storageId: content.storageId } : {}),
      preview: {
        ...request.preview,
        format: request.format === 'native' ? 'native' : request.head.length === 40 ? 'sha1' : 'sha256',
        head: request.sourceHead,
        revision: request.revision,
        manifestDigest: request.manifest.sha256,
        channels: [{ name: 'main', head: request.head }],
      },
    });
    if (request.format === 'native') {
      const selected = hostedMainV2Schema.parse({
        schema: 2,
        projectId: input.projectId,
        snapshotId: input.operationId,
        sourceRevision: request.revision,
        authority: row.authority,
        channel: 'main',
        head: input.mainDigest,
        receipt: {
          id: request.receiptId ?? `bootstrap:${request.head}`,
          kind: 'native',
          previousHead: request.previousHead ?? null,
          previousReceiptId: request.previousReceiptId,
        },
      });
      invariant(
        selected.head === request.main?.sha256,
        'SOURCE_HASH_MISMATCH',
        'Hosted main must match native main exactly.',
      );
      await ctx.db.insert('projectHostedChannels', {
        projectId: input.projectId,
        operationId: input.operationId,
        name: 'main',
        selection: canonicalPayload(selected),
      });
    }
    await ctx.db.patch(project._id, { currentBackup: backupId, revision: project.revision + 1 });
    await ctx.db.patch(row._id, { backupId, ...(input.mainDigest ? { mainDigest: input.mainDigest } : {}) });
    return progress({ ...row, backupId, ...(input.mainDigest ? { mainDigest: input.mainDigest } : {}) });
  },
});
