// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './server';
import { internal } from './_generated/api';
import { openSecret, sealSecret, secretKeyring } from '../src/secret-crypto';
import { invariant } from '../src/errors';

const binding = (owner: string) => ({
  owner,
  operationId: 'github-user-token',
  repository: 'github',
  ref: 'oauth',
  version: 1,
});
// Service credentials have their own keyring, never a Development/Checks envelope or sign-in key.
const keyring = () => secretKeyring(process.env.FORGE_GITHUB_TOKEN_KEYRING);
export async function githubUserToken(ctx: ActionCtx, owner: string) {
  const row = await ctx.runQuery(internal.githubUserTokens.read, { owner });
  if (!row) return null; // The existing Clerk account path remains during this slice.
  if (!row.token && row.legacy) return null; // Seeding must preserve that same path.
  invariant(row.token, 'GITHUB_UNAVAILABLE', 'Connect your GitHub account and selected repositories.');
  return openSecret(keyring(), binding(owner), row.token);
}
/** Only the existing server callback calls this, after GitHub proves identity and repository access. */
export const storeConnection = internalAction({
  args: { state: v.string(), owner: v.string(), token: v.string() },
  returns: v.null(),
  handler: async (ctx, { state, owner, token }) => {
    invariant(token.startsWith('ghu_'), 'GITHUB_RESPONSE', 'Use the Forge GitHub App connection.');
    await ctx.runMutation(internal.githubUserTokens.store, {
      state,
      owner,
      token: sealSecret(keyring(), binding(owner), token),
    });
    return null;
  },
});
