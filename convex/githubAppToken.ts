// SPDX-License-Identifier: Apache-2.0
// One GitHub App access module for the hosted mirror and Actions checks. It
// runs in the default Convex runtime (WebCrypto, no Node), so mutation-bearing
// modules may import it. Tokens are never persisted or logged.
import { makeFunctionReference } from 'convex/server';
import type { Id } from './_generated/dataModel';
import { operatorBinding } from './githubBindingAccess';
import type { ActionCtx } from './_generated/server';
import { githubRequest } from '../src/hosted-github-api';
import { ForgeError, invariant } from '../src/errors';
export type GithubAppPermissions = Record<string, 'read' | 'write'>;
/** Least privilege for check dispatch/cancel; checks create no refs or commits. */
export const actionsPermissions: GithubAppPermissions = { actions: 'write', contents: 'read' };
const encoder = new TextEncoder();
const bytes = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const base64url = (value: Uint8Array) => {
  let text = '';
  for (const byte of value) text += String.fromCharCode(byte);
  return btoa(text).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
};
function der(tag: number, value: Uint8Array) {
  const length = value.length;
  const prefix = length < 128 ? [length] : length < 256 ? [129, length] : [130, length >> 8, length & 255];
  return new Uint8Array([tag, ...prefix, ...value]);
}
/** RS256 App JWT. GitHub generates PKCS#1 keys; WebCrypto imports PKCS#8, so
 * PKCS#1 is wrapped in a PKCS#8 envelope. */
export async function githubAppJwt(id: string, pem: string, now = Date.now()) {
  let key = bytes(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''));
  if (pem.includes('BEGIN RSA PRIVATE KEY'))
    key = der(
      48,
      new Uint8Array([2, 1, 0, 48, 13, 6, 9, 42, 134, 72, 134, 247, 13, 1, 1, 1, 5, 0, ...der(4, key)]),
    );
  const imported = await crypto.subtle.importKey(
    'pkcs8',
    key,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const encode = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));
  const seconds = Math.floor(now / 1000);
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: id })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', imported, encoder.encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}
type Installation = { id: number; permissions?: Record<string, string> };
export async function appInstallation(repo: string, request: typeof fetch, now: number) {
  invariant(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && repo.split('/').every(p => p !== '.' && p !== '..'),
    'BAD_REPOSITORY',
    'Select OWNER/NAME.',
  );
  const id = process.env.GITHUB_APP_ID,
    key = process.env.GITHUB_APP_PRIVATE_KEY;
  invariant(
    id && key,
    'GITHUB_APP_CONFIG',
    'Configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY for the installed GitHub App.',
  );
  const api = githubRequest(await githubAppJwt(id, key, now), request);
  const installation = await api<Installation>(`/repos/${repo}/installation`);
  invariant(
    Number.isSafeInteger(installation.id) && installation.id > 0,
    'GITHUB_APP_CONFIG',
    'GitHub App installation is unavailable.',
  );
  return { api, installation };
}
/** Raw mint is deliberately private: all callers must first select proven IDs. */
async function mintInstallationToken(
  api: ReturnType<typeof githubRequest>,
  installationId: number,
  scope: { repository_ids: number[] } | { repositories: string[] },
  permissions?: GithubAppPermissions,
): Promise<string> {
  const result = await api<{ token: string }>(`/app/installations/${installationId}/access_tokens`, 'POST', {
    ...scope,
    ...(permissions ? { permissions } : {}),
  });
  invariant(
    typeof result.token === 'string' && result.token.length > 0,
    'GITHUB_APP_CONFIG',
    'GitHub App token is unavailable.',
  );
  return result.token;
}
/** Import reads on the App's own quota, never the importer's: contents and
 * metadata read on exactly one repository, by the numeric ID an authorized
 * lookup returned. Null when the App is not configured or not installed there,
 * in which case the caller keeps its already authorized credential. */
export async function importReadToken(repo: string, repoId: unknown, request: typeof fetch = fetch) {
  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY) return null;
  if (typeof repoId !== 'number' || !Number.isSafeInteger(repoId) || repoId <= 0) return null;
  try {
    const { api, installation } = await appInstallation(repo, request, Date.now());
    return await mintInstallationToken(
      api,
      installation.id,
      { repository_ids: [repoId] },
      { contents: 'read', metadata: 'read' },
    );
  } catch (error) {
    if (error instanceof ForgeError) return null;
    throw error;
  }
}
/** Read-only preflight: the App is installed on the repository and its accepted
 * permissions cover the request. One GitHub call; no token is minted. A pending
 * permission approval leaves the old set, so it is reported here. */
export async function requireInstallationPermissions(
  repo: string,
  required: GithubAppPermissions,
  request: typeof fetch = fetch,
  now = Date.now(),
) {
  const { installation } = await appInstallation(repo, request, now);
  const missing = Object.entries(required)
    .filter(([name, level]) => {
      const granted = installation.permissions?.[name];
      return !(granted === 'write' || (level === 'read' && granted === 'read'));
    })
    .map(([name, level]) => `${name}:${level}`);
  invariant(
    missing.length === 0,
    'GITHUB_APP_PERMISSIONS',
    `The GitHub App installation on ${repo} lacks ${missing.join(', ')}. Approve the App's requested permissions in GitHub, then retry.`,
  );
}
/** Explicit operator override for installations without the OAuth setup. */
export function assertRepositoryBinding(
  projectId: string,
  repo: string,
  bindings = process.env.FORGE_GITHUB_REPO_BINDINGS,
) {
  invariant(
    operatorBinding(projectId, repo, bindings),
    'GITHUB_REPOSITORY_UNBOUND',
    'Connect this repository to this Forge project with nforge github connect.',
  );
}
type BindingPage = { page: { repoId: number }[]; isDone: boolean; continueCursor: string };
/** Discovery tokens have metadata read only and contain exclusively proven IDs
 * for this project. This handles private repository renames without first minting
 * an unproven name-scoped token or retaining a user's OAuth credential. */
async function repositoryScope(
  ctx: ActionCtx,
  projectId: string,
  repo: string,
  api: ReturnType<typeof githubRequest>,
  installationId: number,
  request: typeof fetch,
) {
  if (operatorBinding(projectId, repo)) return { repositories: [repo.split('/')[1]!] };
  let cursor: string | null = null;
  do {
    const page: BindingPage = JSON.parse(
      await ctx.runQuery(makeFunctionReference<'query'>('githubBindingStore:page'), {
        projectId: projectId as Id<'hostedProjects'>,
        installationId,
        cursor,
      }),
    );
    if (page.page.length) {
      const ids = page.page.map(row => row.repoId);
      const probe = await mintInstallationToken(
        api,
        installationId,
        { repository_ids: ids },
        { metadata: 'read' },
      );
      const response = await request(`https://api.github.com/repos/${repo}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: {
          Authorization: `Bearer ${probe}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'NanthAI-Forge',
        },
      });
      invariant(
        response.ok || response.status === 404,
        'GITHUB_SYNC_API',
        `GitHub repository lookup failed (${response.status}).`,
      );
      if (response.ok) {
        const selected = (await response.json()) as { id: number; full_name: string };
        if (ids.includes(selected.id) && selected.full_name?.toLowerCase() === repo.toLowerCase()) {
          await ctx.runMutation(makeFunctionReference<'mutation'>('githubBindingStore:refreshName'), {
            projectId,
            installationId,
            repoId: selected.id,
            fullName: selected.full_name,
          });
          return { repository_ids: [selected.id] };
        }
      }
    }
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);
  invariant(
    false,
    'GITHUB_REPOSITORY_UNBOUND',
    'Connect this repository to this Forge project with nforge github connect.',
  );
}
/** Configure preflight proves identity before allowing the runner setting. */
export async function requireRepositoryBinding(ctx: ActionCtx, projectId: string, repo: string) {
  const { api, installation } = await appInstallation(repo, fetch, Date.now());
  await repositoryScope(ctx, projectId, repo, api, installation.id, fetch);
}
/** Stable shared API for mirror, Actions dispatch and cancellation. */
export async function installationToken(
  ctx: ActionCtx,
  projectId: string,
  repo: string,
  permissions?: GithubAppPermissions,
  request: typeof fetch = fetch,
  now = Date.now(),
): Promise<string> {
  const { api, installation } = await appInstallation(repo, request, now);
  const scope = await repositoryScope(ctx, projectId, repo, api, installation.id, request);
  const token = await mintInstallationToken(api, installation.id, scope, permissions);
  if (scope.repository_ids)
    await ctx.runQuery(makeFunctionReference<'query'>('githubBindingStore:requireId'), {
      projectId,
      installationId: installation.id,
      repoId: scope.repository_ids[0],
    });
  return token;
}
/** Raw App-authenticated request for endpoints whose status matters (dispatch
 * returns 200 with run details or 204). Bodies are never echoed in errors. */
export async function githubAppRequest(path: string, token: string, request = fetch, body?: unknown) {
  const response = await request(`https://api.github.com/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2026-03-10',
      'content-type': 'application/json',
      'user-agent': 'NanthAI-Forge',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  invariant(response.ok, 'RUNNER_UNAVAILABLE', `GitHub App request failed (${response.status}).`);
  return response;
}
