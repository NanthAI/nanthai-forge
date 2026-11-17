// SPDX-License-Identifier: Apache-2.0
import { setupConvexAuth } from '@convex-dev/auth/server';
import { setupGithub } from '@convex-dev/auth/methods/github/server';
import { setupUsernamePasskey } from '@convex-dev/auth/methods/username-passkey/server';
import { internal } from './_generated/api';
import { getFunctionAddress, type DefaultFunctionArgs, type RegisteredMutation } from 'convex/server';
import type { Validator } from 'convex/values';
import { chargePasskey } from './authBudgets';
import { accountFor, handleTaken } from './urlIdentity';
import { handleError } from '../src/readable-urls';
import { invariant } from '../src/errors';
import { ConvexError, v } from 'convex/values';
import { type MutationCtx, accountMutation } from './cliServer';
import { browserInactivitySeconds, browserLifetimeSeconds } from './accessPolicy';
import { recordFreshBrowser } from './authDeviceFresh';
import { authComponents as components } from './authComponents';

const core = setupConvexAuth({
  component: components.auth,
  accessTokenTtlSeconds: 3600,
  refreshInactivityTimeoutSeconds: browserInactivitySeconds,
  sessionMaxLifetimeSeconds: browserLifetimeSeconds,
});
export const { signOut, refreshSession, isAuthenticated } = core;
const origin = process.env.FORGE_WEB_URL ?? '';
export const passkeyConfig = {
  rpId: process.env.FORGE_AUTH_RP_ID ?? (origin ? new URL(origin).hostname : ''),
  origin,
  rpName: 'Forge',
};
export const githubSignIn = setupGithub(core, {
  component: components.authGithub,
  allowedRedirectOrigins: origin ? [origin] : [],
}).attachUserCallbacks({
  createUser: internal.authUsers.createGithub,
  onSignIn: internal.authUsers.signedInGithub,
});
export const completeSignInWithGithub = protect(githubSignIn.completeSignInWithGithub, (ctx, args, run) =>
  run(ctx, args),
);
export const startSignInWithGithub = accountMutation('same')({
  args: { redirectTo: v.string() },
  returns: v.object({ redirect: v.string(), state: v.string() }),
  handler: async (ctx, args) => {
    for (const setting of ['AUTH_GITHUB_CLIENT_ID', 'AUTH_GITHUB_CLIENT_SECRET'] as const) {
      if (!process.env[setting])
        throw new ConvexError({
          code: 'AUTH_CONFIGURATION',
          setting,
          message: `GitHub sign-in requires ${setting}. Configure it and redeploy.`,
        });
    }
    // The pinned Convex 1.50 registration exposes its handler at runtime; the
    // package declarations strip internal members. Keep the library flow intact.
    const start = githubSignIn.startSignInWithGithub as typeof githubSignIn.startSignInWithGithub & {
      _handler: (
        ctx: MutationCtx,
        args: { redirectTo: string },
      ) => Promise<{ redirect: string; state: string }>;
    };
    return start._handler(ctx, args);
  },
});
const passkeys = setupUsernamePasskey(core, {
  component: components.authPasskey,
  usernameComponent: components.authUsername,
  ...passkeyConfig,
}).attachUserCallbacks({ createUser: internal.authUsers.createPasskey });
export const {
  listPasskeys,
  renamePasskey,
  startAddPasskey,
  verifyAddPasskey,
  startRemovePasskey,
  finishRemovePasskey,
} = passkeys;

/** Preserve the pinned library's argument/return validators and ceremony handler while
 * running Forge policy in the same transaction through the standard public builder. */
function protect<A extends DefaultFunctionArgs, R>(
  fn: RegisteredMutation<'public', A, R>,
  handler: (
    ctx: MutationCtx,
    args: A,
    run: (ctx: MutationCtx, args: A) => Promise<Awaited<R>>,
  ) => Promise<Awaited<R>>,
) {
  const registered = fn as typeof fn & {
    exportArgs: () => string;
    exportReturns: () => string;
    _handler: (ctx: MutationCtx, args: A) => Promise<Awaited<R>>;
  };
  const fields = JSON.parse(registered.exportArgs()).value as Record<
    string,
    { fieldType: unknown; optional: boolean }
  >;
  const args = Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      {
        isConvexValidator: true,
        isOptional: field.optional ? 'optional' : 'required',
        json: field.fieldType,
      },
    ]),
  ) as unknown as { [K in keyof A]: Validator<A[K]> };
  return accountMutation('same')({
    args,
    returns: {
      isConvexValidator: true,
      json: JSON.parse(registered.exportReturns()),
    } as unknown as Validator<unknown>,
    handler: async (ctx, input) => {
      const result = await handler(ctx, input as A, registered._handler);
      await recordFreshBrowser(ctx, result);
      return result;
    },
  }) as unknown as RegisteredMutation<'public', A, R>;
}
export const finishSignInWithUsernamePasskey = protect(
  passkeys.finishSignInWithUsernamePasskey,
  (ctx, args, run) => run(ctx, args),
);
const taken = () => ({ error: 'USERNAME_TAKEN' as const });
const invalid = () => ({ error: 'USERNAME_HAS_INVALID_CHARACTERS' as const });
export const startSignInWithUsernamePasskey = protect(
  passkeys.startSignInWithUsernamePasskey,
  async (ctx, args, run) => {
    if (handleError(args.username)) return { success: false as const, userError: invalid() };
    const alias = await ctx.db
      .query('accountHandles')
      .withIndex('by_handle', q => q.eq('handle', args.username))
      .unique();
    let userId: string | null = null;
    if (alias) {
      const account = await accountFor(ctx, alias.owner);
      const user = await ctx.db
        .query('users')
        .withIndex('by_accountKey', q => q.eq('accountKey', alias.owner))
        .unique();
      if (account?.handle !== args.username || !user) return { success: false as const, userError: taken() };
      userId = user._id;
    } else {
      // A retained component name alone never establishes a Forge account's handle.
      const existing = await ctx.runQuery(components.authUsername.public.getUserIdByUsername, args);
      if (existing !== null) return { success: false as const, userError: taken() };
    }
    await chargePasskey(ctx, 'starts', args.username);
    // Route the library's identifier lookup through the canonical Forge handle. The
    // passkey component still binds and verifies the challenge against that user.
    const lookup = components.authUsername.public.getUserIdByUsername;
    return run(
      {
        ...ctx,
        runQuery: ((ref: unknown, input: unknown) =>
          getFunctionAddress(ref as never).reference === getFunctionAddress(lookup).reference
            ? Promise.resolve(userId)
            : ctx.runQuery(ref as never, input as never)) as typeof ctx.runQuery,
      },
      args,
    );
  },
);
export const finishSignUpWithUsernamePasskey = protect(
  passkeys.finishSignUpWithUsernamePasskey,
  async (ctx, args, run) => {
    if (handleError(args.username)) return { status: 'error' as const, userError: invalid() };
    if (await handleTaken(ctx, args.username)) return { status: 'error' as const, userError: taken() };
    await chargePasskey(ctx, 'signups', args.username);
    const result = await run(ctx, args);
    if (result.status === 'complete') {
      const id = ctx.db.normalizeId('users', result.tokens.userId);
      const user = id && (await ctx.db.get(id));
      invariant(user, 'AUTH_REQUIRED', 'Sign in to Forge.');
      const account = await accountFor(ctx, user.accountKey);
      invariant(account, 'AUTH_REQUIRED', 'Sign in to Forge.');
      const placeholder = await ctx.db
        .query('accountHandles')
        .withIndex('by_handle', q => q.eq('handle', account.handle))
        .unique();
      if (placeholder && account.handlePrompt) await ctx.db.delete(placeholder._id);
      await ctx.db.insert('accountHandles', { owner: user.accountKey, handle: args.username });
      await ctx.db.patch(account._id, { handle: args.username, handlePrompt: false });
    }
    return result;
  },
);

export const startAutofillSignInWithUsernamePasskey = protect(
  passkeys.startAutofillSignInWithUsernamePasskey,
  async (ctx, args, run) => {
    await chargePasskey(ctx, 'starts');
    return run(ctx, args);
  },
);

/** Keep passkey additions visible on the account's next visit, in the ceremony transaction. */
export const finishAddPasskey = protect(passkeys.finishAddPasskey, async (ctx, args, run) => {
  const identity = await ctx.auth.getUserIdentity();
  const sessionId = identity?.forgeAuthSession;
  invariant(typeof sessionId === 'string', 'AUTH_REQUIRED', 'Sign in to add a passkey.');
  const result = await run(
    { ...ctx, auth: { ...ctx.auth, getUserIdentity: async () => ({ ...identity!, subject: sessionId }) } },
    args,
  );
  if (result.success) {
    const id =
      typeof identity?.forgeAuthUser === 'string'
        ? ctx.db.normalizeId('users', identity.forgeAuthUser)
        : null;
    invariant(id, 'AUTH_REQUIRED', 'Sign in to add a passkey.');
    await ctx.db.patch(id, { passkeyNotice: { at: Date.now(), passkeyId: result.passkeyId } });
  }
  return result;
});
