// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
'use node';
import { v } from 'convex/values';
import { internalAction, type ActionCtx } from './server';
import { internal } from './_generated/api';
import { openSecret, sealSecret, secretKeyring } from '../src/secret-crypto';
import { invariant } from '../src/errors';
import { convexFetch, networkTimeout } from './networkFetch';

const binding = (owner: string) => ({
  owner,
  operationId: 'github-user-token',
  repository: 'github',
  ref: 'oauth',
  version: 1,
});
const refreshBinding = (owner: string) => ({ ...binding(owner), operationId: 'github-refresh-token' });
// Service credentials have their own keyring, never a Development/Checks envelope or sign-in key.
const keyring = () => secretKeyring(process.env.FORGE_GITHUB_TOKEN_KEYRING);
/** Renew this long before expiry, so a token is not used in its last minutes. */
const renewEarlyMs = 5 * 60_000;
/** What GitHub returns for a user token: an expiring App adds a refresh token and lifetimes. */
export type GithubUserTokenGrant = { access_token: string; refresh_token?: string; expires_in?: number };
function sealedGrant(owner: string, grant: GithubUserTokenGrant, now: number) {
  invariant(grant.access_token.startsWith('ghu_'), 'GITHUB_RESPONSE', 'Use the Forge GitHub App connection.');
  const renewal =
    typeof grant.refresh_token === 'string' && grant.refresh_token && Number(grant.expires_in) > 0
      ? {
          refreshToken: sealSecret(keyring(), refreshBinding(owner), grant.refresh_token),
          expiresAt: now + Number(grant.expires_in) * 1000,
        }
      : undefined;
  return {
    token: sealSecret(keyring(), binding(owner), grant.access_token),
    ...(renewal ? { renewal } : {}),
  };
}
/** One refresh-token exchange; null when GitHub refuses it (for example, it was already used). */
async function refreshGrant(refreshToken: string, request: typeof fetch) {
  const clientId = process.env.GITHUB_APP_CLIENT_ID,
    clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const response = await request('https://github.com/login/oauth/access_token', {
    method: 'POST',
    redirect: 'error',
    signal: networkTimeout(30_000),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) return null;
  const value = (await response.json()) as Partial<GithubUserTokenGrant> & { error?: string };
  return typeof value.access_token === 'string' && value.access_token && !value.error
    ? (value as GithubUserTokenGrant)
    : null;
}
/** The person's GitHub App user token. An expired one is renewed once, on use, with its refresh
 * token; if renewal fails the stored token is returned and GitHub's check names the expiry. */
export async function githubUserToken(ctx: ActionCtx, owner: string, request: typeof fetch = convexFetch) {
  const row = await ctx.runQuery(internal.githubUserTokens.read, { owner });
  invariant(row?.token, 'GITHUB_UNAVAILABLE', 'Connect your GitHub account and selected repositories.');
  const now = Date.now();
  if (!row.renewal || row.renewal.expiresAt - renewEarlyMs > now)
    return openSecret(keyring(), binding(owner), row.token);
  const grant = await refreshGrant(
    openSecret(keyring(), refreshBinding(owner), row.renewal.refreshToken),
    request,
  );
  if (grant) {
    const renewed = sealedGrant(owner, grant, now);
    if (await ctx.runMutation(internal.githubUserTokens.renew, { owner, previous: row.token, ...renewed }))
      return grant.access_token;
  }
  // Another request renewed it first (refresh tokens are single use), or GitHub refused: read once more.
  const current = await ctx.runQuery(internal.githubUserTokens.read, { owner });
  invariant(current?.token, 'GITHUB_UNAVAILABLE', 'Connect your GitHub account and selected repositories.');
  return openSecret(keyring(), binding(owner), current.token);
}
/** Only the existing server callback calls this, after GitHub proves identity and repository access. */
export const storeConnection = internalAction({
  args: {
    state: v.string(),
    owner: v.string(),
    token: v.string(),
    refreshToken: v.optional(v.string()),
    expiresIn: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { state, owner, token, refreshToken, expiresIn }) => {
    await ctx.runMutation(internal.githubUserTokens.store, {
      state,
      owner,
      ...sealedGrant(
        owner,
        { access_token: token, refresh_token: refreshToken, expires_in: expiresIn },
        Date.now(),
      ),
    });
    return null;
  },
});
