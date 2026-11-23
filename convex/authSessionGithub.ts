// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { accountMutation } from './cliServer';
import { githubSignIn } from './auth';
import { linkAccount, digest } from './authLinkAccount';
import { libraryCall, completeGithubLink } from './authGithubLink';
import { authComponents as components } from './authComponents';
import { recordFreshBrowser } from './authDeviceFresh';
import { endAccountDevices } from './deviceEndAll';
import { invariant } from '../src/errors';
/** Fresh OAuth proof is bound to the live originating browser and its already linked account. */
export const startSignInWithGithub = accountMutation('same')({
  args: {
    redirectTo: v.string(),
    purpose: v.optional(v.literal('device')),
    includeDevices: v.optional(v.boolean()),
  },
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
      sessionEnd: {
        sessionId,
        operationId: stateHash,
        stateHash,
        verifiedUntil: Date.now() + 10 * 60_000,
        ...(args.purpose ? { purpose: args.purpose } : {}),
        ...(args.includeDevices ? { includeDevices: true } : {}),
      },
    });
    return result;
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
      await recordFreshBrowser(ctx, result);
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
      if (proof.purpose !== 'device')
        await ctx.runMutation(components.auth.public.revokeSessions, {
          sessionIds: sessions.filter(row => row.sessionId !== freshSession).map(row => row.sessionId),
        });
      if (proof.purpose !== 'device' && proof.includeDevices)
        await endAccountDevices(ctx, user.accountKey, user);
      await ctx.db.patch(user._id, { sessionEnd: undefined });
    }
    return result;
  },
});

/** Fixed-purpose adapters keep the library OAuth client protocol unchanged. */
export const startDeviceSignInWithGithub = accountMutation('same')({
  args: { redirectTo: v.string() },
  returns: v.object({ redirect: v.string(), state: v.string() }),
  handler: (ctx, args) => libraryCall(startSignInWithGithub, ctx, { ...args, purpose: 'device' }),
});
export const startEndDevicesWithGithub = accountMutation('same')({
  args: { redirectTo: v.string() },
  returns: v.object({ redirect: v.string(), state: v.string() }),
  handler: (ctx, args) => libraryCall(startSignInWithGithub, ctx, { ...args, includeDevices: true }),
});
