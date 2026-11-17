// SPDX-License-Identifier: Apache-2.0
import { getFunctionAddress, type DefaultFunctionArgs, type RegisteredMutation } from 'convex/server';
import { ConvexError } from 'convex/values';
import type { GithubProfile } from '@convex-dev/auth/methods/github/server';
import type { MutationCtx } from './server';
import type { Doc } from './_generated/dataModel';
import { githubSignIn } from './auth';
import { authComponents as components } from './authComponents';
import { invariant } from '../src/errors';

export function libraryCall<A extends DefaultFunctionArgs, R>(
  fn: RegisteredMutation<'public', A, R>,
  ctx: MutationCtx,
  args: A,
): Promise<Awaited<R>> {
  return (fn as typeof fn & { _handler: (ctx: MutationCtx, args: A) => Promise<Awaited<R>> })._handler(
    ctx,
    args,
  );
}
function mismatch() {
  throw new ConvexError({
    code: 'GITHUB_ACCOUNT_MISMATCH',
    message: 'This GitHub identity is already linked to another Forge account.',
  });
}
/** The library verifies the one-use OAuth ticket before it reaches this profile boundary.
 * Keep its account lookup, callbacks, session minting and binding transaction intact. */
export async function completeGithubLink(
  ctx: MutationCtx,
  user: Doc<'users'>,
  args: { code: string; state: string },
) {
  const lookup = getFunctionAddress(components.authGithub.provider.getUserIdByAccount).reference;
  const signup = getFunctionAddress(components.auth.public._internal_dangerous_signUp).reference;
  const signin = getFunctionAddress(components.auth.public._internal_dangerous_signIn).reference;
  const linked = {
    ...ctx,
    runQuery: (async (ref: unknown, input?: unknown) => {
      const value = await ctx.runQuery(ref as never, input as never);
      if (getFunctionAddress(ref as never).reference === lookup && value !== null && value !== user._id)
        mismatch();
      return value;
    }) as unknown as typeof ctx.runQuery,
    runMutation: (async (ref: unknown, input?: unknown) => {
      const address = getFunctionAddress(ref as never).reference;
      if (address === signup || address === signin) {
        const claims = input as { claims: { method: string; profile: GithubProfile }; userId?: string };
        invariant(
          claims.claims.method === 'github' && /^[1-9][0-9]{0,19}$/.test(claims.claims.profile.id),
          'GITHUB_RESPONSE',
          'GitHub returned an invalid account id.',
        );
        const profile = claims.claims.profile;
        const matches = await ctx.db
          .query('users')
          .withIndex('by_githubId', q => q.eq('githubId', profile.id))
          .take(2);
        if (
          user.githubConflict ||
          (user.githubId && user.githubId !== profile.id) ||
          matches.some(value => value._id !== user._id) ||
          (claims.userId && claims.userId !== user._id)
        )
          mismatch();
        await ctx.db.patch(user._id, {
          githubId: profile.id,
          githubLogin: profile.login,
          email: profile.emailVerified && profile.email ? profile.email.trim().toLowerCase() : undefined,
          emailVerified: Boolean(profile.emailVerified && profile.email),
        });
      }
      if (address === signup) {
        // Link to the proven current user instead of invoking the new-user callback.
        const fields = { ...(input as Record<string, unknown>) };
        delete fields.createUserHandle;
        return ctx.runMutation(components.auth.public._internal_dangerous_signIn, {
          ...fields,
          userId: user._id,
        } as never);
      }
      return ctx.runMutation(ref as never, input as never);
    }) as unknown as typeof ctx.runMutation,
  };
  const result = await libraryCall(githubSignIn.completeSignInWithGithub, linked, args);
  if (result.status === 'complete') {
    invariant(
      result.tokens.userId === user._id,
      'GITHUB_ACCOUNT_MISMATCH',
      'GitHub must link to this Forge account.',
    );
    await ctx.db.patch(user._id, { githubLink: undefined });
  }
  return result;
}
