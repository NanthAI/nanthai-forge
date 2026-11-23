// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { convexFetch, networkTimeout } from './networkFetch';
import { ConvexError, v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action } from './cliServer';
import { httpAction } from './_generated/server';
import { appInstallation, assertRepositoryName } from './githubAppToken';
import { githubRequest } from '../src/hosted-github-api';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';
import { internal } from './_generated/api';
const mutation = (name: string) => makeFunctionReference<'mutation'>(`githubBindingStore:${name}`);
const callbackUrl = () => {
  const site = process.env.CONVEX_SITE_URL;
  invariant(
    site && site.startsWith('https://'),
    'GITHUB_APP_CONFIG',
    'Configure the deployment HTTP site URL.',
  );
  return `${site.replace(/\/$/, '')}/github/oauth/callback`;
};
const random = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};
async function challenge(verifier: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
/** The verified GitHub account id linked to this Forge account (one indexed read per new
 * connection). The callback binds only for it. */
export async function linkedGithubAccounts(ctx: import('./_generated/server').ActionCtx, subject: string) {
  const ids = await ctx.runQuery(internal.authUsers.githubAccounts, { accountKey: subject });
  invariant(
    ids.length > 0,
    'GITHUB_ACCOUNT_REQUIRED',
    'Link a GitHub account to this Forge account, then connect again.',
  );
  return ids;
}
export const connect = action({
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    repository: v.string(),
    /** Default on: the owner's authorization also turns the GitHub mirror on. `false` connects only. */
    mirror: v.optional(v.boolean()),
    /** With the mirror: one-way, Forge to GitHub; pushes made on GitHub are not taken in. */
    oneWay: v.optional(v.boolean()),
    /** Item c63c2171: an agent's words for the owner, shown on the Forge decision it asks for. */
    reason: v.optional(v.string()),
  },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const repository = input.repository.toLowerCase();
      const { mirror, oneWay, reason, ...identity } = input;
      const replay: string | null = await ctx.runQuery(
        makeFunctionReference<'query'>('githubBindingStore:authorize'),
        { ...identity, repository },
      );
      if (replay) return replay;
      assertRepositoryName(repository);
      const clientId = process.env.GITHUB_APP_CLIENT_ID;
      invariant(
        clientId && process.env.GITHUB_APP_CLIENT_SECRET,
        'GITHUB_APP_CONFIG',
        'Configure GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET.',
      );
      // No repository or App installation lookup here: the callback resolves the
      // installation only after the authorizing user proves repository access.
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to connect GitHub.');
      const githubAccounts = await linkedGithubAccounts(ctx, user.subject);
      const state = random(),
        verifier = random();
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl(),
        state,
        code_challenge: await challenge(verifier),
        code_challenge_method: 'S256',
      }).toString();
      return await ctx.runMutation(mutation('start'), {
        ...identity,
        mirror: mirror !== false,
        ...(oneWay && mirror !== false ? { oneWay: true } : {}),
        ...(reason ? { reason } : {}),
        repository,
        githubAccounts,
        state,
        verifier,
        authorizeUrl: url.toString(),
      });
    } catch (error) {
      return report(error);
    }
  },
});
/** The token exists only on the callback/action stack or in the Forge-owned encrypted user row. The token must
 * belong to a GitHub account linked to the Forge account that started the
 * connection; `installation` runs only after repository access is proven. */
export async function proveRepository(
  userToken: string,
  repository: string,
  githubAccounts: readonly string[],
  installation: () => Promise<number>,
  request: typeof fetch = convexFetch,
) {
  const api = githubRequest(userToken, request);
  const account = await api<{ id: number }>('/user');
  invariant(
    Number.isSafeInteger(account.id) && account.id > 0 && githubAccounts.includes(String(account.id)),
    'GITHUB_ACCOUNT_MISMATCH',
    'Authorize with the GitHub account linked to the Forge account that started this connection.',
  );
  const repo = await api<{
    id: number;
    full_name: string;
    permissions?: { admin?: boolean; maintain?: boolean };
  }>(`/repos/${repository}`);
  invariant(
    Number.isSafeInteger(repo.id) &&
      repo.id > 0 &&
      repo.full_name?.toLowerCase() === repository.toLowerCase() &&
      (repo.permissions?.admin === true || repo.permissions?.maintain === true),
    'GITHUB_REPOSITORY_PERMISSION',
    'GitHub admin or maintain permission is required for this repository.',
  );
  const installationId = await installation();
  let page = 1;
  while (true) {
    const listed = await api<{ repositories: { id: number }[] }>(
      `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
    );
    invariant(
      Array.isArray(listed.repositories),
      'GITHUB_REPOSITORY_PERMISSION',
      'GitHub repository proof is unavailable.',
    );
    if (listed.repositories.some(row => row.id === repo.id))
      // The role says who can import the two-way ruleset (Admin) or must send it to an admin.
      return {
        repoId: repo.id,
        fullName: repo.full_name,
        role: repo.permissions?.admin === true ? ('admin' as const) : ('maintain' as const),
      };
    invariant(
      listed.repositories.length === 100,
      'GITHUB_REPOSITORY_PERMISSION',
      'The repository is not accessible through this GitHub App installation.',
    );
    page++;
  }
}
export const callback = httpAction(async (ctx, request) => {
  const params = new URL(request.url).searchParams;
  const state = params.get('state');
  const headers = {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Type': 'text/plain; charset=utf-8',
  };
  if (!state) return new Response('Invalid GitHub authorization state.', { status: 400, headers });
  let consumed = false;
  try {
    const op = JSON.parse(await ctx.runMutation(mutation('consume'), { state }));
    consumed = true;
    const code = params.get('code');
    invariant(code && !params.has('error'), 'GITHUB_OAUTH_DENIED', 'GitHub authorization was not completed.');
    const clientId = process.env.GITHUB_APP_CLIENT_ID,
      clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
    invariant(clientId && clientSecret, 'GITHUB_APP_CONFIG', 'GitHub user authorization is not configured.');
    const response = await convexFetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      redirect: 'error',
      signal: networkTimeout(30000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl(),
        code_verifier: op.verifier,
      }),
    });
    invariant(response.ok, 'GITHUB_OAUTH_FAILED', 'GitHub authorization exchange failed.');
    const value = (await response.json()) as {
      access_token?: string;
      error?: string;
      token_type?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    invariant(
      typeof value.access_token === 'string' && value.access_token.length > 0 && !value.error,
      'GITHUB_OAUTH_FAILED',
      'GitHub authorization exchange failed.',
    );
    const proof = await proveRepository(value.access_token, op.repository, op.githubAccounts, async () => {
      const { installation } = await appInstallation(op.repository, convexFetch, Date.now());
      await ctx.runMutation(mutation('pin'), { state, installationId: installation.id });
      return installation.id;
    });
    if (op.authOwner)
      await ctx.runAction(internal.githubUserTokenActions.storeConnection, {
        state,
        owner: op.authOwner,
        token: value.access_token,
        // An App with expiring user tokens also returns these; Forge renews on first use after expiry.
        ...(typeof value.refresh_token === 'string' && value.refresh_token
          ? { refreshToken: value.refresh_token }
          : {}),
        ...(typeof value.expires_in === 'number' && value.expires_in > 0
          ? { expiresIn: value.expires_in }
          : {}),
      });
    const mirror = await ctx.runMutation(mutation('complete'), { state, ...proof });
    return new Response(
      `GitHub repository connected.${
        mirror === 'enabled'
          ? ' Forge now mirrors main to it; nforge github status says which way. Pause or Disconnect in Forge → Settings → GitHub mirror (owner person).'
          : ''
      } You can return to Forge.`,
      { headers },
    );
  } catch (error) {
    const data = error instanceof ConvexError ? error.data : null;
    const structured = data && typeof data === 'object' && 'code' in data ? data.code : null;
    const code =
      error instanceof ForgeError
        ? error.code
        : typeof structured === 'string' && /^[A-Z_]{1,100}$/.test(structured)
          ? structured
          : 'GITHUB_OAUTH_FAILED';
    if (consumed) await ctx.runMutation(mutation('fail'), { state, code });
    return new Response(`GitHub connection failed (${code}). Start a new connection operation to retry.`, {
      status: 400,
      headers,
    });
  }
});
