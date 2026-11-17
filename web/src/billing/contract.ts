// SPDX-License-Identifier: Apache-2.0
// P7 billing boundary: display-only snapshots. P8 supplies metering and payment integration.
export const plans = {
  hobby: { name: 'Hobby', monthlyUsd: 0, includedLandings: 300 },
  pro: { name: 'Pro', monthlyUsd: 15, includedLandings: 1_000 },
  team: { name: 'Team', monthlyUsd: 49, includedLandings: 5_000 },
} as const;
export type PlanId = keyof typeof plans;
export const extraBlock = { landings: 500, usd: 10 } as const;
/** Owner decision 4.2: a new paid plan allows two extra blocks until its owner changes the limit. */
export const defaultExtraBlocks = 2;
/** Owner decision 4.8: retries on days 1, 4 and 8; landings continue 21 days, then the Hobby allowance. Nothing is deleted. */
export const paymentRecoveryRule = {
  attemptDays: [1, 4, 8],
  landingsContinueDays: 21,
  fallback: 'hobby',
} as const;
export const billingPageSize = { projects: 50, months: 12, invoices: 24 } as const;
export const landingCountingRule =
  'One accepted landing per Lane, including each Lane in a grouped landing. Held, refused, failed and reverted work adds no usage, and taking a landing out of main never counts or waits on the plan.';

/** `asOf` is when the supplied counters were read; previews use it instead of a clock. */
export type BillingPeriod = { start: string; resetAt: string; asOf: string; label: string };
export type BillingPool = {
  owner: { kind: 'person' | 'organisation'; handle: string };
  plan: PlanId;
  period: BillingPeriod;
  acceptedLandings: number;
  /** Explicitly supplied stub policy, never a new default or live enforcement. */
  extraBlocksAllowed: number | null;
  projectedLandings: number | null;
};
export type BillingProject = {
  id: string;
  name: string;
  href: string;
  landings: number;
  lastLanding: string | null;
};
export type BillingMonth = { month: string; landings: number; plan: PlanId };
export type BillingInvoice = {
  id: string;
  issued: string;
  period: string;
  state: 'paid' | 'unpaid' | 'refunded';
  lines: readonly { label: string; quantity: number; unitUsd: number }[];
  taxUsd: number;
};
export type BillingPayment = {
  brand: string;
  last4: string;
  expires: string;
  declined: boolean;
  /** First declined attempt of the open invoice, or null. */
  firstDeclinedAt: string | null;
  billedTo: string;
  country: string;
  taxLabel: string;
};
export type BillingPage<T> = { rows: readonly T[]; total: number; nextCursor: string | null };
export type BillingSnapshot = {
  source: 'stub';
  /** A billing manager sees invoices, plan, card and limit, and gains no source or project administration. */
  view: 'owner' | 'manager' | 'member';
  pool: BillingPool;
  projects: BillingPage<BillingProject>;
  months: readonly BillingMonth[];
  /** Member snapshots omit financial details; no client-side access decision. */
  invoices: BillingPage<BillingInvoice> | null;
  payment: BillingPayment | null;
  nextInvoice: BillingInvoice | null;
};
export type BillingState =
  | { status: 'loading' }
  | { status: 'ready'; snapshot: BillingSnapshot }
  | { status: 'error'; message: string; previous: BillingSnapshot | null };
/** All screens consume this adapter. No provider calls, timers, writes or credentials in P7. */
export interface BillingAdapter {
  read(): BillingState;
  projects(cursor: string): BillingPage<BillingProject>;
  invoices(cursor: string): BillingPage<BillingInvoice>;
}
export function poolUsage(pool: BillingPool) {
  const included = plans[pool.plan].includedLandings;
  const extra = Math.max(0, pool.acceptedLandings - included);
  const blocks = Math.ceil(extra / extraBlock.landings);
  const ceiling =
    pool.extraBlocksAllowed === null ? null : included + pool.extraBlocksAllowed * extraBlock.landings;
  return {
    included,
    extra,
    blocks,
    extraUsd: blocks * extraBlock.usd,
    remainingIncluded: Math.max(0, included - pool.acceptedLandings),
    ceiling,
    remaining: ceiling === null ? null : Math.max(0, ceiling - pool.acceptedLandings),
  };
}
export function invoiceTotal(invoice: BillingInvoice) {
  return invoice.lines.reduce((sum, line) => sum + line.quantity * line.unitUsd, invoice.taxUsd);
}
export type LandingAllowance = {
  kind: 'billing-pool';
  owner: string;
  used: number;
  included: number;
  limit: number | null;
  remaining: number | null;
  resetAt: string;
};
/** Receipt formatting accepts already-read metadata; it never discovers or counts usage. */
export function landingAllowance(pool: BillingPool): LandingAllowance {
  const usage = poolUsage(pool);
  return {
    kind: 'billing-pool',
    owner: pool.owner.handle,
    used: pool.acceptedLandings,
    included: usage.included,
    limit: usage.ceiling,
    remaining: usage.remaining,
    resetAt: pool.period.resetAt,
  };
}
export function remainingBudgetLine(budget: LandingAllowance): string | null {
  if (budget.remaining === null || budget.limit === null || budget.remaining * 5 >= budget.limit) return null;
  return `billing pool  ${budget.remaining.toLocaleString('en-US')} landings left in ${budget.owner}’s pool; resets ${budget.resetAt}`;
}
export type PlanHeldLanding = {
  kind: 'plan-held';
  owner: string;
  used: number;
  resumesAt: string;
  continuation: string;
  queuePosition: number;
};
export function planHeldLines(held: PlanHeldLanding): string {
  return `held  ${held.owner}’s billing pool has used ${held.used.toLocaleString('en-US')} landings\nwork  saved, position ${held.queuePosition} in the queue\nresumes  ${held.resumesAt}\nautomatic continuation  ${held.continuation}\nretry  not needed; your landing keeps its place`;
}
/** Run allowance remains separate from the owner's monthly billing pool. No invented default. */
export type RunAllowance = { kind: 'run-allowance'; approved: number; spent: number; unit: string };
