// SPDX-License-Identifier: Apache-2.0
// One GitHub App access module for the hosted mirror and Actions checks. It
// runs in the default Convex runtime (WebCrypto, no Node), so mutation-bearing
// modules may import it. Tokens are never persisted or logged.
import type { ActionCtx } from './_generated/server';
import { githubRequest } from '../src/hosted-github-api';
import { invariant } from '../src/errors';
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
async function appInstallation(repo: string, request: typeof fetch, now: number) {
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
/** Derives the repository's installation via the App on every call (no stored
 * installation ID), then mints a repository-scoped installation token. Omitted
 * permissions keep the App's installed set (the mirror needs Contents write). */
export async function mintInstallationToken(
  repo: string,
  request: typeof fetch = fetch,
  now = Date.now(),
  permissions?: GithubAppPermissions,
): Promise<string> {
  const { api, installation } = await appInstallation(repo, request, now);
  const result = await api<{ token: string }>(`/app/installations/${installation.id}/access_tokens`, 'POST', {
    repositories: [repo.split('/')[1]],
    ...(permissions ? { permissions } : {}),
  });
  invariant(
    typeof result.token === 'string' && result.token.length > 0,
    'GITHUB_APP_CONFIG',
    'GitHub App token is unavailable.',
  );
  return result.token;
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
/** Stable shared API for the mirror and Actions dispatch/cancel. */
export async function installationToken(
  _ctx: ActionCtx,
  repo: string,
  permissions?: GithubAppPermissions,
): Promise<string> {
  return mintInstallationToken(repo, fetch, Date.now(), permissions);
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
