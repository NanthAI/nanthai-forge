// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
export type GithubRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export class GithubMirrorApiError extends ForgeError {
  constructor(
    readonly status: number,
    readonly operation: string,
    readonly requestBytes: number,
  ) {
    super(
      'GITHUB_SYNC_API',
      `GitHub mirror API returned HTTP ${status} for ${operation} (${requestBytes} request bytes). Retry the retained mirror step.`,
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
      );
    }
    return (await response.json()) as T;
  };
}
