// SPDX-License-Identifier: Apache-2.0
import { githubRepository, type GithubFetch, type GithubRepository } from './github.js';
import { ForgeError, invariant } from './errors.js';

export interface GithubAccessConfig {
  clerkSecret?: string | undefined;
  appClientId?: string | undefined;
  appClientSecret?: string | undefined;
  publicToken?: string | undefined;
}
export async function authorizeGithub(
  repository: string,
  userId: string | undefined,
  config: GithubAccessConfig,
  request: GithubFetch = fetch,
): Promise<{ repository: GithubRepository; token: string | undefined }> {
  try {
    const repo = await githubRepository(repository, config.publicToken, request);
    if (!repo.private) return { repository: repo, token: config.publicToken };
  } catch (error) {
    if (!(error instanceof ForgeError) || error.code !== 'GITHUB_UNAVAILABLE') throw error;
  }
  invariant(
    userId,
    'GITHUB_UNAVAILABLE',
    'This repository is unavailable with the current access. Sign in with GitHub for private repositories.',
  );
  invariant(
    config.clerkSecret && config.appClientId && config.appClientSecret,
    'GITHUB_SETUP_REQUIRED',
    'Forge’s GitHub connection is not configured yet.',
  );
  const credentials = await request(
    `https://api.clerk.com/v1/users/${encodeURIComponent(userId)}/oauth_access_tokens/oauth_github`,
    {
      headers: { Authorization: `Bearer ${config.clerkSecret}` },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    },
  );
  invariant(
    credentials.ok,
    'GITHUB_UNAVAILABLE',
    'GitHub access is unavailable. Connect your GitHub account and selected repositories.',
  );
  const tokens = (await credentials.json()) as { token?: string }[];
  const token = tokens[0]?.token;
  invariant(
    token && token.startsWith('ghu_'),
    'GITHUB_UNAVAILABLE',
    'Use the Forge GitHub App connection for private repositories.',
  );
  // Check the token against this App, rather than trusting a token from another OAuth client.
  const checked = await request(
    `https://api.github.com/applications/${encodeURIComponent(config.appClientId)}/token`,
    {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ access_token: token }),
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.appClientId}:${config.appClientSecret}`).toString('base64')}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'NanthAi-Forge',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  invariant(
    checked.ok,
    'GITHUB_UNAVAILABLE',
    'The Forge GitHub authorization has expired or been revoked. Reconnect GitHub.',
  );
  // GitHub App user tokens enforce the intersection of the human's access and the App's selected repositories.
  return { repository: await githubRepository(repository, token, request), token };
}

export function assertImporter(
  visibility: 'public' | 'private',
  importer: string,
  caller: string | undefined,
): void {
  invariant(
    visibility === 'public' || (caller && importer === caller),
    'GITHUB_UNAVAILABLE',
    'This Codescape is unavailable with the current access.',
  );
}
