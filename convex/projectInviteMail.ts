// SPDX-License-Identifier: Apache-2.0
// Invitation emails (Item c6629fda): one email per invitation, sent through the alert email sender's account, token
// and from address (src/stall-alerts.ts STALL_ALERT_ENV, Cloudflare Email Service); no second provider. The invitation's operation row
// holds the send state; a resend is explicit and idempotent per resend operation id. The email names the inviter's
// handle, the project and the role, nothing else: no other members, no source, no tracking pixel, no rewritten link.
// The link opens the recipient inbox and grants nothing; accepting checks the account or its current verified email.
import { v } from 'convex/values';
import { inviteEmail } from './projectInvitationEmail';
export { inviteEmail } from './projectInvitationEmail';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation, internalQuery } from './server';
import { accountMutation } from './cliServer';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { activeOwnedProject } from './projectAuthority';
import { requireOwnerPerson } from './ownerPerson';
import { DEFAULT_ALERT_SENDER, STALL_ALERT_ENV } from '../src/stall-alerts';
import { networkFetch, networkTimeout } from '../src/network-fetch';
import { invariant, ForgeError } from '../src/errors';
import { report } from './errors';
import { findVerifiedRecipient } from './authUsers';
import { invitationBlock } from './projectInvitationRecipient';
import { invitationWasRevoked } from './projectInvitationRevocation';
import {
  invitationByOperation,
  invitationStatus,
  invitationEmailEnabled,
  invitationBudget,
  invitationSendTimeout,
  emailShape,
  invitationEmailHash,
} from './projectInvitationPolicy';

type Operation = Doc<'projectAccessOperations'>;
export type InviteMail = NonNullable<Operation['mail']>;
const deliverRef = makeFunctionReference<
  'action',
  { projectId: Id<'hostedProjects'>; operationId: string; sendId?: string }
>('projectInviteMail:deliver');

/** The sender request, or null when email is not set up on this deployment (the row then shows "off"). */
function emailRequest(
  mail: { to: string; subject: string; text: string; html: string },
  env: NodeJS.ProcessEnv,
) {
  if (!invitationEmailEnabled()) return null;
  const token = env[STALL_ALERT_ENV.emailToken],
    account = env[STALL_ALERT_ENV.emailAccount];
  if (!token || !account || !/^[0-9a-f]{32}$/i.test(account)) return null;
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${account}/email/sending/send`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ from: env[STALL_ALERT_ENV.emailFrom] || DEFAULT_ALERT_SENDER, ...mail }),
    },
  };
}

export function invitationRow(ctx: MutationCtx, projectId: Id<'hostedProjects'>, operationId: string) {
  return ctx.db
    .query('projectAccessOperations')
    .withIndex('by_project_and_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();
}

/** Called once by the invitation mutation, in its own transaction: marks the row sending and schedules one send. */
export async function queueInviteMail(
  ctx: MutationCtx,
  row: Operation,
  invite: Doc<'projectInvites'>,
  operationId: string,
) {
  if (!emailShape.test(row.person)) return;
  const mail: InviteMail = {
    status: invitationEmailEnabled() ? 'sending' : 'off',
    sends: invitationEmailEnabled() ? 1 : 0,
    at: Date.now(),
  };
  await ctx.db.patch(row._id, { mail });
  await ctx.db.patch(invite._id, { mail });
  if (mail.status === 'sending')
    await ctx.scheduler.runAfter(0, deliverRef, {
      projectId: row.projectId,
      operationId,
      sendId: operationId,
    });
}

/** What one send needs, read once by the action. Null when the invitation is gone or ended. */
export const details = internalQuery({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), sendId: v.optional(v.string()) },
  returns: v.union(
    v.object({
      to: v.string(),
      subject: v.string(),
      text: v.string(),
      html: v.string(),
      suppressed: v.optional(v.boolean()),
    }),
    v.null(),
  ),
  handler: async (ctx, input) => {
    const project = await ctx.db.get(input.projectId);
    if (!project || project.removal) return null;
    const row = await ctx.db
      .query('projectAccessOperations')
      .withIndex('by_project_and_operation', q =>
        q.eq('projectId', input.projectId).eq('operationId', input.operationId),
      )
      .unique();
    if (
      !invitationEmailEnabled() ||
      !row?.mail ||
      row.mail.status !== 'sending' ||
      !emailShape.test(row.person) ||
      (input.sendId ?? input.operationId) !== (row.mail.resend ?? row.operationId) ||
      Date.now() - row.mail.at >= invitationSendTimeout
    )
      return null;
    const invite = await invitationByOperation(ctx, input.projectId, input.operationId);
    if (
      !invite ||
      invitationStatus(invite) !== 'pending' ||
      row.owner !== project.owner ||
      (invite.inviter && invite.inviter !== project.owner)
    )
      return null;
    // Handles only, read directly: an account without a handle is never named by its account key.
    const handleOf = async (owner: string) =>
      (
        await ctx.db
          .query('forgeAccounts')
          .withIndex('by_owner', q => q.eq('owner', owner))
          .unique()
      )?.handle;
    const handle = await handleOf(project.owner);
    const inviter = row.owner === project.owner ? handle : await handleOf(row.owner);
    const block = await ctx.db
      .query('invitationBlocks')
      .withIndex('by_email_and_inviter', q =>
        q.eq('emailHash', invitationEmailHash(row.person)).eq('inviter', row.owner).eq('blocked', true),
      )
      .take(1);
    let recipient: string | null = null;
    try {
      // Suppression is a protection, not a grant: an old address still finds its blocks.
      recipient = await findVerifiedRecipient(ctx, row.person, { anyAge: true });
    } catch (error) {
      if (!(error instanceof ForgeError && error.code === 'BAD_ARGUMENT')) throw error;
    }
    const accountBlock = recipient ? await invitationBlock(ctx, recipient, row.owner) : null;
    const suppressed =
      block.some(value => value.blocked) ||
      accountBlock?.blocked === true ||
      Boolean(recipient && (await invitationWasRevoked(ctx, invite, recipient)));
    const web = process.env.FORGE_WEB_URL;
    const path = '/account/people';
    const url = web ? new URL(path, web).href : path;
    // One line, no control characters: the name reaches a mail subject.
    const name =
      handle && project.slug
        ? `${handle}/${project.slug}`
        : project.name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
    return {
      to: row.person,
      ...(suppressed ? { suppressed: true } : {}),
      ...inviteEmail({
        inviter: inviter ? `@${inviter}` : 'A Forge user',
        project: name,
        role: row.role ?? 'write',
        url,
      }),
    };
  },
});

/** One send: the sender's HTTP status is recorded, never the address, token or body. */
export const deliver = internalAction({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), sendId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, input) => {
    const mail = await ctx.runQuery(
      makeFunctionReference<
        'query',
        typeof input,
        { to: string; subject: string; text: string; html: string; suppressed?: boolean } | null
      >('projectInviteMail:details'),
      input,
    );
    if (!mail) return null;
    const { suppressed, ...body } = mail;
    const request = suppressed ? null : emailRequest(body, process.env);
    let status: InviteMail['status'] = suppressed ? 'sent' : 'off',
      code: string | undefined;
    if (request) {
      try {
        const response = await networkFetch(request.url, { ...request.init, signal: networkTimeout(10_000) });
        status = response.ok ? 'sent' : 'failed';
        if (!response.ok) code = `HTTP ${response.status}`;
      } catch {
        status = 'failed';
        code = 'network';
      }
    }
    await ctx.runMutation(
      makeFunctionReference<'mutation', typeof input & { status: string; code?: string }, null>(
        'projectInviteMail:settle',
      ),
      { ...input, status, ...(code ? { code } : {}) },
    );
    return null;
  },
});

export const settle = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    sendId: v.optional(v.string()),
    status: v.union(v.literal('sent'), v.literal('failed'), v.literal('off')),
    code: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await invitationRow(ctx, input.projectId, input.operationId);
    if (
      !row?.mail ||
      row.mail.status !== 'sending' ||
      (input.sendId ?? input.operationId) !== (row.mail.resend ?? row.operationId)
    )
      return null;
    const mail: InviteMail = { ...row.mail, status: input.status, at: Date.now(), code: input.code };
    await ctx.db.patch(row._id, { mail });
    const invite = await invitationByOperation(ctx, input.projectId, input.operationId);
    if (invite) await ctx.db.patch(invite._id, { mail });
    return null;
  },
});

/** Send the invitation email again. Explicit (the owner person presses Resend) and idempotent per `resendId`. */
export const resend = accountMutation('person')({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), resendId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const user = await requireOwnerPerson(ctx, 'send invitation emails');
      await activeOwnedProject(ctx, input.projectId, user.subject);
      invariant(input.resendId.trim(), 'BAD_ARGUMENT', 'Retain the resend operation id.');
      const replay = await invitationRow(ctx, input.projectId, input.resendId);
      if (replay) {
        invariant(
          replay.person === `resend:${input.operationId}` && replay.owner === user.subject,
          'WORK_OPERATION_CHANGED',
          'Retry the original resend.',
        );
        return null;
      }
      const row = await invitationRow(ctx, input.projectId, input.operationId);
      const invite = await invitationByOperation(ctx, input.projectId, input.operationId);
      invariant(
        row?.mail && row.owner === user.subject && invite && invitationStatus(invite) === 'pending',
        'BAD_ARGUMENT',
        'This invitation has ended. Send a new invitation.',
      );
      invariant(
        row.mail.status !== 'sending' || Date.now() - row.mail.at >= invitationSendTimeout,
        'BAD_ARGUMENT',
        'The email is still being sent.',
      );
      const userAccount = await ctx.db
        .query('users')
        .withIndex('by_accountKey', q => q.eq('accountKey', user.subject))
        .unique();
      invariant(
        Boolean(
          userAccount
            ? (userAccount.githubId && !userAccount.githubConflict) || userAccount.emailVerified
            : user.emailVerified,
        ),
        'AUTH_REQUIRED',
        'Connect a verified identity before sending email invitations.',
      );
      const sending = invitationEmailEnabled();
      const charge = await invitationBudget(
        ctx,
        user.subject,
        sending ? row.person : undefined,
        sending ? `${input.projectId}:${input.operationId}` : undefined,
      );
      await charge();
      const mail: InviteMail = {
        status: invitationEmailEnabled() ? 'sending' : 'off',
        sends: row.mail.sends + (invitationEmailEnabled() ? 1 : 0),
        at: Date.now(),
        resend: input.resendId,
      };
      await ctx.db.patch(row._id, { mail });
      await ctx.db.patch(invite._id, { mail });
      await ctx.db.insert('projectAccessOperations', {
        projectId: input.projectId,
        owner: user.subject,
        operationId: input.resendId,
        person: `resend:${input.operationId}`,
      });
      if (mail.status === 'sending')
        await ctx.scheduler.runAfter(0, deliverRef, {
          projectId: input.projectId,
          operationId: input.operationId,
          sendId: input.resendId,
        });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
