// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
export type GithubRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
function responseDiagnostics(headers?: Headers): string {
  const fields: string[] = [];
  const requestId = headers?.get('x-github-request-id');
  if (requestId && /^[a-f0-9:]{1,100}$/i.test(requestId)) fields.push(`request ID ${requestId}`);
  for (const [header, label] of [
    ['x-ratelimit-remaining', 'rate limit remaining'],
    ['x-ratelimit-reset', 'rate limit reset'],
    ['retry-after', 'retry after seconds'],
  ]) {
    const value = headers?.get(header!);
    if (value && /^\d{1,12}$/.test(value)) fields.push(`${label} ${value}`);
  }
  return fields.length ? ` GitHub response: ${fields.join('; ')}.` : '';
}
export class GithubMirrorApiError extends ForgeError {
  constructor(
    readonly status: number,
    readonly operation: string,
    readonly requestBytes: number,
    responseHeaders?: Headers,
  ) {
    super(
      'GITHUB_SYNC_API',
      `GitHub mirror API returned HTTP ${status} for ${operation} (${requestBytes} request bytes).${responseDiagnostics(responseHeaders)} Retry the retained mirror step.`,
    );
  }
}
/** Errors never include response bodies, request payloads or credentials. */
export function githubRequest(token: string, request: typeof fetch = fetch): GithubRequest {
  return async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const response = await request(`https://api.github.com${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'NanthAI-Forge',
        'Content-Type': 'application/json',
      },
      ...(payload === undefined ? {} : { body: payload }),
    });
    if (!response.ok) {
      // Only fixed operation names leave the transport, never arbitrary URL text.
      const route = path.match(/\/git\/(blobs|trees|commits|refs?)(?:[/?]|$)/)?.[1];
      const verb = ['GET', 'POST', 'PATCH'].includes(method) ? method : 'request';
      throw new GithubMirrorApiError(
        response.status,
        `${verb} ${route ? `git/${route}` : path.endsWith('/installation') ? 'installation lookup' : /\/app\/installations\/\d+\/access_tokens$/.test(path) ? 'installation token' : 'GitHub API'}`,
        payload === undefined ? 0 : new TextEncoder().encode(payload).byteLength,
        response.headers,
      );
    }
    return (await response.json()) as T;
  };
}
