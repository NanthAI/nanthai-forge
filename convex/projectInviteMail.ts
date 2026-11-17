// SPDX-License-Identifier: Apache-2.0
// Invitation emails (Item c6629fda): one email per invitation, sent through the alert email sender's account, token
// and from address (src/stall-alerts.ts STALL_ALERT_ENV, Cloudflare Email Service); no second provider. The invitation's operation row
// holds the send state; a resend is explicit and idempotent per resend operation id. The email names the inviter's
// handle, the project and the role, nothing else: no other members, no source, no tracking pixel, no rewritten link.
// The link is the project's address and grants nothing by itself; access is bound to the account or the verified email.
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation, internalQuery } from './server';
import { mutation } from './cliServer';
import type { MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { activeOwnedProject } from './projectAuthority';
import { requireOwnerPerson } from './ownerPerson';
import { DEFAULT_ALERT_SENDER, STALL_ALERT_ENV } from '../src/stall-alerts';
import { networkFetch, networkTimeout } from '../src/network-fetch';
import { invariant } from '../src/errors';
import { report } from './errors';

type Operation = Doc<'projectAccessOperations'>;
export type InviteMail = NonNullable<Operation['mail']>;
const deliverRef = makeFunctionReference<'action', { projectId: Id<'hostedProjects'>; operationId: string }>(
  'projectInviteMail:deliver',
);
const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The sender request, or null when email is not set up on this deployment (the row then shows "off"). */
function emailRequest(
  mail: { to: string; subject: string; text: string; html: string },
  env: NodeJS.ProcessEnv,
) {
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
export async function queueInviteMail(ctx: MutationCtx, row: Operation) {
  if (!emailShape.test(row.person)) return;
  await ctx.db.patch(row._id, { mail: { status: 'sending', sends: 1, at: Date.now() } });
  await ctx.scheduler.runAfter(0, deliverRef, { projectId: row.projectId, operationId: row.operationId });
}

/** The words of one invitation email. Plain text first; the HTML is the same words, styled inline from the design
 * tokens' light values (email clients ignore external CSS), with no images. */
export function inviteEmail(input: {
  inviter: string;
  project: string;
  role: 'read' | 'write';
  url: string;
}) {
  const can = input.role === 'write' ? 'read and change' : 'read';
  const subject = `${input.inviter} invited you to ${input.project} on Forge`;
  const text = [
    `${input.inviter} invited you to ${can} ${input.project} on Forge.`,
    '',
    `Open it: ${input.url}`,
    '',
    'Sign in with this email address to join. Nothing happens if you ignore this email.',
  ].join('\n');
  const esc = (value: string) =>
    value.replace(
      /[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  const html =
    '<!doctype html><html><body style="margin:0;padding:24px;background:#f6f5f1;font-family:system-ui,sans-serif;color:#1c1b19">' +
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e3e0d8;border-radius:8px;padding:24px">' +
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.5"><b>${esc(input.inviter)}</b> invited you to ${can} <b>${esc(input.project)}</b> on Forge.</p>` +
    `<p style="margin:0 0 16px"><a href="${esc(input.url)}" style="display:inline-block;padding:8px 14px;border-radius:6px;background:#1c1b19;color:#ffffff;text-decoration:none;font-size:14px">Open ${esc(input.project)}</a></p>` +
    `<p style="margin:0;font-size:13px;line-height:1.5;color:#5d5a53">Sign in with this email address to join. Nothing happens if you ignore this email.</p>` +
    '</div></body></html>';
  return { subject, text, html };
}

/** What one send needs, read once by the action. Null when the invitation is gone or ended. */
export const details = internalQuery({
  args: { projectId: v.id('hostedProjects'), operationId: v.string() },
  returns: v.union(
    v.object({ to: v.string(), subject: v.string(), text: v.string(), html: v.string() }),
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
    if (!row?.mail || row.mail.status !== 'sending' || !emailShape.test(row.person)) return null;
    const [slug] = await ctx.db
      .query('projectSlugs')
      .withIndex('by_project', q => q.eq('projectId', project._id))
      .take(1);
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
    const web = process.env.FORGE_WEB_URL;
    const path =
      handle && slug ? `/-/${encodeURIComponent(handle)}/${encodeURIComponent(slug.slug)}` : '/-/account';
    const url = web ? new URL(path, web).href : path;
    // One line, no control characters: the name reaches a mail subject.
    const name =
      handle && slug
        ? `${handle}/${slug.slug}`
        : project.name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
    return {
      to: row.person,
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
  args: { projectId: v.id('hostedProjects'), operationId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const mail = await ctx.runQuery(
      makeFunctionReference<
        'query',
        typeof input,
        { to: string; subject: string; text: string; html: string } | null
      >('projectInviteMail:details'),
      input,
    );
    if (!mail) return null;
    const request = emailRequest(mail, process.env);
    let status: InviteMail['status'] = 'off',
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
    status: v.union(v.literal('sent'), v.literal('failed'), v.literal('off')),
    code: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await invitationRow(ctx, input.projectId, input.operationId);
    if (!row?.mail || row.mail.status !== 'sending') return null;
    await ctx.db.patch(row._id, {
      mail: {
        ...row.mail,
        status: input.status,
        at: Date.now(),
        ...(input.code ? { code: input.code } : { code: undefined }),
      },
    });
    return null;
  },
});

/** Send the invitation email again. Explicit (the owner person presses Resend) and idempotent per `resendId`. */
export const resend = mutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), resendId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const user = await requireOwnerPerson(ctx, 'send invitation emails');
      await activeOwnedProject(ctx, input.projectId, user.subject);
      invariant(input.resendId.trim(), 'BAD_ARGUMENT', 'Retain the resend operation id.');
      const row = await invitationRow(ctx, input.projectId, input.operationId);
      invariant(row?.mail, 'BAD_ARGUMENT', 'This invitation has no email to send again.');
      if (row.mail.resend === input.resendId) return null;
      invariant(row.mail.status !== 'sending', 'BAD_ARGUMENT', 'The email is still being sent.');
      await ctx.db.patch(row._id, {
        mail: { status: 'sending', sends: row.mail.sends + 1, at: Date.now(), resend: input.resendId },
      });
      await ctx.scheduler.runAfter(0, deliverRef, {
        projectId: input.projectId,
        operationId: input.operationId,
      });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
