// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One suspend switch and one shared per-account daily limiter for every channel that can carry a
// message (Issue b6588425 line 3). Callers run it inside their existing write mutation, after their
// operation-id replay check (a replay is free) and never from server-scheduled jobs (exempt).
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { ForgeError } from '../src/errors';

const day = 86_400_000;
/** Owner decision 2026-11-22 (comment 68a3784a), Established values raised by the owner the same day
 * to >= 3x the one-account dogfood peak (planning 1,473, friction 151, starts 201, saves 665, new
 * projects 16 a day). Per UTC day, New / Established. New means under 7 days old with no linked
 * verified GitHub login. Change them only with the owner's numbers. `shards` spreads one account's concurrent writers over rows so 10 agents on one
 * account rarely touch the same row (a clash retries inside Convex); a full shard probes the next, so the limit is the whole day's total. */
export const ACCOUNT_LIMITS = {
  establishedAfterDays: 7,
  channels: {
    /** Planning comments and puts are owner-only; notes and Intents on own projects count here too. */
    planning: {
      label: 'planning comments, puts and notes on own projects',
      new: 60,
      established: 5_000,
      shards: 16,
    },
    /** Work notes on projects the account contributes to, counted apart so own-project volume never blocks them. */
    contributed: { label: 'Work notes on other projects', new: 60, established: 500, shards: 2 },
    friction: { label: 'friction records', new: 30, established: 500, shards: 2 },
    start: { label: 'Lane starts and new Intents', new: 60, established: 750, shards: 4 },
    save: { label: 'saves', new: 300, established: 3_000, shards: 16 },
    project: { label: 'new projects', new: 3, established: 50, shards: 1 },
    /** Owner decision 2026-11-22 (comment 68a3784a): abuse reports 10 / 30 (convex/abuseReports.ts). */
    report: { label: 'abuse reports', new: 10, established: 30, shards: 1 },
  },
  activeProjects: { new: 10, established: 100 },
} as const;
export type AccountChannel = keyof typeof ACCOUNT_LIMITS.channels;

/** The account-wide switch row the operator sets (projectBoardOperator:setSwitch scope account). */
export const accountSwitchKey = (subject: string) => `account:${subject}`;

/** One point read. Refuses every message channel of a suspended account at once. */
export async function accountSuspended(ctx: QueryCtx | MutationCtx, subject: string) {
  const row = await ctx.db
    .query('boardSwitches')
    .withIndex('by_key', q => q.eq('key', accountSwitchKey(subject)))
    .unique();
  return Boolean(row?.off);
}
export const suspendedError = () =>
  new ForgeError(
    'ACCOUNT_SUSPENDED',
    'This account is suspended: Forge refuses its comments, saves, Lane starts, messages, invitations, proposals and new projects on every project. Contact the Forge operator to appeal.',
  );
export async function assertAccountActive(ctx: QueryCtx | MutationCtx, subject: string) {
  if (await accountSuspended(ctx, subject)) throw suspendedError();
}

/** Established: 7 days or older, or a linked GitHub login without a conflict mark. The users row
 * is read only for a young account. */
export async function establishedAccount(
  ctx: QueryCtx | MutationCtx,
  subject: string,
  now: number,
  account?: Doc<'forgeAccounts'> | null,
) {
  const row =
    account !== undefined
      ? account
      : await ctx.db
          .query('forgeAccounts')
          .withIndex('by_owner', q => q.eq('owner', subject))
          .unique();
  if (row && now - row._creationTime >= ACCOUNT_LIMITS.establishedAfterDays * day) return true;
  const user = await ctx.db
    .query('users')
    .withIndex('by_accountKey', q => q.eq('accountKey', subject))
    .unique();
  return Boolean(user?.githubId && !user.githubConflict);
}

const dayStart = (now: number) => now - (now % day);
function resetText(resetAt: number, now: number) {
  const minutes = Math.max(1, Math.ceil((resetAt - now) / 60_000));
  const wait = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  return `It resets at 00:00 UTC (${new Date(resetAt).toISOString()}), in ${wait}.`;
}
export function dailyLimitError(text: string, resetAt: number, now: number) {
  return new ForgeError('RATE_LIMITED', `${text} ${resetText(resetAt, now)}`, resetAt);
}

const shardKey = (channel: AccountChannel, subject: string, shard: number) =>
  `limit:${channel}:${shard}:${subject}`;

/** Suspend check plus one sharded daily counter: one switch read, one counter read and one patch per
 * charged write. Below the New share of a shard every tier may write, so the tier is read only once a
 * shard reaches it, then kept on the row: Established for good, New for the day (and re-read before a
 * refusal, in case a GitHub login was linked). `units` charges several records at once (an import page), all or nothing.
 * Throws ACCOUNT_SUSPENDED or RATE_LIMITED before the caller writes anything. */
export async function chargeAccountChannel(
  ctx: MutationCtx,
  subject: string,
  channel: AccountChannel,
  options: { now?: number; established?: boolean; units?: number } = {},
) {
  await assertAccountActive(ctx, subject);
  const now = options.now ?? Date.now(),
    today = dayStart(now),
    resetAt = today + day;
  const limits = ACCOUNT_LIMITS.channels[channel];
  // Exact split: the shards' shares add up to the limit.
  const shareOf = (established: boolean, shard: number) => {
    const cap = established ? limits.established : limits.new;
    return Math.floor(cap / limits.shards) + (shard < cap % limits.shards ? 1 : 0);
  };
  const first = Math.floor(Math.random() * limits.shards);
  let established = options.established;
  let checked = established !== undefined;
  let need = options.units ?? 1;
  const writes: Array<{ row: Doc<'deviceAttempts'> | null; key: string; count: number }> = [];
  for (let step = 0; step < limits.shards && need > 0; step++) {
    const shard = (first + step) % limits.shards;
    const key = shardKey(channel, subject, shard);
    const row = await ctx.db
      .query('deviceAttempts')
      .withIndex('by_owner', q => q.eq('owner', key))
      .unique();
    const current = row?.windowAt === today;
    const count = current ? row.count : 0;
    // Established never reverts (age only grows), so a kept `true` carries over days; a kept New
    // tier is only trusted for its own day.
    if (established === undefined && (current || row?.established === true)) established = row?.established;
    if (count + need > shareOf(false, shard) && established !== true && !checked) {
      checked = true;
      established = await establishedAccount(ctx, subject, now);
    }
    const take = Math.min(need, shareOf(established === true, shard) - count);
    if (take <= 0) continue;
    writes.push({ row, key, count: count + take });
    need -= take;
  }
  if (need > 0)
    throw dailyLimitError(
      `This account reached its daily limit of ${(established === true ? limits.established : limits.new).toLocaleString('en-US')} ${limits.label}${established === true ? '' : ' for accounts under 7 days old without a linked GitHub login'}.`,
      resetAt,
      now,
    );
  for (const { row, key, count } of writes) {
    const value = {
      owner: key,
      windowAt: today,
      count,
      ...(established === undefined ? {} : { established }),
    };
    // A patch with `established: undefined` clears yesterday's New tier.
    if (row) await ctx.db.patch(row._id, { ...value, established });
    else await ctx.db.insert('deviceAttempts', value);
  }
}

/** New projects: the daily rate plus the active total, one bounded range read of active projects. The
 * tier is read only when the active total reaches the New limit. */
export async function chargeProjectCreation(ctx: MutationCtx, owner: string, now = Date.now()) {
  await assertAccountActive(ctx, owner);
  const { activeProjects } = ACCOUNT_LIMITS;
  const rows = await ctx.db
    .query('hostedProjects')
    .withIndex('by_owner_and_removal', q => q.eq('owner', owner).eq('removal', undefined))
    .take(activeProjects.established);
  // At the New total, a kept Established tier on the project counter answers first (one point read).
  const kept = async () =>
    (
      await ctx.db
        .query('deviceAttempts')
        .withIndex('by_owner', q => q.eq('owner', shardKey('project', owner, 0)))
        .unique()
    )?.established === true || (await establishedAccount(ctx, owner, now));
  const established = rows.length >= activeProjects.new ? await kept() : undefined;
  const active = activeProjects[established ? 'established' : 'new'];
  if (rows.length >= active)
    throw new ForgeError(
      'QUOTA_EXCEEDED',
      `This account has ${active} active projects, its limit${established ? '' : ' for accounts under 7 days old without a linked GitHub login'}. Delete a project before creating another.`,
    );
  await chargeAccountChannel(ctx, owner, 'project', {
    now,
    ...(established === undefined ? {} : { established }),
  });
}
