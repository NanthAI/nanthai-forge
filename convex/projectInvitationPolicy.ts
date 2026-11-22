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
export const teamEmailInvitationsEnabled = () => process.env.FORGE_TEAM_EMAIL_INVITATIONS === '1';
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

/** Fixed-size counters in the existing rate store. All reads/refusals precede writes;
 * the returned commit runs in the same transaction that queues the send. A suspended inviter is
 * refused first (the account switch, convex/accountLimits.ts). */
export async function invitationBudget(
  ctx: MutationCtx,
  inviter: string,
  recipient?: string,
  resend?: string,
  now = Date.now(),
) {
  await assertAccountActive(ctx, inviter);
  const day = 24 * 60 * 60_000,
    hour = 60 * 60_000;
  const scopes: [string, number, number][] = [
    [`invitation:inviter-day:${inviter}`, day, 100],
    [`invitation:inviter-hour:${inviter}`, hour, 20],
    ...(recipient
      ? [
          ['invitation:deployment-day', day, 500] as [string, number, number],
          [`invitation:recipient-day:${invitationEmailHash(recipient)}`, day, 3] as [string, number, number],
        ]
      : []),
    ...(resend ? [[`invitation:resend-day:${resend}`, day, 3] as [string, number, number]] : []),
  ];
  const updates: {
    row: Doc<'deviceAttempts'> | null;
    value: { owner: string; windowAt: number; count: number };
  }[] = [];
  for (const [owner, windowMs, limit] of scopes) {
    const row = await ctx.db
      .query('deviceAttempts')
      .withIndex('by_owner', q => q.eq('owner', owner))
      .unique();
    const windowAt = now - (now % windowMs);
    const count = row?.windowAt === windowAt ? row.count : 0;
    invariant(
      count < limit,
      'RATE_LIMITED',
      'Invitations have reached a limit. Try after its UTC hour or day ends.',
    );
    updates.push({ row, value: { owner, windowAt, count: count + 1 } });
  }
  return async () => {
    for (const { row, value } of updates) {
      if (row) await ctx.db.patch(row._id, value);
      else await ctx.db.insert('deviceAttempts', value);
    }
  };
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
