// SPDX-License-Identifier: Apache-2.0
import { networkFailure } from './network-fetch.js';
import { ConvexError } from 'convex/values';
import { sourceAuthoritySchema, SourceAuthorityStaleError } from './hosted-source-authority.js';
import { ForgeError } from './errors.js';

/** What kind of failure a platform error was, from its message only. The class is a fixed word: the
 * message itself can carry private source, so it is never copied (5a22ee20, friction 514b8223). */
export function hostedFailureCause(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/timed out|timeout|deadline|took too long/i.test(text)) return 'server-timeout';
  if (/too many (bytes|documents|reads|writes)|too large|exceeded|out of memory|memory limit/i.test(text))
    return 'server-limit';
  if (
    /try again later|overloaded|temporarily unavailable|rate limit|too many requests|\b50[234]\b/i.test(text)
  )
    return 'server-busy';
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|socket|websocket|fetch failed|disconnect|network/i.test(text))
    return 'connection';
  if (/server error|uncaught|internal/i.test(text)) return 'server-exception';
  return 'unknown';
}
/** The `(cause: …; Convex request ID: …)` part of a hosted failure message, so callers that rewrite
 * the message keep the one handle that finds the server-side log. */
export const hostedFailureDetail = (message: string) =>
  /^Hosted [^(]*failed( \(cause: [^)]*\))/.exec(message)?.[1] ?? '';

/** Server messages can contain private source or credentials. Only copy the
 * platform's hexadecimal request ID into the actionable transport error. */
export function hostedActionError(error: unknown, phase: string): ForgeError {
  if (error instanceof ForgeError) return error;
  if (networkFailure(error)) return new ForgeError(error.code, error.message);
  if (error instanceof ConvexError && error.data && typeof error.data === 'object') {
    const data = error.data as {
      code?: unknown;
      message?: unknown;
      authority?: unknown;
      retryAt?: unknown;
      recovery?: unknown;
    };
    if (data.code === 'SOURCE_AUTHORITY_STALE') {
      const authority = sourceAuthoritySchema.safeParse(data.authority);
      if (authority.success) return new SourceAuthorityStaleError(authority.data);
    }
    if (typeof data.code === 'string' && typeof data.message === 'string' && data.code !== 'INTERNAL_ERROR')
      // A refusal that names its end (a write pause) keeps it: Issue 72d50375.
      return new ForgeError(
        data.code,
        data.message,
        Number.isSafeInteger(data.retryAt) ? (data.retryAt as number) : undefined,
        data.code === 'ITEM_CHANGED' && data.recovery && typeof data.recovery === 'object'
          ? (data.recovery as Record<string, unknown>)
          : undefined,
      );
  }
  const requestId =
    error instanceof Error ? /\[Request ID:\s*([a-f0-9]+)\]/i.exec(error.message)?.[1] : undefined;
  const cause = hostedFailureCause(error);
  return new ForgeError(
    'HOSTED_ACTION_FAILED',
    `Hosted ${phase} failed (cause: ${cause}${requestId ? `; Convex request ID: ${requestId}` : ''}). ${cause === 'server-limit' ? 'A retry is likely to fail the same way: record friction with this cause' : 'Push again to resume the retained operation'}; if it persists, inspect the deployment's action logs${requestId ? ' for this request ID' : ''}.`,
  );
}

/** Reading a project's main (clone, pull): the server's structured refusal keeps its code instead of
 * surfacing as INTERNAL_ERROR, and a project with no accepted main yet says so. */
export function mainDiscoveryError(error: unknown): ForgeError {
  const safe = hostedActionError(error, 'main discovery');
  return safe.code === 'PROJECT_WORK_MISSING'
    ? new ForgeError(
        'PROJECT_WORK_MISSING',
        'This project has no source yet (a new empty project has no accepted main), so there is nothing to clone. Host or import source into it first: nforge host ROOT, or nforge import OWNER/NAME.',
      )
    : safe;
}
