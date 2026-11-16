// SPDX-License-Identifier: Apache-2.0
import { setupConvexAuth } from '@convex-dev/auth/server';
import { setupGithub } from '@convex-dev/auth/methods/github/server';
import { setupUsernamePasskey } from '@convex-dev/auth/methods/username-passkey/server';
import { internal } from './_generated/api';
import { ConvexError, v } from 'convex/values';
import { mutation, type MutationCtx } from './cliServer';
import { authComponents as components } from './authComponents';

const core = setupConvexAuth({ component: components.auth, accessTokenTtlSeconds: 3600 });
export const { signOut, refreshSession, isAuthenticated } = core;
const origin = process.env.FORGE_WEB_URL ?? '';
export const passkeyConfig = {
  rpId: process.env.FORGE_AUTH_RP_ID ?? (origin ? new URL(origin).hostname : ''),
  origin,
  rpName: 'Forge',
};
const githubSignIn = setupGithub(core, {
  component: components.authGithub,
  allowedRedirectOrigins: origin ? [origin] : [],
}).attachUserCallbacks({
  createUser: internal.authUsers.createGithub,
  onSignIn: internal.authUsers.signedInGithub,
});
export const { completeSignInWithGithub } = githubSignIn;
export const startSignInWithGithub = mutation({
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
export const {
  startSignInWithUsernamePasskey,
  startAutofillSignInWithUsernamePasskey,
  finishSignUpWithUsernamePasskey,
  finishSignInWithUsernamePasskey,
  listPasskeys,
  renamePasskey,
  startAddPasskey,
  verifyAddPasskey,
  finishAddPasskey,
  startRemovePasskey,
  finishRemovePasskey,
} = setupUsernamePasskey(core, {
  component: components.authPasskey,
  usernameComponent: components.authUsername,
  ...passkeyConfig,
}).attachUserCallbacks({ createUser: internal.authUsers.createPasskey });
