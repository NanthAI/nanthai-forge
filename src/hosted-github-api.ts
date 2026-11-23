// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { networkFetch, networkTimeout } from './network-fetch.js';
import { ForgeError } from './errors.js';
import { githubRulesetRefusal } from './github-sync-classification.js';
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
export const githubErrorChars = 500;
/** GitHub's JSON error `message` and `errors[]` explain a 4xx (for example
 * which tree entry a 422 rejected). Only those fields of a JSON body are kept:
 * controls stripped, token-shaped and request-token text redacted, bounded. */
function githubErrorDiagnostics(
  body: string,
  token?: string,
  refWrite422 = false,
): { summary?: string; ruleBlocked?: boolean } {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object') return {};
  const { message, errors } = value as { message?: unknown; errors?: unknown };
  const field = (item: unknown) =>
    typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? ['resource', 'field', 'code', 'message']
            .map(key => (item as Record<string, unknown>)[key])
            .filter(part => typeof part === 'string' && part)
            .join(' ')
        : '';
  const clean = (part: string) => {
    if (token) part = part.split(token).join('[redacted]');
    return part
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})/g, '[redacted]')
      .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
      .trim();
  };
  const headline = typeof message === 'string' ? clean(message) : '';
  const details = Array.isArray(errors) ? errors.slice(0, 10).map(item => clean(field(item))) : [];
  const ruleBlocked = refWrite422 && (githubRulesetRefusal(headline) || details.some(githubRulesetRefusal));
  // Classify before truncating and give the rule details priority over the headline.
  const text = (ruleBlocked ? [...details, headline] : [headline, ...details]).filter(Boolean).join('; ');
  if (!text) return {};
  const chars = [...text];
  const summary =
    chars.length > githubErrorChars ? `${chars.slice(0, githubErrorChars - 1).join('')}…` : text;
  return { summary, ruleBlocked };
}
export function githubErrorSummary(body: string, token?: string): string | undefined {
  return githubErrorDiagnostics(body, token).summary;
}
export class GithubMirrorApiError extends ForgeError {
  constructor(
    readonly status: number,
    readonly operation: string,
    readonly requestBytes: number,
    responseHeaders?: Headers,
    readonly githubError?: string,
    ruleBlocked = false,
  ) {
    const { code, next } = ruleBlocked
      ? {
          code: 'GITHUB_RULE_BLOCKED',
          next: 'Review the blocking rule in GitHub before resuming the mirror.',
        }
      : { code: 'GITHUB_SYNC_API', next: 'Retry the retained mirror step.' };
    super(
      code,
      `GitHub mirror API returned HTTP ${status} for ${operation} (${requestBytes} request bytes).${responseDiagnostics(responseHeaders)}${githubError ? ` GitHub error: ${JSON.stringify(githubError)}.` : ''} ${next}`,
    );
  }
}
/** Errors never include request payloads, credentials or raw response bodies;
 * a JSON error keeps only its bounded `message` and `errors[]` summary. */
export function githubRequest(token: string, request: typeof fetch = networkFetch): GithubRequest {
  return async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const response = await request(`https://api.github.com${path}`, {
      method,
      redirect: 'error',
      signal: networkTimeout(30000),
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
      const route = path.match(/^\/repos\/[^/]+\/[^/]+\/git\/(blobs|trees|commits|refs?)(?:[/?]|$)/)?.[1];
      const verb = ['GET', 'POST', 'PATCH'].includes(method) ? method : 'request';
      const { summary, ruleBlocked } = githubErrorDiagnostics(
        (await response.text().catch(() => '')).slice(0, 64 * 1024),
        token,
        response.status === 422 && route === 'refs' && (verb === 'PATCH' || verb === 'POST'),
      );
      throw new GithubMirrorApiError(
        response.status,
        `${verb} ${route ? `git/${route}` : path.endsWith('/installation') ? 'installation lookup' : /\/app\/installations\/\d+\/access_tokens$/.test(path) ? 'installation token' : 'GitHub API'}`,
        payload === undefined ? 0 : new TextEncoder().encode(payload).byteLength,
        response.headers,
        summary,
        ruleBlocked,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };
}
