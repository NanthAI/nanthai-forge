// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query, mutation } from './cliServer';
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { activeOwnedProject } from './projectAuthority';
import { channelRow } from './projectHostedChannels';
import { requireHostedOwnerDrained } from './projectSourceAuthorityDrain';
import { sourceAuthority, nextSourceAuthority, requireSourceAuthority } from '../src/hosted-source-authority';
import { hostedMainV2Schema } from '../src/hosted-main';
import { cutoverRequestSchema, cutoverPinsSchema } from '../src/source-cutover';
import { CUTOVER_CLI_VERSION } from '../src/cutover-version';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

async function inspect(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to cut over your project.');
  const project = await activeOwnedProject(ctx, projectId, user.subject);
  const channel = await channelRow(ctx, projectId);
  invariant(channel, 'SOURCE_UNAVAILABLE', 'Complete the validated schema-2 seed first.');
  const main = hostedMainV2Schema.parse(JSON.parse(channel.selection));
  const backup = project.currentBackup ? await ctx.db.get(project.currentBackup) : null;
  invariant(
    backup?.status === 'stored' && backup.validatedClosure === 1,
    'INVALID_WORK_BACKUP',
    'Retain a validated seed and its object closure before cutover.',
  );
  invariant(
    backup.projectId === projectId && main.projectId === projectId,
    'SOURCE_UNAVAILABLE',
    'Cutover pins must belong to this project.',
  );
  const journal = await ctx.db
    .query('projectWorkHeads')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  const pins = cutoverPinsSchema.parse({
    authority: sourceAuthority(project),
    main,
    backupId: backup._id,
    backupDigest: backup.digest,
    projectRevision: project.revision,
    journalRevision: journal?.revision ?? 0,
    ownerRevision: backup.preview.revision,
  });
  return { project, channel, pins };
}

/** Observation only: no admission marker, scheduling, timestamp or receipt write. */
export const current = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.string(),
  handler: async (ctx, { projectId }) => {
    try {
      return canonicalPayload((await inspect(ctx, projectId)).pins);
    } catch (error) {
      return report(error);
    }
  },
});

async function prepare(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, body: string) {
  const request = cutoverRequestSchema.parse(JSON.parse(body));
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to cut over your project.');
  const project = await activeOwnedProject(ctx, projectId, user.subject);
  const old = await ctx.db
    .query('projectSourceCutovers')
    .withIndex('by_project_and_operation', q =>
      q.eq('projectId', projectId).eq('operationId', request.operationId),
    )
    .unique();
  if (old) {
    invariant(
      old.request === canonicalPayload(request),
      'WORK_OPERATION_CHANGED',
      'Replay the exact cutover request.',
    );
    return { project, channel: null, request, old, plan: JSON.parse(old.receipt) };
  }
  const observed = await inspect(ctx, projectId);
  requireSourceAuthority({ sourceAuthority: observed.pins.authority }, request.pins.authority);
  invariant(
    canonicalPayload(observed.pins) === canonicalPayload(request.pins),
    'CHANNEL_CHANGED',
    'Source, receipt, seed or Work changed. Prepare fresh pins under a new operation.',
  );
  invariant(
    observed.pins.main.authority.mode === observed.pins.authority.mode &&
      observed.pins.main.authority.epoch === observed.pins.authority.epoch,
    'SOURCE_AUTHORITY_CHANGED',
    'Main and authority must have matching pins.',
  );
  invariant(
    request.mode !== observed.pins.authority.mode,
    'BAD_ARGUMENT',
    'Cut over to the other authority; do not advance an unchanged mode.',
  );
  if (request.mode === 'server') {
    invariant(
      observed.pins.main.head ===
        (await ctx.db.get(observed.project.currentBackup!))?.preview.channels?.find(c => c.name === 'main')
          ?.head,
      'CHANNEL_CHANGED',
      'Final seeded main must match the drained owner main.',
    );
    await requireHostedOwnerDrained(ctx, observed.project, {
      revision: request.pins.ownerRevision,
      fingerprint: request.operationId,
    });
  }
  // Indexed OCC predicates include waiting checks/reviews and ready publications.
  for (const phase of ['queued', 'checking', 'ready'] as const) {
    const pending = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
        q.eq('projectId', projectId).eq('channel', 'main').eq('phase', phase),
      )
      .take(1);
    invariant(
      !pending.length,
      'SOURCE_AUTHORITY_DRAIN_REQUIRED',
      'Settle hosted landings under their original identities before changing authority.',
    );
  }
  const authority = nextSourceAuthority(observed.pins.authority, request.pins.authority, request.mode);
  const plan = {
    operationId: request.operationId,
    projectId,
    previous: request.pins,
    authority,
    main: { ...observed.pins.main, authority },
    minimumCliVersion: CUTOVER_CLI_VERSION,
    metric7: request.mode === 'server' ? 'cache-behind-hosted' : 'owner-ahead-of-hosted',
    changes: [
      'project source authority and epoch',
      'main authority pin (head and receipt preserved)',
      'immutable cutover receipt and metric-7 boundary time',
    ],
    undo: 'Fold latest hosted work, restore and verify the recovered owner; dry-run and apply native-owner at the next epoch with a new operationId.',
  };
  return { ...observed, request, old: null, plan };
}

const args = { projectId: v.id('hostedProjects'), request: v.string() };
export const dryRun = query({
  args,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const result = await prepare(ctx, input.projectId, input.request);
      return canonicalPayload({
        dryRun: true,
        completed: Boolean(result.old),
        ...result.plan,
        changes: result.old ? [] : result.plan.changes,
      });
    } catch (error) {
      return report(error);
    }
  },
});
export const apply = mutation({
  args,
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const prepared = await prepare(ctx, input.projectId, input.request);
      if (prepared.old) return prepared.old.receipt;
      invariant(prepared.channel, 'SOURCE_UNAVAILABLE', 'Hosted main must remain available.');
      const receipt = { ...prepared.plan, at: new Date().toISOString() };
      await ctx.db.patch(prepared.project._id, {
        sourceAuthority: prepared.plan.authority,
        sourceCutover: { minimumCliVersion: CUTOVER_CLI_VERSION, at: receipt.at },
      });
      await ctx.db.patch(prepared.channel._id, { selection: canonicalPayload(prepared.plan.main) });
      await ctx.db.insert('projectSourceCutovers', {
        projectId: input.projectId,
        operationId: prepared.request.operationId,
        request: canonicalPayload(prepared.request),
        receipt: canonicalPayload(receipt),
      });
      return canonicalPayload(receipt);
    } catch (error) {
      return report(error);
    }
  },
});
