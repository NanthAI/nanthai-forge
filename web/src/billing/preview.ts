// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Pure previews over a supplied pool: plan changes, pace, the extra-landings limit, held work and payment recovery.
// No IO, no clock (the pool's `asOf` stands in for now), no timers. Prices come from the contract only.
import {
  extraBlock,
  paymentRecoveryRule,
  planHeldLines,
  plans,
  poolUsage,
  type BillingPool,
  type PlanId,
} from './contract';

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
export const planOrder: readonly PlanId[] = ['hobby', 'pro', 'team'];
export const cents = (usd: number) => Math.round(usd * 100) / 100;
export const dayMonth = (at: string) =>
  new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** The calendar month: whole days in it, and days left counting the day of `asOf`. */
export function periodDays(pool: BillingPool) {
  const { start, resetAt, asOf } = pool.period;
  const total = Math.round((Date.parse(resetAt) - Date.parse(start)) / DAY);
  const left = Math.max(0, Math.min(total, Math.ceil((Date.parse(resetAt) - Date.parse(asOf)) / DAY)));
  return { total, left, elapsed: total - left };
}
/** The landings the month reaches at its pace so far, as supplied by the adapter. */
export const paceLandings = (pool: BillingPool) => pool.projectedLandings ?? pool.acceptedLandings;

/** A plan's month at a landing count; null when Hobby would hold work (Hobby has no extra blocks). */
export function costAt(plan: PlanId, landings: number): { usd: number; blocks: number } | null {
  const over = Math.max(0, landings - plans[plan].includedLandings);
  if (plan === 'hobby') return over ? null : { usd: 0, blocks: 0 };
  const blocks = Math.ceil(over / extraBlock.landings);
  return { usd: plans[plan].monthlyUsd + blocks * extraBlock.usd, blocks };
}
/** The plan that costs least at a landing count; a tie goes to the smaller plan. */
export function cheapestAt(landings: number): PlanId {
  let best: PlanId = 'team';
  for (const plan of [...planOrder].reverse()) {
    const cost = costAt(plan, landings);
    const current = costAt(best, landings);
    if (cost && (!current || cost.usd <= current.usd)) best = plan;
  }
  return best;
}
/** Another plan that would cost less at this month's pace, in either direction, or Hobby's hold to avoid. */
export function cheaperPlan(pool: BillingPool): { plan: PlanId; savesUsd: number | null } | null {
  const pace = paceLandings(pool);
  const best = cheapestAt(pace);
  if (best === pool.plan) return null;
  const now = costAt(pool.plan, pace);
  const then = costAt(best, pace);
  return { plan: best, savesUsd: now && then ? now.usd - then.usd : null };
}
export const paceAssumption = (pool: BillingPool) => {
  const days = periodDays(pool);
  return `At your pace: ${count(pool.acceptedLandings, 'landing')} in the first ${count(days.elapsed, 'day')}, continued for the ${count(days.left, 'day')} left, is about ${count(paceLandings(pool), 'landing')} by month end. Monthly prices in US dollars, before tax.`;
};

export type PlanChange = {
  from: PlanId;
  to: PlanId;
  direction: 'up' | 'down' | 'same';
  /** Moving up starts at `asOf`; moving down waits for the reset. */
  starts: string;
  daysCharged: number;
  daysInPeriod: number;
  newPlanUsd: number;
  creditUsd: number;
  /** Extra blocks already started this month that the new plan's included landings cover. */
  droppedBlocks: number;
  chargedTodayUsd: number;
  monthlyUsd: number;
  includedNow: number;
  remainingNow: number;
};
/** Calendar-month billing: a move up pays the days left and gets the full included landings at once. */
export function planChange(pool: BillingPool, to: PlanId): PlanChange {
  const from = pool.plan;
  const direction = to === from ? 'same' : plans[to].monthlyUsd > plans[from].monthlyUsd ? 'up' : 'down';
  const { total, left } = periodDays(pool);
  const up = direction === 'up';
  const newPlanUsd = up ? cents((plans[to].monthlyUsd * left) / total) : 0;
  const creditUsd = up ? cents((plans[from].monthlyUsd * left) / total) : 0;
  const after = up ? (costAt(to, pool.acceptedLandings)?.blocks ?? 0) : poolUsage(pool).blocks;
  const includedNow = plans[up ? to : from].includedLandings;
  return {
    from,
    to,
    direction,
    starts: up ? pool.period.asOf : pool.period.resetAt,
    daysCharged: up ? left : 0,
    daysInPeriod: total,
    newPlanUsd,
    creditUsd,
    droppedBlocks: Math.max(0, poolUsage(pool).blocks - after),
    chargedTodayUsd: cents(newPlanUsd - creditUsd),
    monthlyUsd: plans[to].monthlyUsd,
    includedNow,
    remainingNow: Math.max(0, includedNow - pool.acceptedLandings),
  };
}

/** Extra-landings limit choices: off, 1, 2 (the default), 5 or no limit. */
export const limitChoices = [0, 1, 2, 5, null] as const;
export type LimitChoice = (typeof limitChoices)[number];
/** Where landings wait, and the most a month can cost before tax; null means not known in advance. */
export function monthlyMaximum(plan: PlanId, blocks: LimitChoice) {
  const p = plans[plan];
  if (plan === 'hobby') return { waitsAt: p.includedLandings, maxUsd: 0 };
  if (blocks === null) return { waitsAt: null, maxUsd: null };
  return {
    waitsAt: p.includedLandings + blocks * extraBlock.landings,
    maxUsd: p.monthlyUsd + blocks * extraBlock.usd,
  };
}

export type LimitPace =
  | { kind: 'no-limit' }
  | { kind: 'fine'; limit: number; left: number }
  | { kind: 'near'; limit: number; left: number; reachedOn: string; inDays: number }
  | { kind: 'reached'; limit: number };
/** The limit approaching from pace to reset: shown when the pace uses it before the reset, never at a percentage. */
export function limitPace(pool: BillingPool): LimitPace {
  const usage = poolUsage(pool);
  const limit = pool.plan === 'hobby' ? usage.included : usage.ceiling;
  if (limit === null) return { kind: 'no-limit' };
  const left = Math.max(0, limit - pool.acceptedLandings);
  if (!left) return { kind: 'reached', limit };
  const days = periodDays(pool).left;
  const perDay = days ? (paceLandings(pool) - pool.acceptedLandings) / days : 0;
  if (perDay <= 0 || left / perDay >= days) return { kind: 'fine', limit, left };
  const inDays = Math.floor(left / perDay);
  return { kind: 'near', limit, left, inDays, reachedOn: iso(Date.parse(pool.period.asOf) + inDays * DAY) };
}
export const whenWords = (pace: Extract<LimitPace, { kind: 'near' }>) =>
  pace.inDays === 0 ? 'today' : pace.inDays === 1 ? 'tomorrow' : `on ${dayMonth(pace.reachedOn)}`;

/** Failed payment: tries on days 1, 4 and 8, landings continue 21 days, then the Hobby allowance; nothing deleted. */
export function paymentRecovery(firstDeclinedAt: string, asOf: string) {
  const first = Date.parse(firstDeclinedAt);
  const attempts = paymentRecoveryRule.attemptDays.map(n => {
    const at = iso(first + (n - 1) * DAY);
    return { day: n, at, done: Date.parse(at) <= Date.parse(asOf) };
  });
  return {
    attempts,
    landingsUntil: iso(first + paymentRecoveryRule.landingsContinueDays * DAY),
    then: {
      plan: paymentRecoveryRule.fallback,
      included: plans[paymentRecoveryRule.fallback].includedLandings,
    },
  };
}

/** One source for every surface that shows plan-held work: rail foot, Needs-you row and decision, Lane, agent. */
export function heldStory(pool: BillingPool, queued: number) {
  const usage = poolUsage(pool);
  const owner = pool.owner.handle;
  const month = pool.period.label;
  const resets = dayMonth(pool.period.resetAt);
  const capped = pool.plan !== 'hobby' && usage.ceiling !== null;
  const what = capped
    ? `${count(usage.ceiling ?? 0, 'landing')}: ${count(usage.included, 'included landing')} and the ${count(pool.extraBlocksAllowed ?? 0, 'extra block')} ${owner} allowed`
    : `its ${count(usage.included, 'landing')} for ${month}`;
  const next = pool.plan === 'hobby' ? cheapestAt(paceLandings(pool)) : 'team';
  const nextWords =
    pool.plan === 'team'
      ? `${owner} raises the limit`
      : `${owner} moves to ${plans[next === 'hobby' ? 'pro' : next].name}${capped ? ' or raises the limit' : ''}`;
  const reason = capped
    ? 'the limit on extra landings is reached'
    : `${pool.acceptedLandings} of ${usage.included} used`;
  return {
    foot: {
      title: `${plans[pool.plan].name} plan`,
      words: `Landings wait · ${pool.acceptedLandings.toLocaleString('en-US')} of ${(usage.ceiling ?? usage.included).toLocaleString('en-US')}, to ${resets}`,
    },
    row: `plan  landings are waiting: ${reason}  only ${owner} can answer`,
    lane: `Held by the plan at In queue: ${owner}’s pool has used ${what}. Saves carry on; no check runs, so no CI minutes are spent. ${owner} has the decision.`,
    tell: `“${owner}’s pool has used ${what}. Landings resume on ${resets}, or when ${nextWords}.”`,
    agent: (position: number) =>
      planHeldLines({
        kind: 'plan-held',
        owner,
        used: pool.acceptedLandings,
        resumesAt: `${resets}, or when ${nextWords}`,
        continuation: 'the original landing operation lands when landings resume',
        queuePosition: position,
      }),
    waiting: `${count(queued, 'Lane')} ${queued === 1 ? 'waits' : 'wait'} at In queue with ${queued === 1 ? 'its place' : 'their places'} kept`,
    resets,
  };
}
