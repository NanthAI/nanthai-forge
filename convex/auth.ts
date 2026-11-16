// SPDX-License-Identifier: Apache-2.0
import { setupConvexAuth } from '@convex-dev/auth/server';
import { setupGithub } from '@convex-dev/auth/methods/github/server';
import { setupUsernamePasskey } from '@convex-dev/auth/methods/username-passkey/server';
import { internal } from './_generated/api';
import { authComponents as components } from './authComponents';

const core = setupConvexAuth({ component: components.auth, accessTokenTtlSeconds: 3600 });
export const { signOut, refreshSession, isAuthenticated } = core;
const origin = process.env.FORGE_WEB_URL ?? '';
export const passkeyConfig = {
  rpId: process.env.FORGE_AUTH_RP_ID ?? (origin ? new URL(origin).hostname : ''),
  origin,
  rpName: 'Forge',
};
export const { startSignInWithGithub, completeSignInWithGithub } = setupGithub(core, {
  component: components.authGithub,
  allowedRedirectOrigins: origin ? [origin] : [],
}).attachUserCallbacks({
  createUser: internal.authUsers.createGithub,
  onSignIn: internal.authUsers.signedInGithub,
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
