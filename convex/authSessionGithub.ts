// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { githubSignIn } from './auth';
import { linkAccount, digest } from './authLinkAccount';
import { libraryCall, completeGithubLink } from './authGithubLink';
import { authComponents as components } from './authComponents';
import { invariant } from '../src/errors';
/** Fresh OAuth proof is bound to the live originating browser and its already linked account. */
export const startSignInWithGithub = mutation({
  args: { redirectTo: v.string() },
  returns: v.object({ redirect: v.string(), state: v.string() }),
  handler: async (ctx, args) => {
    const { user, sessionId } = await linkAccount(ctx);
    invariant(
      user.githubId && !user.githubConflict,
      'AUTH_REQUIRED',
      'Use a linked GitHub identity or a passkey.',
    );
    invariant(
      process.env.AUTH_GITHUB_CLIENT_ID && process.env.AUTH_GITHUB_CLIENT_SECRET,
      'AUTH_CONFIGURATION',
      'Configure GitHub sign-in and redeploy.',
    );
    const result = await libraryCall(githubSignIn.startSignInWithGithub, ctx, args);
    const stateHash = await digest(result.state);
    await ctx.db.patch(user._id, {
      sessionEnd: { sessionId, operationId: stateHash, stateHash, verifiedUntil: Date.now() + 10 * 60_000 },
    });
    return result;
  },
});
export const completeSignInWithGithub = mutation({
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
    const { user, sessionId } = await linkAccount(ctx);
    const proof = user.sessionEnd;
    invariant(
      user.githubId &&
        !user.githubConflict &&
        proof?.sessionId === sessionId &&
        proof.verifiedUntil > Date.now() &&
        proof.stateHash === (await digest(args.state)),
      'AUTH_REQUIRED',
      'Start the GitHub check from this signed-in browser.',
    );
    const result = await completeGithubLink(ctx, user, args);
    if (result.status === 'complete') {
      // These bytes come directly from the trusted component's successful exchange,
      // never from a client token. Keep its newly minted session for the returning tab.
      const payload = result.tokens.accessToken.split('.')[1]!;
      const freshSession = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).sub;
      const sessions = await ctx.runQuery(components.auth.public.listSessions, { userId: user._id });
      invariant(
        sessions.some(row => row.sessionId === freshSession),
        'AUTH_REQUIRED',
        'The fresh GitHub session must belong to this account.',
      );
      await ctx.runMutation(components.auth.public.revokeSessions, {
        sessionIds: sessions.filter(row => row.sessionId !== freshSession).map(row => row.sessionId),
      });
      await ctx.db.patch(user._id, { sessionEnd: undefined });
    }
    return result;
  },
});
