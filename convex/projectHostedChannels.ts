// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { z } from 'zod';
import { internalMutation, type MutationCtx, type QueryCtx } from './server';
import type { Id } from './_generated/dataModel';
import { activeOwnedProject, accessibleProject } from './projectAuthority';
import { query } from './cliServer';
import { report } from './errors';
import { sourceAuthority, requireSourceAuthority } from '../src/hosted-source-authority';
import { cliStableReleaseMetadataSchema, hostedMainV2Schema } from '../src/hosted-main';
import { canonicalPayload, hostedPayloadHash } from '../src/hosted-source-operation';
import { beginHostedOperation, finishHostedOperation } from './projectHostedOperations';
import { invariant } from '../src/errors';
import { findObject } from './projectObjectFind';
import { readMainDay } from './projectLiveLineStore';

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

/** Seeds have no compose lineage. A retained working root is never a seed proof. */
export async function assertRootlessSeed(ctx: MutationCtx, projectId: Id<'hostedProjects'>, head: string) {
  const object = await findObject(ctx, projectId, head);
  invariant(!object?.statePhysical, 'SOURCE_HASH_MISMATCH', 'A source seed must have no physical root.');
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
    const project = await activeOwnedProject(ctx, input.projectId, input.actor);
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
      expectedAuthority: selected.authority,
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
    requireSourceAuthority(project, selected.authority);
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
    if (!old) {
      await assertRootlessSeed(ctx, input.projectId, selected.head);
      await ctx.db.insert('projectHostedChannels', {
        projectId: input.projectId,
        operationId: input.operationId,
        name: 'main',
        selection,
      });
    }
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

function cliReleaseMetadata(channel: 'main', stableProject?: Id<'hostedProjects'>) {
  const minimumCliVersion = cliStableReleaseMetadataSchema.shape.minimumCliVersion.safeParse(
    process.env.FORGE_MINIMUM_CLI_VERSION,
  ).data;
  const protocol = process.env.FORGE_MINIMUM_CLI_PROTOCOL_VERSION;
  const minimumProtocolVersion = cliStableReleaseMetadataSchema.shape.minimumProtocolVersion.safeParse(
    protocol && /^[1-9]\d*$/.test(protocol) ? Number(protocol) : undefined,
  ).data;
  const stableHead =
    stableProject && stableProject === process.env.FORGE_STABLE_CLI_PROJECT_ID
      ? cliStableReleaseMetadataSchema.shape.stableHead.safeParse(process.env.FORGE_STABLE_CLI_STATE).data
      : undefined;
  return {
    channel,
    ...(minimumCliVersion === undefined ? {} : { minimumCliVersion }),
    ...(minimumProtocolVersion === undefined ? {} : { minimumProtocolVersion }),
    ...(stableHead === undefined ? {} : { stableHead }),
  };
}

/** Version-2 start observation, separate from legacy projectMain generation reads.
 * Release clients opt in to compatibility metadata so strict main readers keep their reply. */
export const current = query({
  /** `today: 1`: a clone's bare status also wants the top bar's main figure (Item 32e8de50); `today: 2` also main's
   * state from the same row (Item 8d21cc9e). A CLI that asks 1 keeps its strict day shape. */
  args: {
    projectId: v.id('hostedProjects'),
    today: v.optional(v.union(v.literal(1), v.literal(2))),
    cliRelease: v.optional(v.union(v.literal(1), v.literal(2))),
  },
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
      const selected = input.today
        ? { ...main, mainDay: await readMainDay(ctx.db, input.projectId, input.today === 2) }
        : main;
      return canonicalPayload(
        input.cliRelease
          ? {
              ...selected,
              cliRelease: cliReleaseMetadata(
                main.channel,
                input.cliRelease === 2 ? input.projectId : undefined,
              ),
            }
          : selected,
      );
    } catch (error) {
      return report(error);
    }
  },
});
