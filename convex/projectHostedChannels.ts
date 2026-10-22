// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { z } from 'zod';
import { internalMutation, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { activeOwnedProject, accessibleProject } from './projectAuthority';
import { query } from './cliServer';
import { report } from './errors';
import { sourceAuthority } from '../src/hosted-source-authority';
import { hostedWriteProject } from './projectHostedRecords';
import { hostedMainV2Schema } from '../src/hosted-main';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { beginHostedOperation, finishHostedOperation } from './projectHostedOperations';
import { invariant } from '../src/errors';

export const channelRow = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectHostedChannels')
    .withIndex('by_project_and_name', q => q.eq('projectId', projectId).eq('name', 'main'))
    .unique();

/** Small authoritative lookup. No display fallback, full Work read or Channel history scan. */
export async function hostedStartMain(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const row = await channelRow(ctx, projectId);
  invariant(row, 'SOURCE_UNAVAILABLE', 'Authoritative hosted main has not been seeded.');
  const selected = hostedMainV2Schema.parse(JSON.parse(row.selection));
  invariant(
    selected.projectId === projectId,
    'SOURCE_UNAVAILABLE',
    'Hosted main belongs to another project.',
  );
  return selected;
}

/** Trusted cutover/bootstrap boundary only. Its caller supplies already validated
 * source pins; this does not validate source bytes or convert a native owner.
 * Seeding is insert-only and retryable. Landing will own later Channel CAS writes. */
export const seed = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    actor: v.string(),
    operationId: v.string(),
    selection: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    invariant(
      z.uuid().safeParse(input.operationId).success,
      'BAD_ARGUMENT',
      'Retain the seed operation UUID.',
    );
    await activeOwnedProject(ctx, input.projectId, input.actor);
    const selected = hostedMainV2Schema.parse(JSON.parse(input.selection));
    invariant(selected.projectId === input.projectId, 'SOURCE_UNAVAILABLE', 'Seed this project’s main.');
    const expected = {
      authorityEpoch: selected.authority.epoch,
      head: selected.head,
      receiptId: selected.receipt.id,
    };
    const payload = { action: 'seed-main', selection: selected };
    const prepared = await beginHostedOperation(ctx, {
      projectId: input.projectId,
      actor: input.actor,
      payload,
      request: {
        schema: 1,
        projectId: input.projectId,
        actor: input.actor,
        operationId: input.operationId,
        expected,
        payloadHash: hostedPayloadHash(payload, expected),
      },
      firstAttempt: {
        projectId: input.projectId,
        operationId: input.operationId,
        id: crypto.randomUUID(),
        parentAttemptId: null,
        at: new Date().toISOString(),
        expected,
        ids: {},
      },
    });
    if (prepared.operation.terminal) return null;
    const project = await hostedWriteProject(ctx, input.projectId, input.actor, selected.authority.epoch);
    invariant(
      project.sourceAuthority?.mode === selected.authority.mode,
      'SOURCE_AUTHORITY_CHANGED',
      'Seed the current source authority.',
    );
    const selection = canonicalPayload(selected),
      old = await channelRow(ctx, input.projectId);
    invariant(
      !old || old.operationId !== input.operationId || old.selection === selection,
      'WORK_OPERATION_CHANGED',
      'Retry the original seed operation payload.',
    );
    invariant(
      !old || old.selection === selection,
      'CHANNEL_CHANGED',
      'Main is already seeded; retain its current receipt.',
    );
    if (!old)
      await ctx.db.insert('projectHostedChannels', {
        projectId: input.projectId,
        operationId: input.operationId,
        name: 'main',
        selection,
      });
    const first = prepared.operation.firstAttempt;
    await finishHostedOperation(ctx, {
      projectId: input.projectId,
      actor: input.actor,
      operationId: input.operationId,
      receipt: { attemptId: first.id, at: first.at, outcome: { status: 'completed', result: null } },
    });
    return null;
  },
});

/** Version-2 start observation, separate from legacy projectMain generation reads. */
export const current = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read hosted main.');
      const project = await accessibleProject(ctx, input.projectId, user.subject);
      const authority = sourceAuthority(project),
        main = await hostedStartMain(ctx, input.projectId);
      invariant(
        authority.mode !== 'native-owner' &&
          authority.mode === main.authority.mode &&
          authority.epoch === main.authority.epoch,
        'SOURCE_AUTHORITY_CHANGED',
        'Hosted main and project authority differ.',
      );
      return canonicalPayload(main);
    } catch (error) {
      return report(error);
    }
  },
});
