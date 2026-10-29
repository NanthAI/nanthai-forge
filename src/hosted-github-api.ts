// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
export type GithubRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
/** Errors never include response bodies, request payloads or credentials. */
export function githubRequest(token: string, request: typeof fetch = fetch): GithubRequest {
  return async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
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
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    invariant(
      response.ok,
      'GITHUB_SYNC_API',
      `GitHub mirror API returned HTTP ${response.status}. Retry the retained mirror step.`,
    );
    return (await response.json()) as T;
  };
}
