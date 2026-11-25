// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Account > Your data > Close account (Item 17cdc774). Once an account holds nothing, its person closes it: Forge
 * removes the account row, every handle it held, its handle operations, its earlier deletion receipts, its project
 * ordering hints, its device sign-ins and, for the native sign-in, its sessions, passkeys and username. Deleted-project
 * and team tombstones stay, by design.
 *
 * - `preview`: on press, the exact before-list (counts and handles), what still stops the close (with the next step),
 *   and, while one runs, its operation id so the page can continue it.
 * - `close`: person-only, one mutation. It checks that the account holds nothing, records `closing` on the account row
 *   and schedules the removal. Retry-safe: the same operation id returns where it stands (and restarts a failed step);
 *   another id while one runs is refused; once the row is gone it answers `closed`.
 * - `closeFor`: the same close for an operator with deployment access (no browser person exists for synthetic keys).
 * - `step`: the background removal, one bounded page per task, in this order (review of the delete path, round 1):
 *   1. `receipts` deletes finished deletion receipts, and unsealed (`preparing`) ones from before the close, with their
 *      items; an unfinished one, or one begun after the close started, stops the close.
 *   2. `signout` revokes every device sign-in page by page, denies device codes still waiting to be redeemed and ends
 *      every browser session. From then on nothing acts as the account.
 *   3. `finish` removes handle operations, ordering hints, link receipts and earlier handles, then, in one final
 *      transaction, re-checks the holdings and removes the native sign-in, the current handle and the account row
 *      together. Anything held by then stops the close and keeps the account whole, its sign-in included.
 *
 * The native `users` row gets a fresh account key, so a
 * later sign-in never acts as the closed key again (no grant, invitation or credential given to the old key reaches
 * it). A GitHub sign-in keeps its numeric id (and any conflict mark) on that row, because the GitHub component keeps its
 * own account link: signing in with GitHub again starts a new, empty account. A passkey-only user row goes. Scale: `close` reads one small page per owned and shared kind plus up to
 * RECEIPTS_SCAN receipts and writes one row; each step reads and writes at most about STEP rows; idle 0. */
import { v } from 'convex/values';
import { queuePublicAccountRead } from './publicSnapshotJobs';
import { internalMutation, type MutationCtx } from './server';
import { accountMutation, query, type QueryCtx } from './cliServer';
import type { Doc } from './_generated/dataModel';
import { internal } from './_generated/api';
import { accountActor, incomingPage, ownedPage, ownedProjection, SHARED } from './accountResources';
import { KINDS } from './accountData';
import { accountFor } from './urlIdentity';
import { endSessions, nativeUser, passkeyCount, removeNativeSignIn } from './accountCloseSignIn';
import { invariant } from '../src/errors';
import { report } from './errors';

/** Rows one background step reads or deletes at most. */
export const STEP = 100;
/** Receipts a close checks up front; the `receipts` step checks the rest as it goes. */
export const RECEIPTS_SCAN = 500;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
type Ctx = QueryCtx | MutationCtx;
type Phase = 'receipts' | 'signout' | 'finish';
const WORDS: Record<(typeof KINDS)[number], string> = {
  project: 'projects',
  import: 'private repository imports',
  agent: 'agent grants',
  team: 'teams',
  view: 'saved views',
  interest: 'watched repositories',
};
const AFTER = 'Delete it under "Delete your Forge data" first, then close the account.';
const RUNNING =
  'An earlier deletion is still running. Continue it under "Earlier deletions", then close the account.';
/** A deletion that can still remove something. One still `preparing` (its begin stopped before sealing) cannot: no step
 * runs on an unsealed receipt (accountExecute.step and accountPlan.complete refuse it), and continuing it
 * means a new begin that checks every pin again. Each item it could target is either still held, which `blocker`
 * refuses before it reads a receipt, or gone. So once nothing is held the close drops it with the finished receipts
 * (Item 17cdc774: two dormant accounts held one since 2026-11-11 and nobody could sign in to continue it). */
const unfinished = (r: Doc<'accountOperations'>) => r.stage !== 'completed' && r.stage !== 'preparing';

/** What still stops the close, as the next step to take, or null when the account holds nothing. */
export async function blocker(ctx: Ctx, actor: string): Promise<string | null> {
  const held: string[] = [];
  for (const kind of KINDS) {
    if (kind === 'project') {
      // Tombstones of deleted projects are kept by design and hold nothing; every other removal state still counts.
      for (const removal of [undefined, 'trash', 'deleting'] as const) {
        const [live] = await ctx.db
          .query('hostedProjects')
          .withIndex('by_owner_and_removal', q => q.eq('owner', actor).eq('removal', removal))
          .take(1);
        if (live) {
          held.push(WORDS.project);
          break;
        }
      }
      continue;
    }
    const p = await ownedPage(ctx, kind, actor, { cursor: null, numItems: 20, maximumBytesRead: 64 * 1024 });
    // A full page of rows that hold nothing (team tombstones) without the end in sight is counted as held: refusing
    // costs a review; closing past a held row would lose it.
    if (!p.isDone || p.page.some(row => ownedProjection(kind, row, actor))) held.push(WORDS[kind]);
  }
  if (held.length) return `Your account still holds ${held.join(', ')}. ${AFTER}`;
  for (const kind of SHARED) {
    const p = await incomingPage(ctx, kind, actor, null);
    if (p.shown.length || !p.isDone)
      return 'Other people still share things with you. Leave them under "Delete your Forge data" first, then close the account.';
  }
  const receipts = await ctx.db
    .query('accountOperations')
    .withIndex('by_owner', q => q.eq('owner', actor))
    .take(RECEIPTS_SCAN);
  return receipts.some(unfinished) ? RUNNING : null;
}

export const preview = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      handle: v.string(),
      handles: v.array(v.string()),
      receipts: v.number(),
      /** More receipts than counted, or more handles than listed: the counts are lower bounds. */
      more: v.boolean(),
      passkeys: v.number(),
      devices: v.number(),
      github: v.boolean(),
      blocker: v.union(v.string(), v.null()),
      /** The running close's operation id, so the page continues that one. */
      closing: v.union(v.string(), v.null()),
    }),
  ),
  handler: async ctx => {
    try {
      const actor = await accountActor(ctx);
      const account = await accountFor(ctx, actor);
      if (!account) return null;
      const handles = await ctx.db
        .query('accountHandles')
        .withIndex('by_owner', q => q.eq('owner', actor))
        .take(STEP + 1);
      const receipts = await ctx.db
        .query('accountOperations')
        .withIndex('by_owner', q => q.eq('owner', actor))
        .take(RECEIPTS_SCAN + 1);
      let devices = 0;
      for (let cursor: string | null = null, pages = 0; pages < 10; pages++) {
        const p = await ctx.db
          .query('cliCredentials')
          .withIndex('by_owner', q => q.eq('owner', actor))
          .paginate({ cursor, numItems: STEP });
        devices += p.page.filter(d => !d.revoked && !d.removed && d.expiresAt > Date.now()).length;
        if (p.isDone) break;
        cursor = p.continueCursor;
      }
      const user = await nativeUser(ctx, actor);
      return {
        handle: account.handle,
        handles: [...new Set([account.handle, ...handles.slice(0, STEP).map(h => h.handle)])].sort(),
        receipts: Math.min(receipts.length, RECEIPTS_SCAN),
        more: receipts.length > RECEIPTS_SCAN || handles.length > STEP,
        passkeys: user ? await passkeyCount(ctx, user._id) : 0,
        devices,
        github: !!user?.githubId,
        blocker: account.closing ? null : await blocker(ctx, actor),
        closing: account.closing?.operationId ?? null,
      };
    } catch (e) {
      return report(e);
    }
  },
});

const closeArgs = { operationId: v.string(), handle: v.string() };
const closeReply = v.object({ stage: v.union(v.literal('closing'), v.literal('closed')) });
type Reply = { stage: 'closing' | 'closed' };

async function schedule(
  ctx: MutationCtx,
  account: Doc<'forgeAccounts'>,
  phase: Phase,
  cursor: string | null,
) {
  const closing = account.closing!;
  const task = await ctx.scheduler.runAfter(0, internal.accountClose.step, {
    accountId: account._id,
    operationId: closing.operationId,
    phase,
    cursor,
  });
  await ctx.db.patch(account._id, { closing: { ...closing, phase, cursor, task } });
}

async function closeAccount(ctx: MutationCtx, actor: string, input: { operationId: string; handle: string }) {
  invariant(UUID.test(input.operationId), 'BAD_ARGUMENT', 'Retain the original operation UUID.');
  const account = await accountFor(ctx, actor);
  // Already closed: a retry of a close that finished reconciles to its outcome.
  if (!account) return { stage: 'closed' } satisfies Reply;
  if (account.closing) {
    invariant(
      account.closing.operationId === input.operationId,
      'ACCOUNT_OPERATION_CHANGED',
      'This account is already closing. Continue that close.',
    );
    // A step that failed or was cancelled starts again from where it stood.
    const task = account.closing.task ? await ctx.db.system.get(account.closing.task) : null;
    if (!task || !['pending', 'inProgress'].includes(task.state.kind))
      await schedule(ctx, account, account.closing.phase, account.closing.cursor);
    return { stage: 'closing' } satisfies Reply;
  }
  invariant(
    input.handle === account.handle,
    'BAD_ARGUMENT',
    `Type your handle, ${account.handle}, to close the account.`,
  );
  const stop = await blocker(ctx, actor);
  invariant(stop === null, 'ACCOUNT_CHANGED', stop ?? '');
  await ctx.db.patch(account._id, {
    closing: { operationId: input.operationId, at: Date.now(), phase: 'receipts', cursor: null },
  });
  await queuePublicAccountRead(ctx, account.handle, { profile: true });
  await schedule(ctx, (await ctx.db.get(account._id))!, 'receipts', null);
  return { stage: 'closing' } satisfies Reply;
}

export const close = accountMutation('person')({
  args: closeArgs,
  returns: closeReply,
  handler: async (ctx, input) => {
    try {
      return await closeAccount(ctx, await accountActor(ctx), input);
    } catch (e) {
      return report(e);
    }
  },
});
/** For keys no person signs in with (synthetic test owners): run with deployment access, one approved run each. */
export const closeFor = internalMutation({
  args: { owner: v.string(), ...closeArgs },
  returns: closeReply,
  handler: (ctx, { owner, ...input }) => closeAccount(ctx, owner, input),
});

/** Deletes at most STEP of `rows` (read with STEP + 1); true when none is left. */
async function sweep(ctx: MutationCtx, rows: { _id: string }[]) {
  for (const row of rows.slice(0, STEP)) await ctx.db.delete(row._id as never);
  return rows.length <= STEP;
}

/** Revokes one page of device sign-ins; on the last page also denies device codes still waiting to be redeemed (they
 * live minutes, so the unexpired ones are few) and ends every native browser session. */
async function signOut(ctx: MutationCtx, actor: string, cursor: string | null) {
  const p = await ctx.db
    .query('cliCredentials')
    .withIndex('by_owner', q => q.eq('owner', actor))
    .paginate({ cursor, numItems: STEP });
  for (const row of p.page) if (!row.revoked) await ctx.db.patch(row._id, { revoked: true });
  if (!p.isDone) return p.continueCursor;
  const codes = await ctx.db
    .query('deviceCodes')
    .withIndex('by_expiresAt', q => q.gt('expiresAt', Date.now()))
    .take(STEP * 5);
  for (const code of codes)
    if (code.owner === actor && (code.state === 'approved' || code.state === 'pending'))
      await ctx.db.patch(code._id, { state: 'denied' });
  await endSessions(ctx, actor);
  return null;
}

export const step = internalMutation({
  args: {
    accountId: v.id('forgeAccounts'),
    operationId: v.string(),
    phase: v.union(v.literal('receipts'), v.literal('signout'), v.literal('finish')),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, { accountId, operationId, phase, cursor }) => {
    const account = await ctx.db.get(accountId);
    const closing = account?.closing;
    // Only the step the account row names runs: a duplicate or stale task does nothing.
    if (
      !account ||
      closing?.operationId !== operationId ||
      closing.phase !== phase ||
      closing.cursor !== cursor
    )
      return null;
    const actor = account.owner;
    const stop = async () => {
      await ctx.db.patch(account._id, { closing: undefined });
      await queuePublicAccountRead(ctx, account.handle, { profile: true });
    };
    if (phase === 'receipts') {
      // Newest first, so a receipt begun during the close (or one past the first scan) is met before any older one goes.
      const [receipt] = await ctx.db
        .query('accountOperations')
        .withIndex('by_owner', q => q.eq('owner', actor))
        .order('desc')
        .take(1);
      // A deletion started after the close began (or one past the first scan) is never cut short: the close stops. That
      // covers one still preparing too, which may be a begin running right now in another tab (same millisecond too).
      if (receipt && (unfinished(receipt) || (receipt.stage === 'preparing' && receipt.at >= closing.at)))
        return void (await stop());
      if (receipt) {
        const items = await ctx.db
          .query('accountItems')
          .withIndex('by_account_and_key', q => q.eq('accountId', receipt._id))
          .take(STEP + 1);
        if (await sweep(ctx, items)) await ctx.db.delete(receipt._id);
      }
      await schedule(ctx, account, receipt ? 'receipts' : 'signout', null);
      return null;
    }
    if (phase === 'signout') {
      const next = await signOut(ctx, actor, cursor);
      await schedule(ctx, account, next === null ? 'finish' : 'signout', next);
      return null;
    }
    const user = await nativeUser(ctx, actor);
    const done =
      (await sweep(
        ctx,
        await ctx.db
          .query('handleOperations')
          .withIndex('by_owner_and_operation', q => q.eq('owner', actor))
          .take(STEP + 1),
      )) &&
      (await sweep(
        ctx,
        await ctx.db
          .query('accountProjectOrder')
          .withIndex('by_person_and_activity', q => q.eq('person', actor))
          .take(STEP + 1),
      )) &&
      (!user ||
        (await sweep(
          ctx,
          await ctx.db
            .query('authLinkEvents')
            .withIndex('by_user_and_operation', q => q.eq('userId', user._id))
            .take(STEP + 1),
        ))) &&
      (await sweep(
        ctx,
        (
          await ctx.db
            .query('accountHandles')
            .withIndex('by_owner', q => q.eq('owner', actor))
            .take(STEP + 2)
        ).filter(h => h.handle !== account.handle),
      ));
    if (!done) {
      await schedule(ctx, account, 'finish', null);
      return null;
    }
    // The final transaction: anything made or shared while the close ran keeps the account whole.
    // The `receipts` step removed every receipt, so any receipt now, even one still preparing, began after it.
    const [late] = await ctx.db
      .query('accountOperations')
      .withIndex('by_owner', q => q.eq('owner', actor))
      .take(1);
    if (late || (await blocker(ctx, actor))) return void (await stop());
    if (user) await removeNativeSignIn(ctx, user);
    for (const alias of await ctx.db
      .query('accountHandles')
      .withIndex('by_owner', q => q.eq('owner', actor))
      .take(2))
      await ctx.db.delete(alias._id);
    await ctx.db.delete(account._id);
    return null;
  },
});
