// SPDX-License-Identifier: Apache-2.0
import type { PaginationResult } from 'convex/server';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './server';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { assertAccountActive } from './accountLimits';

export const invitationPageSize = 25;

export function invitationPageCursor(page: PaginationResult<unknown>) {
  // A reactive range can grow past its read budget. The split is within the scanned
  // prefix, so continuing there can repeat some rows but cannot skip unread ones.
  if (page.pageStatus === 'SplitRequired' && page.splitCursor) return page.splitCursor;
  return page.isDone ? null : page.continueCursor;
}

export const invitationLifetime = 7 * 24 * 60 * 60_000;
export const invitationSendTimeout = 10 * 60_000;
export const invitationEmailEnabled = () => process.env.FORGE_INVITATION_EMAIL === '1';
export const invitationEmailHash = (email: string) => bytesToHex(sha256(new TextEncoder().encode(email)));
export const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function assertInvitationTarget(person: string) {
  invariant(person.length <= 254, 'BAD_ARGUMENT', 'Invitation targets must be 254 characters or fewer.');
}
export const legacyEmailInvitationOperation = (projectId: string, owner: string, person: string) =>
  digest(JSON.stringify(['email-invite', projectId, owner, person]));
export const legacyContributorOperation = (contributor: string, email?: string) =>
  email ? `add-email:${email.trim().toLowerCase()}` : `add:${contributor}`;
export function invitationStatus(row: Doc<'projectInvites'>, now = Date.now()) {
  const state = row.state ?? 'pending';
  return state === 'pending' && (row.expiresAt ?? row._creationTime + invitationLifetime) <= now
    ? 'expired'
    : state;
}
export function visibleInviteMail(row: Doc<'projectInvites'>, now = Date.now()) {
  const mail = row.mail;
  return mail?.status === 'sending' && now - mail.at >= invitationSendTimeout
    ? { ...mail, status: 'failed' as const, code: 'send interrupted' }
    : mail;
}
export const invitationByOperation = (
  ctx: QueryCtx | MutationCtx,
  projectId: Doc<'hostedProjects'>['_id'],
  operationId: string,
) =>
  ctx.db
    .query('projectInvites')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();

/** Mail held by the deployment or recipient cap: the invitation stays pending and its link can be copied. */
export const invitationMailLimit = 'daily email limit';
/** Every send, real or suppressed, settles this long after its action starts (above the send timeout), so the
 * inviter cannot tell a suppressed recipient from the settlement time (P1-02). */
export const invitationSendRequestTimeout = 8_000;
export const invitationSettleDelay = 10_000;

/** Fixed-size counters in the existing rate store. All reads/refusals precede writes;
 * the returned commit runs in the same transaction that queues the send. A suspended inviter is
 * refused first (the account switch, convex/accountLimits.ts). Inviter and resend limits refuse.
 * The deployment and recipient caps never refuse (P1-03): at either cap `mailLimited` is true, the
 * invitation stays pending with its mail not sent, and neither cap is charged. A suppressed pair
 * (recipient block or removal) is not charged to the recipient's counter, so a blocked inviter cannot
 * use up the recipient's daily allowance. It is charged to its own pair counter with the same limit
 * instead, so one inviter sees the cap at the same send either way (review F1); a pair row exists only
 * for suppressed pairs. Both paths read the same rows and write the same number of rows. */
export async function invitationBudget(
  ctx: MutationCtx,
  inviter: string,
  recipient?: string,
  resend?: string,
  { suppressed = false, now = Date.now() }: { suppressed?: boolean; now?: number } = {},
) {
  await assertAccountActive(ctx, inviter);
  const day = 24 * 60 * 60_000,
    hour = 60 * 60_000;
  type Scope = { owner: string; windowMs: number; limit: number; refuse: boolean; charge: boolean };
  const scopes: Scope[] = [
    { owner: `invitation:inviter-day:${inviter}`, windowMs: day, limit: 100, refuse: true, charge: true },
    { owner: `invitation:inviter-hour:${inviter}`, windowMs: hour, limit: 20, refuse: true, charge: true },
    ...(recipient
      ? [
          { owner: 'invitation:deployment-day', windowMs: day, limit: 500, refuse: false, charge: true },
          {
            owner: `invitation:recipient-day:${invitationEmailHash(recipient)}`,
            windowMs: day,
            limit: 3,
            refuse: false,
            charge: !suppressed,
          },
          {
            owner: `invitation:suppressed-pair-day:${inviter}:${invitationEmailHash(recipient)}`,
            windowMs: day,
            limit: 3,
            refuse: false,
            charge: suppressed,
          },
        ]
      : []),
    ...(resend
      ? [{ owner: `invitation:resend-day:${resend}`, windowMs: day, limit: 3, refuse: true, charge: true }]
      : []),
  ];
  const updates: {
    row: Doc<'deviceAttempts'> | null;
    value: { owner: string; windowAt: number; count: number };
    scope: Scope;
  }[] = [];
  let mailLimited = false;
  for (const scope of scopes) {
    const row = await ctx.db
      .query('deviceAttempts')
      .withIndex('by_owner', q => q.eq('owner', scope.owner))
      .unique();
    const windowAt = now - (now % scope.windowMs);
    const count = row?.windowAt === windowAt ? row.count : 0;
    if (scope.refuse)
      invariant(
        count < scope.limit,
        'RATE_LIMITED',
        'Invitations have reached a limit. Try after its UTC hour or day ends.',
      );
    else if (count >= scope.limit) mailLimited = true;
    updates.push({ row, value: { owner: scope.owner, windowAt, count: count + 1 }, scope });
  }
  const commit = async () => {
    for (const { row, value, scope } of updates) {
      if (!scope.charge || (!scope.refuse && mailLimited)) continue;
      if (row) await ctx.db.patch(row._id, value);
      else await ctx.db.insert('deviceAttempts', value);
    }
  };
  return Object.assign(commit, { mailLimited });
}

export async function checkOpenEmailInvitations(
  ctx: MutationCtx,
  projectId: Doc<'hostedProjects'>['_id'],
  now = Date.now(),
) {
  const current = await ctx.db
    .query('projectInvites')
    .withIndex('by_project_and_state_and_expiry', q =>
      q.eq('projectId', projectId).eq('kind', 'email').eq('state', 'pending').gt('expiresAt', now),
    )
    .take(51);
  const legacy = await ctx.db
    .query('projectInvites')
    .withIndex('by_project_and_state_and_expiry', q =>
      q
        .eq('projectId', projectId)
        .eq('kind', undefined)
        .eq('state', undefined)
        .eq('expiresAt', undefined)
        .gt('_creationTime', now - invitationLifetime),
    )
    .take(51);
  const count = [...current, ...legacy].filter(
    row => emailShape.test(row.email) && invitationStatus(row, now) === 'pending',
  ).length;
  invariant(
    count < 50,
    'RATE_LIMITED',
    'This project has 50 open email invitations. End one before sending a new invitation.',
  );
}
