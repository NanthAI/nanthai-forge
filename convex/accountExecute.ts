// SPDX-License-Identifier: Apache-2.0
import { retainMembership } from './projectActorNames';
import { report } from './errors';
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { syncPersonOrder } from './accountProjectOrder';
import {
  accountActor,
  resourceMark,
  ownedMetadata,
  incomingCurrent,
  grantsWithParents,
  type ResourceKind,
  type LeaveKind,
} from './accountResources';
import { metadataBytes } from './accountMetadata';
import { deleteImport } from './lifecycle';
import { deleteSecret } from './secretLifecycle';
import { transition } from './projectLifecycle';
import { deleteTeam } from './teamLifecycle';
import { revokeAgent } from './agentGrants';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { givenBefore } from './secretGrantAuthority';
import { accountItemState } from './accountTypes';
import { stream, type QueryStream } from 'convex-helpers/server/stream';
import schema from './schema';

/** Secret grants others gave the person are never listed, counted or hashed into a review (review ae15c5ca), so a
 * deletion that leaves what is shared leaves them by the review's epoch instead: every grant to the person on someone
 * else's object given (inserted or given again in place) before the review started (`secretsBelow`, compared by
 * secretGrantAuthority.givenBefore: transaction order, never a clock tick). A grant given after that stays, silently: a
 * refusal or report would reveal it. Receipts registered before epochs keep their time cutoff (`secretsBefore`).
 *
 * Two steps, so no receipt depends on how many there are (reviews s1-sol62 r4 #2, s1-astra62 r4 #4). The first pass of
 * the operation records the revocation on the person's account row (forgeAccounts.secretsLeftBelow): from that write
 * those grants give nothing (secretGrantAuthority.leftByCleanup). Their rows are then deleted in the background, one
 * byte-capped page per task; each page stores the next cursor and records the next task in one transaction, and a task
 * whose cursor is not the stored one does nothing.
 *
 * A page that fails, even after the receipt says Done, is picked up again without the person (review c4ece6f2 #3): the
 * first start also schedules `recheckSecrets`, which restarts the recorded task from the stored cursor when it failed,
 * was cancelled or is gone, and checks again on RECHECK_DELAYS until the rows are gone. A later pass of the same
 * operation does the same at once (as secretLifecycle.resume does). Work is only ever started on an operation that has
 * not completed and carries a boundary: a completed receipt, or one registered before secret grants were left by
 * review, never starts new work. */
const cutOf = (account: Doc<'accountOperations'>) =>
  account.secretsBelow !== undefined
    ? { below: account.secretsBelow }
    : account.secretsBefore !== undefined
      ? { before: account.secretsBefore }
      : null;
/** When recheckSecrets looks again after the first start: soon, then backing off to once a day while rows remain. A
 * healthy cleanup has finished by the first check, so it costs one call; only a page that keeps failing costs more, at
 * most RECHECK_LIMIT checks (about a month), after which a pass of the operation (Continue) starts it again. */
export const RECHECK_DELAYS = [60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
export const RECHECK_LIMIT = 34;
/** Restarts the recorded secret page from the stored cursor unless it is still pending or running. */
async function resumeSecrets(ctx: MutationCtx, account: Doc<'accountOperations'>) {
  const task = account.secretsTask ? await ctx.db.system.get(account.secretsTask) : null;
  if (task && ['pending', 'inProgress'].includes(task.state.kind)) return;
  const next = await ctx.scheduler.runAfter(0, internal.accountExecute.leaveSecrets, {
    accountId: account._id,
    cursor: account.secretsCursor ?? null,
  });
  await ctx.db.patch(account._id, { secretsDone: false, secretsTask: next });
}
export const startSecrets = internalMutation({
  args: { operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, { operationId }) => {
    try {
      const actor = await accountActor(ctx),
        account = await ctx.db
          .query('accountOperations')
          .withIndex('by_owner_and_operation', q => q.eq('owner', actor).eq('operationId', operationId))
          .unique();
      invariant(account, 'ACCOUNT_UNAVAILABLE', 'This original data selection is unavailable.');
      const cut = cutOf(account);
      if (account.stage === 'preparing' || cut === null || account.secretsDone === true) return null;
      if (account.secretsDone === undefined) {
        if (account.stage === 'completed') return null;
        const person = await ctx.db
          .query('forgeAccounts')
          .withIndex('by_owner', q => q.eq('owner', actor))
          .unique();
        if (person && cut.below !== undefined && (person.secretsLeftBelow ?? 0) < cut.below)
          await ctx.db.patch(person._id, { secretsLeftBelow: cut.below });
        if (person && cut.before !== undefined && (person.secretsLeftBefore ?? 0) < cut.before)
          await ctx.db.patch(person._id, { secretsLeftBefore: cut.before });
        await ctx.scheduler.runAfter(RECHECK_DELAYS[0]!, internal.accountExecute.recheckSecrets, {
          accountId: account._id,
          attempt: 0,
        });
      }
      await resumeSecrets(ctx, account);
      return null;
    } catch (e) {
      return report(e);
    }
  },
});
/** The background check startSecrets schedules: resumes a stopped page, then looks again later while rows remain. */
export const recheckSecrets = internalMutation({
  args: { accountId: v.id('accountOperations'), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, { accountId, attempt }) => {
    const account = await ctx.db.get(accountId);
    if (!account || account.secretsDone !== false || cutOf(account) === null) return null;
    await resumeSecrets(ctx, account);
    if (attempt + 1 >= RECHECK_LIMIT) return null;
    await ctx.scheduler.runAfter(
      RECHECK_DELAYS[Math.min(attempt + 1, RECHECK_DELAYS.length - 1)]!,
      internal.accountExecute.recheckSecrets,
      { accountId, attempt: attempt + 1 },
    );
    return null;
  },
});
export const leaveSecrets = internalMutation({
  args: { accountId: v.id('accountOperations'), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { accountId, cursor }) => {
    const account = await ctx.db.get(accountId);
    const cut = account ? cutOf(account) : null;
    if (
      !account ||
      cut === null ||
      account.secretsDone !== false ||
      cursor !== (account.secretsCursor ?? null)
    )
      return null;
    const actor = account.owner;
    const p = await grantsWithParents(
      () =>
        stream(ctx.db, schema)
          .query('secretGrants')
          .withIndex('by_principal_and_discover_and_secretId', q =>
            q.eq('principal', actor),
          ) as unknown as QueryStream<Doc<'secretGrants'>>,
      cursor,
      async row => ctx.db.get(row.secretId),
    );
    for (const { row: grant, parent } of p.rows) {
      if (!givenBefore(grant, cut) || parent?.owner === actor) continue;
      await leaveSecret(ctx, grant, actor, child(account.operationId, `secrets:${grant._id}`));
    }
    if (p.isDone) {
      await ctx.db.patch(account._id, { secretsDone: true, secretsCursor: null, secretsTask: undefined });
      return null;
    }
    const next = await ctx.scheduler.runAfter(0, internal.accountExecute.leaveSecrets, {
      accountId,
      cursor: p.continueCursor,
    });
    await ctx.db.patch(account._id, { secretsCursor: p.continueCursor, secretsTask: next });
    return null;
  },
});
/** The child operation id of one left grant, in the same form as accountActions' item operation ids. */
function child(operationId: string, key: string) {
  const d = digest(operationId + '\n' + key);
  return `${d.slice(0, 8)}-${d.slice(8, 12)}-4${d.slice(13, 16)}-8${d.slice(17, 20)}-${d.slice(20, 32)}`;
}

async function finish(
  ctx: MutationCtx,
  account: Doc<'accountOperations'>,
  item: Doc<'accountItems'>,
  state: 'completed' | 'changed',
) {
  await ctx.db.patch(item._id, { state });
  await ctx.db.patch(account._id, {
    pending: account.pending - 1,
    stage: 'running',
    ...(state === 'changed' ? { kept: (account.kept ?? 0) + 1 } : {}),
  });
}
/** Leaves one secret grant: the object's policy moves on (so existing use stops) and the grant row goes. */
export async function leaveSecret(
  ctx: MutationCtx,
  grant: Doc<'secretGrants'>,
  actor: string,
  operationId: string,
) {
  // Read now, not from the page: several grants on one object move its policy once each.
  const object = await ctx.db.get(grant.secretId);
  if (object && !object.deleting) {
    const policyRevision = object.policyRevision + 1;
    await ctx.db.patch(object._id, { policyRevision });
    await ctx.db.insert('secretEvents', {
      secretId: object._id,
      actor,
      operationId,
      kind: 'grant',
      version: object.version,
      policyRevision,
      at: Date.now(),
      principal: actor,
      capabilities: [],
    });
  }
  await ctx.db.delete(grant._id);
}
async function leave(ctx: MutationCtx, item: Doc<'accountItems'>, actor: string) {
  if (item.kind === 'secrets') {
    // Operations begun before review ae15c5ca listed secret grants as items; they still finish.
    const row = await ctx.db.get(item.resourceId as Id<'secretGrants'>);
    if (row) await leaveSecret(ctx, row, actor, item.operationId);
    return;
  } else if (item.kind === 'projects') {
    const row = await ctx.db.get(item.resourceId as Id<'projectContributors'>);
    if (row) await retainMembership(ctx, row.projectId, actor);
  } else if (item.kind === 'projectReaders') {
    // As the owner removing a reader does (projectReaders.setReader): their name is kept, the read goes, their
    // project order follows.
    const row = await ctx.db.get(item.resourceId as Id<'projectReaders'>);
    if (row) {
      await retainMembership(ctx, row.projectId, actor);
      await ctx.db.delete(row._id);
      await syncPersonOrder(ctx, row.projectId, actor);
    }
    return;
  } else if (item.kind === 'zones') {
    const row = await ctx.db.get(item.resourceId as Id<'zoneReaders'>),
      zone = row && (await ctx.db.get(row.zoneId));
    if (zone) {
      const update = { kind: 'reader' as const, reader: actor, present: false };
      await ctx.db.patch(zone._id, { revision: zone.revision + 1 });
      await ctx.db.insert('zoneChanges', {
        zoneId: zone._id,
        operationId: item.operationId,
        request: item.pin,
        previousRevision: zone.revision,
        revision: zone.revision + 1,
        at: Date.now(),
        update,
      });
    }
  }
  await ctx.db.delete(item.resourceId as Id<'secretGrants'>);
}
// Selection, authority, child-operation start and personal cleanup share ONE transaction.
export const step = internalMutation({
  args: { operationId: v.string(), itemId: v.id('accountItems') },
  /** The item's state after this step. `started`: its removal is still running elsewhere; `mark` is the resource as
   * this step left it (accountData.watch compares against it). */
  returns: v.object({ state: accountItemState, mark: v.optional(v.string()) }),
  handler: async (ctx, input) => {
    try {
      const actor = await accountActor(ctx),
        account = await ctx.db
          .query('accountOperations')
          .withIndex('by_owner_and_operation', q => q.eq('owner', actor).eq('operationId', input.operationId))
          .unique(),
        item = await ctx.db.get(input.itemId);
      invariant(
        account && account.stage !== 'preparing' && item?.accountId === account._id,
        'ACCOUNT_UNAVAILABLE',
        'This original data selection is unavailable.',
      );
      if (item.state === 'completed' || item.state === 'changed') return { state: item.state };
      if (item.state === 'pending') {
        const value = item.hidden
          ? await incomingCurrent(ctx, item.kind as LeaveKind, item.resourceId, actor)
          : await ownedMetadata(ctx, item.kind as ResourceKind, item.resourceId, actor);
        // Pinned at selection; checked in this transaction (no separate read from the action).
        if (!value || digest(metadataBytes(value)) !== item.pin) {
          await finish(ctx, account, item, 'changed');
          return { state: 'changed' as const };
        }
        if (item.hidden) {
          await leave(ctx, item, actor);
          await finish(ctx, account, item, 'completed');
          return { state: 'completed' as const };
        }
        if (item.kind === 'view' || item.kind === 'interest') {
          await ctx.db.delete(item.resourceId as Id<'savedViews'>);
          await finish(ctx, account, item, 'completed');
          return { state: 'completed' as const };
        }
        await ctx.db.patch(item._id, { state: 'started' });
        await ctx.db.patch(account._id, { stage: 'running' });
      }
      const e = item.expected!;
      if (item.kind === 'project') {
        await transition(
          ctx,
          {
            projectId: item.resourceId as Id<'hostedProjects'>,
            operationId: item.operationId,
            expectedRevision: e.revision!,
          },
          'delete',
          { confirmed: true },
        );
        if ((await ctx.db.get(item.resourceId as Id<'hostedProjects'>))?.removal === 'deleted')
          await finish(ctx, account, item, 'completed');
      } else if (item.kind === 'secret') {
        const result = await deleteSecret(ctx, {
          id: item.resourceId as Id<'secretObjects'>,
          operationId: item.operationId,
          version: e.version!,
          policyRevision: e.policyRevision!,
          archiveRevision: e.archiveRevision!,
        });
        if (result.status === 'deleted') await finish(ctx, account, item, 'completed');
      } else if (item.kind === 'import') {
        await deleteImport(ctx, item.resourceId as Id<'imports'>);
        if (!(await ctx.db.get(item.resourceId as Id<'imports'>)))
          await finish(ctx, account, item, 'completed');
      } else if (item.kind === 'team') {
        await deleteTeam(ctx, {
          id: item.resourceId as Id<'teams'>,
          operationId: item.operationId,
          expectedCreation: e.creation!,
        });
        if ((await ctx.db.get(item.resourceId as Id<'teams'>))?.removal === 'deleted')
          await finish(ctx, account, item, 'completed');
      } else if (item.kind === 'agent') {
        if (await ctx.db.get(item.resourceId as Id<'agentGrants'>))
          await revokeAgent(ctx, item.resourceId as Id<'agentGrants'>);
        await finish(ctx, account, item, 'completed');
      }
      const state = (await ctx.db.get(item._id))!.state;
      return state === 'started'
        ? { state, mark: await resourceMark(ctx, item.kind as ResourceKind, item.resourceId) }
        : { state };
    } catch (e) {
      return report(e);
    }
  },
});
