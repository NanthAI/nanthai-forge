// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './server';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { ForgeError, invariant } from '../src/errors';
import { deliverStallAlert } from '../src/stall-alerts';

const minute = 60_000,
  day = 24 * 60 * minute;
/** Owner decisions 2026-11-05. */
export const BOARD_RETENTION_MS = 14 * day;
export const BOARD_PROJECT_LIVE_CAP = 5_000;
export const BOARD_LANE_WINDOW = { ms: 10 * minute, posts: 10 };
export const BOARD_MEMBER_DAY_POSTS = 300;
/** PLACEHOLDERS, PENDING OWNER APPROVAL (abuse controls, 2026-11-05): conservative starting
 * values. Change them only with the owner's numbers. Accounts younger than `establishedAfterDays`
 * get the `new` caps. A linked GitHub login cannot raise the tier yet: accounts have no such field. */
export const BOARD_ACCOUNT_CAPS = {
  establishedAfterDays: 7,
  new: { posts: 100, bytes: 24_000 },
  established: { posts: 1_000, bytes: 240_000 },
} as const;
/** PENDING OWNER APPROVAL: metadata without bodies kept this long for abuse investigation. */
export const BOARD_EVIDENCE_MS = 90 * day;
/** PLACEHOLDERS, PENDING OWNER APPROVAL: alert when one account posts into this many projects in
 * a day, or starts board use in this many projects younger than a day. */
export const BOARD_ALERTS = { projectsPerDay: 5, newProjectsPerDay: 3 } as const;
/** Expired rows deleted per post: small batches, no cron. */
export const BOARD_CLEANUP_BATCH = 10;

const dayStart = (now: number) => now - (now % day);

/** The first switch that is off among global, project and (for posts) account. */
export async function boardStopped(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  author?: string,
): Promise<'global' | 'project' | 'account' | null> {
  const keys: ['global' | 'project' | 'account', string][] = [
    ['global', 'global'],
    ['project', `project:${projectId}`],
    ...(author ? [['account', `account:${author}`] as ['account', string]] : []),
  ];
  for (const [scope, key] of keys) {
    const row = await ctx.db
      .query('boardSwitches')
      .withIndex('by_key', q => q.eq('key', key))
      .unique();
    if (row?.off) return scope;
  }
  return null;
}

function limited(message: string, retryAt: number): never {
  throw new ForgeError(
    'RATE_LIMITED',
    `${message} Retry after ${Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))} s.`,
    retryAt,
  );
}

/** One point read and one write per window. Throws RATE_LIMITED; a rejected post writes nothing. */
export async function chargeWindow(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  key: string,
  input: { ms: number; posts: number; now: number; aligned?: boolean; message: string },
) {
  const row = await ctx.db
    .query('projectBoardSenders')
    .withIndex('by_project_and_key', q => q.eq('projectId', projectId).eq('key', key))
    .unique();
  const start = input.aligned ? dayStart(input.now) : input.now;
  const current = row && input.now < row.windowStart + input.ms;
  if (current && row.count >= input.posts) limited(input.message, row.windowStart + input.ms);
  if (!row) await ctx.db.insert('projectBoardSenders', { projectId, key, windowStart: start, count: 1 });
  else await ctx.db.patch(row._id, current ? { count: row.count + 1 } : { windowStart: start, count: 1 });
}

export type BoardAlert = { kind: string; text: string };
/** Daily account totals across every project; returns the odd-pattern alerts this post raises. */
export async function chargeAccount(
  ctx: MutationCtx,
  input: { author: string; projectId: string; bytes: number; youngProject: boolean; now: number },
): Promise<BoardAlert[]> {
  const [row, account] = await Promise.all([
    ctx.db
      .query('boardAccounts')
      .withIndex('by_author', q => q.eq('author', input.author))
      .unique(),
    ctx.db
      .query('forgeAccounts')
      .withIndex('by_owner', q => q.eq('owner', input.author))
      .unique(),
  ]);
  const established =
    account !== null && input.now - account._creationTime >= BOARD_ACCOUNT_CAPS.establishedAfterDays * day;
  const caps = established ? BOARD_ACCOUNT_CAPS.established : BOARD_ACCOUNT_CAPS.new;
  const today = dayStart(input.now);
  const fresh = !row || row.dayStart !== today;
  const posts = (fresh ? 0 : row.posts) + 1,
    bytes = (fresh ? 0 : row.bytes) + input.bytes;
  if (posts > caps.posts)
    limited(
      `This account reached its board limit of ${caps.posts} notes a day across projects.`,
      today + day,
    );
  if (bytes > caps.bytes)
    limited(
      `This account reached its board limit of ${caps.bytes} bytes a day across projects.`,
      today + day,
    );
  const seen = fresh ? [] : row.projects;
  const projects =
    seen.includes(input.projectId) || seen.length > BOARD_ALERTS.projectsPerDay
      ? seen
      : [...seen, input.projectId];
  const newProjects = (fresh ? 0 : row.newProjects) + (input.youngProject ? 1 : 0);
  const alerted = fresh ? [] : row.alerted;
  // Operator alerts name the public handle, never the account id.
  const who = account?.handle ? `@${account.handle}` : 'without a handle';
  const raised: BoardAlert[] = [];
  const raise = (kind: string, when: boolean, text: string) => {
    if (when && !alerted.includes(kind)) raised.push({ kind, text });
  };
  raise(
    'cap',
    // At the cap: the next note (at most 960 bytes) could be refused.
    posts >= caps.posts || bytes > caps.bytes - 960,
    `Board: account ${who} reached its daily cap (${posts}/${caps.posts} notes, ${bytes}/${caps.bytes} bytes).`,
  );
  raise(
    'projects',
    projects.length >= BOARD_ALERTS.projectsPerDay,
    `Board: account ${who} posted into ${projects.length} projects today.`,
  );
  raise(
    'new-projects',
    newProjects >= BOARD_ALERTS.newProjectsPerDay,
    `Board: account ${who} started board use in ${newProjects} projects younger than a day.`,
  );
  const value = {
    dayStart: today,
    posts,
    bytes,
    projects,
    newProjects,
    alerted: [...alerted, ...raised.map(alert => alert.kind)],
  };
  if (row) await ctx.db.patch(row._id, value);
  else await ctx.db.insert('boardAccounts', { author: input.author, ...value });
  return raised;
}

/** Alerts go to the deployment's Forge alert webhook (the operator topic), never to a project. */
export async function sendBoardAlerts(ctx: MutationCtx, alerts: BoardAlert[]) {
  for (const alert of alerts)
    await ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectBoardLimits:deliver'), {
      subject: `[Forge] Board ${alert.kind}`,
      text: alert.text,
    });
}

export const deliver = internalAction({
  args: { subject: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (_ctx, input) => {
    const results = await deliverStallAlert(
      input,
      { enabled: true, notifyAfterMinutes: 15, repeatAfterMinutes: 16, email: [], webhook: 'ntfy' },
      process.env,
    );
    if (results.length) console.log('board alert delivery', JSON.stringify(results));
    return null;
  },
});

/** Lazy retention inside a post: at most BOARD_CLEANUP_BATCH expired bodies of this project and
 * as many expired evidence rows. Returns how many bodies were deleted. */
export async function cleanupExpired(ctx: MutationCtx, projectId: Id<'hostedProjects'>, now: number) {
  const [bodies, evidence] = await Promise.all([
    ctx.db
      .query('projectBoardMessages')
      .withIndex('by_project_and_expiry', q => q.eq('projectId', projectId).lt('expiresAt', now))
      .take(BOARD_CLEANUP_BATCH),
    ctx.db
      .query('boardEvidence')
      .withIndex('by_expiry', q => q.lt('expiresAt', now))
      .take(BOARD_CLEANUP_BATCH),
  ]);
  for (const row of [...bodies, ...evidence]) await ctx.db.delete(row._id);
  return bodies.length;
}

export function assertBoardOpen(stopped: Awaited<ReturnType<typeof boardStopped>>) {
  invariant(
    stopped !== 'global' && stopped !== 'project',
    'BOARD_OFF',
    'The board is turned off for this project.',
  );
  invariant(stopped !== 'account', 'BOARD_SUSPENDED', 'Board posting is suspended for this account.');
}
