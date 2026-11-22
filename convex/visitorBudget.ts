// SPDX-License-Identifier: Apache-2.0
/** Per-visitor limits (Item b6588425, owner numbers 2026-11-22). The site's edge forwards a keyed hash of the client
 * address (src/client-hash.ts), never the address; a visitor is one hash. Each charge runs inside the mutation that
 * already serves the request: one point read and one write, and a refusal writes nothing. A new hash's first row also
 * removes up to two expired rows, so rotating addresses cannot grow the table; no job runs. These limits come before
 * the per-project and deployment backstops, so one noisy visitor cannot spend the budget other visitors share. */
import type { MutationCtx } from './server';
import { ForgeError, invariant } from '../src/errors';
import { CLIENT_HASH } from '../src/client-hash';

const minute = 60_000,
  hour = 60 * minute;
export const VISITOR_BUDGET = {
  /** Signed-out source reads that miss the site's cache. */
  reads: { perHour: 60 },
  /** Device sign-in starts and renewals together. */
  device: { perMinute: 10, perHour: 30 },
  /** Two per new row keep the table bounded while concurrent first visits overlap on fewer rows. */
  cleanup: 2,
} as const;

/** Milliseconds until this visitor may try again (nothing written), or 0 with the write that charges the call, so a
 * caller can first check an outer budget and charge the visitor only for a call that runs. */
async function check(
  ctx: MutationCtx,
  kind: 'read' | 'device',
  client: string,
  now: number,
): Promise<{ retry: number; charge?: () => Promise<void> }> {
  invariant(CLIENT_HASH.test(client), 'BAD_ARGUMENT', 'The site sent no usable visitor key.');
  const owner = `visitor:${kind}:${client}`;
  const row = await ctx.db
    .query('deviceAttempts')
    .withIndex('by_owner', q => q.eq('owner', owner))
    .unique();
  const hourFresh = !row || now < row.windowAt || now - row.windowAt >= hour;
  const minuteAt = hourFresh ? undefined : row.minuteAt;
  const minuteFresh = minuteAt === undefined || now < minuteAt || now - minuteAt >= minute;
  const count = hourFresh ? 0 : row.count,
    minuteCount = minuteFresh ? 0 : (row!.minuteCount ?? 0);
  const perHour = kind === 'read' ? VISITOR_BUDGET.reads.perHour : VISITOR_BUDGET.device.perHour;
  if (count >= perHour) return { retry: row!.windowAt + hour - now };
  if (kind === 'device' && minuteCount >= VISITOR_BUDGET.device.perMinute)
    return { retry: minuteAt! + minute - now };
  const windowAt = hourFresh ? now : row.windowAt;
  const value = {
    owner,
    windowAt,
    count: count + 1,
    expiresAt: windowAt + hour,
    ...(kind === 'device' ? { minuteAt: minuteFresh ? now : minuteAt, minuteCount: minuteCount + 1 } : {}),
  };
  const charge = async () => {
    if (row) return void (await ctx.db.patch(row._id, value));
    const expired = await ctx.db
      .query('deviceAttempts')
      .withIndex('by_expiresAt', q => q.gt('expiresAt', 0).lte('expiresAt', now))
      .take(VISITOR_BUDGET.cleanup);
    for (const old of expired) await ctx.db.delete(old._id);
    await ctx.db.insert('deviceAttempts', value);
  };
  return { retry: 0, charge };
}

const visitorReads = new WeakMap<object, string>();
/** A visitor read is charged once, by the first mutation it runs, however many checkpoints it then reads. */
export function holdVisitorRead(ctx: object, client: string | undefined) {
  if (client) visitorReads.set(ctx, client);
}
export function takeVisitorRead(ctx: object) {
  const client = visitorReads.get(ctx);
  visitorReads.delete(ctx);
  return client;
}

const wait = (ms: number) =>
  ms >= 2 * minute ? `${Math.ceil(ms / minute)} min` : `${Math.max(1, Math.ceil(ms / 1000))} s`;

/** A signed-out source read from this visitor; over the limit it throws RATE_LIMITED and the read does nothing. */
export async function chargeVisitorRead(ctx: MutationCtx, client: string, now = Date.now()) {
  const { retry, charge } = await check(ctx, 'read', client, now);
  // A later refusal in the same read (the project budget) throws, so this write never commits for it.
  if (charge) return charge();
  throw new ForgeError(
    'RATE_LIMITED',
    `Signed-out reads from your network are at their limit of ${VISITOR_BUDGET.reads.perHour} an hour. Sign in (nforge login) or retry in ${wait(retry)}.`,
    now + retry,
  );
}

/** A device sign-in start or renewal from this visitor, then the deployment budget: null once both are charged, else
 * the refusal the CLI shows. The visitor is charged only for a call the deployment budget lets through. */
export async function takeVisitorDevice(
  ctx: MutationCtx,
  client: string | undefined,
  deploymentBudget: () => Promise<boolean>,
  now = Date.now(),
) {
  const visit = client ? await check(ctx, 'device', client, now) : null;
  if (visit && !visit.charge) return visitorRefusal(visit.retry);
  if (!(await deploymentBudget())) return { error: 'slow_down' as const, interval: 60 };
  await visit?.charge?.();
  return null;
}
function visitorRefusal(retry: number) {
  const { perMinute, perHour } = VISITOR_BUDGET.device;
  return {
    error: 'slow_down' as const,
    interval: Math.max(1, Math.ceil(retry / 1000)),
    error_description: `Too many sign-ins from your network (at most ${perMinute} a minute and ${perHour} an hour). Try again in ${wait(retry)}.`,
  };
}
