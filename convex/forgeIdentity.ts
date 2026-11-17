// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference, type UserIdentity } from 'convex/server';
import type { QueryCtx, MutationCtx, ActionCtx } from './_generated/server';
import { authComponents } from './authComponents';

type Context = QueryCtx | MutationCtx | ActionCtx;
type Account = {
  accountKey: string;
  userId: string;
  sessionId: string;
  email?: string;
  emailVerified?: boolean;
};
const sessionAccount = makeFunctionReference<'query', Record<string, never>, Account | null>(
  'authIdentity:sessionAccount',
);
export function isAuthSession(identity: UserIdentity) {
  const cloud = process.env.CONVEX_CLOUD_URL;
  return Boolean(cloud && identity.issuer === `${cloud}/components/auth`);
}
/** Resolve the live component session, never a user id copied out of a token. */
export async function accountFromSession(
  ctx: QueryCtx | MutationCtx,
  identity: UserIdentity,
): Promise<Account | null> {
  const session = await ctx.runQuery(authComponents.auth.public.getSession, { sessionId: identity.subject });
  if (!session) return null;
  const id = ctx.db.normalizeId('users', session.userId);
  if (!id) return null;
  const user = await ctx.db.get(id);
  return user
    ? {
        accountKey: user.accountKey,
        userId: user._id,
        sessionId: identity.subject,
        ...(user.email && user.emailVerified
          ? { email: user.email, emailVerified: true }
          : { emailVerified: false }),
      }
    : null;
}
const resets = new WeakMap<object, () => void>();
/** Query/mutation dependencies stay reactive. Only a single invocation shares this promise. */
export function identityContext<C extends Context>(ctx: C): C {
  let mapped: Context['auth'] | undefined;
  return new Proxy(ctx, {
    get(target, key) {
      if (key !== 'auth') return Reflect.get(target, key);
      const auth = target.auth;
      if (!auth || resets.has(auth)) return auth;
      if (mapped) return mapped;
      let pending: Promise<UserIdentity | null> | undefined;
      const resolve = async (): Promise<UserIdentity | null> => {
        const identity = await auth.getUserIdentity();
        // CLI and Clerk add zero component calls or DB reads.
        if (!identity || !isAuthSession(identity)) return identity;
        const account =
          'db' in ctx ? await accountFromSession(ctx, identity) : await ctx.runQuery(sessionAccount, {});
        return account
          ? {
              ...identity,
              subject: account.accountKey,
              forgeAuthSession: account.sessionId,
              forgeAuthUser: account.userId,
              email: account.email,
              emailVerified: account.emailVerified === true,
            }
          : null;
      };
      mapped = new Proxy(auth, {
        get(original, property) {
          if (property === 'getUserIdentity') return () => (pending ??= resolve());
          const value = Reflect.get(original, property);
          return typeof value === 'function' ? value.bind(original) : value;
        },
      });
      resets.set(mapped, () => {
        pending = undefined;
      });
      return mapped;
    },
  });
}
/** Actions recheck live sessions after external I/O, just as they recheck CLI credentials. */
export function refreshIdentity(ctx: Context) {
  resets.get(ctx.auth)?.();
}
