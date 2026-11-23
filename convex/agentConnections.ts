// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { invariant } from '../src/errors';
import { connectedApp, connectedApps } from './agentConnectionFields';
import { accountMutation, query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { accountFor } from './urlIdentity';

/** The account comes from the verified caller, never from an app or browser argument. */
export const read = query({
  args: {},
  returns: connectedApps,
  handler: async ctx => {
    const actor = await ctx.auth.getUserIdentity();
    invariant(actor, 'AUTH_REQUIRED', 'Sign in to Forge.');
    return (await accountFor(ctx, actor.subject))?.connectedApps ?? [];
  },
});

/** First authenticated contact from the configured MCP client. Replays do no write. */
export const record = accountMutation('same')({
  args: { app: connectedApp, projectId: v.id('hostedProjects') },
  returns: v.boolean(),
  handler: async (ctx, { app, projectId }) => {
    const actor = await ctx.auth.getUserIdentity();
    invariant(actor, 'AUTH_REQUIRED', 'Sign in to Forge.');
    await accessibleProject(ctx, projectId, actor.subject);
    const account = await accountFor(ctx, actor.subject);
    if (!account) return false;
    const previous = account.connectedApps ?? [];
    if (!previous.includes(app)) await ctx.db.patch(account._id, { connectedApps: [...previous, app] });
    return true;
  },
});
