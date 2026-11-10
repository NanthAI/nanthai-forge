// SPDX-License-Identifier: Apache-2.0
import { networkFetch, networkTimeout } from './network-fetch.js';
import { githubRepository, type GithubFetch, type GithubRepository } from './github.js';
import { ForgeError, invariant } from './errors.js';

export interface GithubAccessConfig {
  clerkSecret?: string | undefined;
  appClientId?: string | undefined;
  appClientSecret?: string | undefined;
  publicToken?: string | undefined;
  /** The Forge GitHub App's URL slug; used only to link its install page when GitHub names no installation. */
  appSlug?: string | undefined;
}
type Installation = {
  id?: number;
  app_slug?: string;
  html_url?: string;
  repository_selection?: string;
  account?: { login?: string; type?: string };
};

/** One bounded read of the App installations the user can see, on the failure path only. */
async function installationFailure(
  repository: string,
  token: string,
  config: GithubAccessConfig,
  request: GithubFetch,
): Promise<ForgeError | null> {
  const owner = repository.split('/')[0]!;
  const found: Installation[] = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const response = await request(`https://api.github.com/user/installations?per_page=100&page=${page}`, {
        signal: networkTimeout(30_000),
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'NanthAi-Forge',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!response.ok) return null;
      const listed = (await response.json()) as { installations?: Installation[] };
      if (!Array.isArray(listed.installations)) return null;
      found.push(...listed.installations);
      if (listed.installations.length < 100) break;
    }
  } catch {
    return null;
  }
  const installation = found.find(row => row.account?.login?.toLowerCase() === owner.toLowerCase());
  const slug = found.find(row => row.app_slug)?.app_slug ?? config.appSlug;
  if (!installation) {
    const step = slug
      ? `Install it at https://github.com/apps/${encodeURIComponent(slug)}/installations/new`
      : 'Use Connect GitHub repositories on the import page to install it';
    return new ForgeError(
      'GITHUB_UNAVAILABLE',
      `The Forge GitHub App is not installed for ${owner}, so ${repository} is not available. ${step} and select ${repository}, then retry.`,
    );
  }
  const configure =
    installation.html_url?.startsWith('https://github.com/') && installation.html_url.length < 300
      ? installation.html_url
      : installation.account?.type === 'Organization'
        ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/installations/${installation.id}`
        : `https://github.com/settings/installations/${installation.id}`;
  if (installation.repository_selection === 'selected')
    return new ForgeError(
      'GITHUB_UNAVAILABLE',
      `${repository} is not in the Forge GitHub App installation for ${owner}, which is limited to selected repositories. Open ${configure}, add ${repository} under Repository access, then retry.`,
    );
  return new ForgeError(
    'GITHUB_UNAVAILABLE',
    `GitHub did not return ${repository} although the Forge GitHub App is installed for ${owner}. Check the repository name and your access to it; installation settings: ${configure}.`,
  );
}
/** Explicit setup diagnostic; checks sign-in independently of repository visibility. */
export async function checkGithubSignIn(
  userId: string | undefined,
  config: GithubAccessConfig,
  request: GithubFetch = networkFetch,
): Promise<void> {
  await githubUserToken(userId, config, request);
}

async function githubUserToken(
  userId: string | undefined,
  config: GithubAccessConfig,
  request: GithubFetch,
): Promise<string> {
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
      signal: networkTimeout(30_000),
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
      signal: networkTimeout(30_000),
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
  if (!checked.ok) {
    if (checked.status === 401)
      throw new ForgeError(
        'GITHUB_SETUP_REQUIRED',
        'GitHub rejected this deployment’s App client credentials. Set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET to the same GitHub App.',
      );
    if (checked.status === 404) {
      // A live user token that this App cannot check belongs to another App.
      const user = await request('https://api.github.com/user', {
        redirect: 'error',
        signal: networkTimeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'NanthAi-Forge',
        },
      });
      if (user.ok)
        throw new ForgeError(
          'GITHUB_SETUP_REQUIRED',
          'GitHub sign-in uses a different GitHub App than this deployment. Set the sign-in provider’s GitHub client ID and secret to this deployment’s App, then reconnect GitHub. Use a separate sign-in instance when deployments use different Apps.',
        );
      if (user.status === 401)
        throw new ForgeError(
          'GITHUB_UNAVAILABLE',
          'The GitHub sign-in token has expired or been revoked. Reconnect GitHub.',
        );
    }
    throw new ForgeError(
      'GITHUB_UNAVAILABLE',
      'GitHub could not validate the sign-in token. Retry when GitHub is available; check the deployment’s GitHub App connection if the failure persists.',
    );
  }
  return token;
}

export async function authorizeGithub(
  repository: string,
  userId: string | undefined,
  config: GithubAccessConfig,
  request: GithubFetch = networkFetch,
): Promise<{ repository: GithubRepository; token: string | undefined }> {
  try {
    const repo = await githubRepository(repository, config.publicToken, request);
    if (!repo.private) return { repository: repo, token: config.publicToken };
  } catch (error) {
    if (!(error instanceof ForgeError) || error.code !== 'GITHUB_UNAVAILABLE') throw error;
    if (config.publicToken) {
      // A deployment credential can be expired or restricted even for public repositories.
      // Only anonymous metadata can establish this fallback's public authority.
      try {
        const repo = await githubRepository(repository, undefined, request);
        if (!repo.private) return { repository: repo, token: undefined };
      } catch (anonymousError) {
        if (!(anonymousError instanceof ForgeError) || anonymousError.code !== 'GITHUB_UNAVAILABLE')
          throw anonymousError;
      }
    }
  }
  const token = await githubUserToken(userId, config, request);
  // GitHub App user tokens enforce the intersection of the human's access and the App's selected repositories.
  try {
    return { repository: await githubRepository(repository, token, request), token };
  } catch (error) {
    if (!(error instanceof ForgeError) || error.code !== 'GITHUB_UNAVAILABLE') throw error;
    throw (await installationFailure(repository, token, config, request)) ?? error;
  }
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
