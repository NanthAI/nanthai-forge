// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query, accountMutation } from './cliServer';
import { authComponents as components } from './authComponents';
import { githubSignIn } from './auth';
import { confirmAccount, confirmationOptions, digest, linkAccount } from './authLinkAccount';
import { authenticationResponse, requestOptions } from './authPasskeyWire';
import { completeGithubLink, libraryCall } from './authGithubLink';
import { invariant } from '../src/errors';
import { report } from './errors';
const PURPOSE = 'forge:link-github';
const FRESH_MS = 10 * 60 * 1000;
export const current = query({
  args: {},
  returns: v.boolean(),
  handler: async ctx => {
    const identity = await ctx.auth.getUserIdentity();
    const id =
      typeof identity?.forgeAuthUser === 'string'
        ? ctx.db.normalizeId('users', identity.forgeAuthUser)
        : null;
    const user = id && (await ctx.db.get(id));
    return Boolean(user?.githubId && !user.githubConflict);
  },
});
export const startConfirmation = accountMutation('same')({
  args: {},
  returns: v.union(requestOptions, v.null()),
  handler: async ctx => {
    try {
      const { user } = await linkAccount(ctx);
      const keys = await ctx.runQuery(components.authPasskey.registration.listPasskeys, { userId: user._id });
      return keys.length ? await confirmationOptions(ctx, user, PURPOSE) : null;
    } catch (error) {
      return report(error);
    }
  },
});
export const confirm = accountMutation('same')({
  args: { response: authenticationResponse },
  returns: v.null(),
  handler: async (ctx, { response }) => {
    try {
      const { user, sessionId } = await linkAccount(ctx);
      await confirmAccount(ctx, user, PURPOSE, response);
      await ctx.db.patch(user._id, {
        githubLink: { sessionId, verifiedUntil: Date.now() + FRESH_MS, confirmed: true },
      });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const startSignInWithGithub = accountMutation('same')({
  args: { redirectTo: v.string() },
  returns: v.object({ redirect: v.string(), state: v.string() }),
  handler: async (ctx, args) => {
    try {
      const { user, sessionId } = await linkAccount(ctx);
      invariant(
        process.env.AUTH_GITHUB_CLIENT_ID && process.env.AUTH_GITHUB_CLIENT_SECRET,
        'AUTH_CONFIGURATION',
        'Configure GitHub sign-in and redeploy.',
      );
      const keys = await ctx.runQuery(components.authPasskey.registration.listPasskeys, { userId: user._id });
      invariant(
        !keys.length ||
          (user.githubLink?.sessionId === sessionId &&
            user.githubLink.verifiedUntil > Date.now() &&
            user.githubLink.confirmed &&
            !user.githubLink.stateHash),
        'AUTH_REQUIRED',
        'Confirm with your existing passkey.',
      );
      const result = await libraryCall(githubSignIn.startSignInWithGithub, ctx, args);
      await ctx.db.patch(user._id, {
        githubLink: {
          sessionId,
          verifiedUntil: Date.now() + FRESH_MS,
          confirmed: keys.length > 0,
          stateHash: await digest(result.state),
        },
      });
      return result;
    } catch (error) {
      return report(error);
    }
  },
});
export const completeSignInWithGithub = accountMutation('same')({
  args: { code: v.string(), state: v.string() },
  returns: v.union(
    v.object({
      status: v.literal('complete'),
      tokens: v.object({
        accessToken: v.string(),
        refreshToken: v.string(),
        refreshTokenExpiresAt: v.number(),
        userId: v.string(),
      }),
    }),
    v.object({ status: v.literal('error'), userError: v.object({ error: v.literal('INVALID_CODE') }) }),
  ),
  handler: async (ctx, args) => {
    try {
      const { user, sessionId } = await linkAccount(ctx);
      const operationId = await digest(args.state);
      const request = await digest(JSON.stringify(args));
      const receipt = await ctx.db
        .query('authLinkEvents')
        .withIndex('by_user_and_operation', q => q.eq('userId', user._id).eq('operationId', operationId))
        .unique();
      if (receipt) {
        invariant(
          receipt.kind === 'github' && receipt.request === request && receipt.sessionId === sessionId,
          'WORK_OPERATION_CHANGED',
          'Retry the original GitHub link.',
        );
        // The OAuth ticket is single-use. Replays reconcile to the existing binding,
        // without minting another session or adding another audit event.
        return { status: 'error' as const, userError: { error: 'INVALID_CODE' as const } };
      }
      invariant(
        user.githubLink?.sessionId === sessionId &&
          user.githubLink.verifiedUntil > Date.now() &&
          user.githubLink.stateHash === (await digest(args.state)),
        'AUTH_REQUIRED',
        'Start linking GitHub from this signed-in Forge account.',
      );
      const keys = await ctx.runQuery(components.authPasskey.registration.listPasskeys, { userId: user._id });
      invariant(
        !keys.length || user.githubLink.confirmed,
        'AUTH_REQUIRED',
        'Confirm with your existing passkey.',
      );
      const result = await completeGithubLink(ctx, user, args);
      if (result.status === 'complete') {
        const linked = await ctx.db.get(user._id);
        invariant(linked?.githubId, 'GITHUB_ACCOUNT_MISMATCH', 'GitHub must link to this Forge account.');
        await ctx.db.insert('authLinkEvents', {
          userId: user._id,
          operationId,
          request,
          kind: 'github',
          sessionId,
          identityId: linked.githubId,
          at: Date.now(),
        });
      }
      return result;
    } catch (error) {
      return report(error);
    }
  },
});
