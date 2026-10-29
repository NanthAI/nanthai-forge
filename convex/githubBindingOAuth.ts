// SPDX-License-Identifier: Apache-2.0
import { ConvexError, v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { action } from './cliServer';
import { httpAction } from './_generated/server';
import { appInstallation } from './githubAppToken';
import { githubRequest } from '../src/hosted-github-api';
import { ForgeError, invariant } from '../src/errors';
import { report } from './errors';
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
export const connect = action({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), repository: v.string() },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      const repository = input.repository.toLowerCase();
      const replay: string | null = await ctx.runQuery(
        makeFunctionReference<'query'>('githubBindingStore:authorize'),
        { ...input, repository },
      );
      if (replay) return replay;
      const clientId = process.env.GITHUB_APP_CLIENT_ID;
      invariant(
        clientId && process.env.GITHUB_APP_CLIENT_SECRET,
        'GITHUB_APP_CONFIG',
        'Configure GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET.',
      );
      const { installation } = await appInstallation(repository, fetch, Date.now());
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
        ...input,
        repository,
        installationId: installation.id,
        state,
        verifier,
        authorizeUrl: url.toString(),
      });
    } catch (error) {
      return report(error);
    }
  },
});
/** This function's token exists only on the action stack. Only a numeric repo
 * identity and canonical name cross back into the database. */
export async function proveRepository(
  userToken: string,
  installationId: number,
  repository: string,
  request: typeof fetch = fetch,
) {
  const api = githubRequest(userToken, request);
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
      return { repoId: repo.id, fullName: repo.full_name };
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
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
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
    const value = (await response.json()) as { access_token?: string; error?: string; token_type?: string };
    invariant(
      typeof value.access_token === 'string' && value.access_token.length > 0 && !value.error,
      'GITHUB_OAUTH_FAILED',
      'GitHub authorization exchange failed.',
    );
    const proof = await proveRepository(value.access_token, op.installationId, op.repository);
    await ctx.runMutation(mutation('complete'), { state, ...proof });
    return new Response('GitHub repository connected. You can return to Forge.', { headers });
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
