// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { networkFailure } from './network-fetch.js';
import { ConvexError } from 'convex/values';
import { sourceAuthoritySchema, SourceAuthorityStaleError } from './hosted-source-authority.js';
import { convexErrorData, ForgeError } from './errors.js';

/** Why a hosted action failed, as a fixed word (never the raw message: it can carry private source or
 * credentials, 5a22ee20, friction 514b8223). `server-*` and `connection` happened at or on the way to
 * Forge; `local-*` and `cancelled` happened in this CLI before the outcome was known (Item 3f76a3df:
 * those were reported as "Hosted … failed (cause: unknown)"). */
export const hostedFailureCauses = [
  'server-timeout',
  'server-limit',
  'server-busy',
  'server-exception',
  'connection',
  'cancelled',
  'local-file',
  'local-permission',
  'local-disk',
  'local-process',
  'local-exception',
] as const;
export type HostedFailureCause = (typeof hostedFailureCauses)[number];
const errnoCause: Record<string, HostedFailureCause> = {
  EACCES: 'local-permission',
  EPERM: 'local-permission',
  EROFS: 'local-permission',
  ENOSPC: 'local-disk',
  EDQUOT: 'local-disk',
  EMFILE: 'local-process',
  ENFILE: 'local-process',
  ENOMEM: 'local-process',
  E2BIG: 'local-process',
  EAGAIN: 'local-process',
  ECONNRESET: 'connection',
  ECONNREFUSED: 'connection',
  ECONNABORTED: 'connection',
  EHOSTUNREACH: 'connection',
  ENETUNREACH: 'connection',
  ENETDOWN: 'connection',
  EAI_NONAME: 'connection',
  ENOTFOUND: 'connection',
  EPIPE: 'connection',
  ETIMEDOUT: 'connection',
  EAI_AGAIN: 'connection',
};
/** The local system error code (ENOENT, EACCES, …) a failure carries, if any. */
export function localErrno(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^E[A-Z0-9_]{2,40}$/.test(code) ? code : undefined;
}
const isConvexError = (error: unknown) =>
  error instanceof ConvexError || (error instanceof Error && error.name === 'ConvexError');
const fromServer = (error: unknown, text: string) =>
  isConvexError(error) || /\[Request ID:|Server Error|Uncaught /i.test(text);
/** What kind of failure an error was, from its class, system code and message only. */
export function hostedFailureCause(error: unknown): HostedFailureCause {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  const errno = localErrno(error);
  if (errno) return errnoCause[errno] ?? (errno.startsWith('ERR_') ? 'local-exception' : 'local-file');
  // A JavaScript runtime error raised here (a stack overflow says "exceeded") is this CLI's own.
  if (
    !fromServer(error, text) &&
    (error instanceof RangeError ||
      error instanceof ReferenceError ||
      error instanceof SyntaxError ||
      (error instanceof TypeError && !/fetch failed|network/i.test(text)))
  )
    return 'local-exception';
  if (/timed out|timeout|deadline|took too long/i.test(text)) return 'server-timeout';
  if (/too many (bytes|documents|reads|writes)|too large|exceeded|out of memory|memory limit/i.test(text))
    return 'server-limit';
  if (
    /try again later|overloaded|temporarily unavailable|rate limit|too many requests|\b50[234]\b/i.test(text)
  )
    return 'server-busy';
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|socket|websocket|fetch failed|disconnect|network/i.test(text))
    return 'connection';
  if (fromServer(error, text) || /server error|uncaught|internal/i.test(text)) return 'server-exception';
  return 'local-exception';
}
/** A retry of the same operation can succeed: not a limit the request will hit again, and not a local
 * permission or disk problem the caller must fix first. */
export const transientFailureCause = (cause: string) =>
  !['server-limit', 'local-permission', 'local-disk', 'cancelled'].includes(cause);
/** The `(cause: …; Convex request ID: …)` part of a hosted failure message, so callers that rewrite
 * the message keep the one handle that finds the server-side log. */
export const hostedFailureDetail = (message: string) =>
  /^(?:Hosted|Local step of) [^(]*failed( \(cause: [^)]*\))/.exec(message)?.[1] ?? '';
/** The cause word of a hosted failure message, or undefined when it names none. */
export const hostedFailureCauseOf = (message: string) =>
  /\(cause: ([a-z-]+)/.exec(hostedFailureDetail(message))?.[1] as HostedFailureCause | undefined;

/** Server messages can contain private source or credentials. Only copy the
 * platform's hexadecimal request ID into the actionable transport error. */
export function hostedActionError(error: unknown, phase: string): ForgeError {
  if (error instanceof ForgeError) return error;
  if (networkFailure(error)) return new ForgeError(error.code, error.message);
  const data = convexErrorData(error);
  if (data) {
    if (data.code === 'SOURCE_AUTHORITY_STALE') {
      const authority = sourceAuthoritySchema.safeParse(data.authority);
      if (authority.success) return new SourceAuthorityStaleError(authority.data);
    }
    // The server's own wrap of an unexpected exception (convex/errors.ts) names no cause: classify it
    // below with its request ID instead of passing its generic text on (Item 3f76a3df).
    if (
      typeof data.code === 'string' &&
      typeof data.message === 'string' &&
      data.code !== 'INTERNAL_ERROR' &&
      data.code !== 'HOSTED_ACTION_FAILED'
    )
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
  const cause = isConvexError(error) ? 'server-exception' : hostedFailureCause(error);
  const local = cause.startsWith('local-') || cause === 'cancelled';
  const errno = local ? localErrno(error) : undefined;
  const detail = `cause: ${cause}${errno ? `; ${errno}` : ''}${requestId ? `; Convex request ID: ${requestId}` : ''}`;
  return new ForgeError(
    'HOSTED_ACTION_FAILED',
    local
      ? `Local step of ${phase} failed (${detail}) on this machine before its outcome was known; nothing was claimed as done. ${transientFailureCause(cause) ? 'Replay the same command: the retained operation reconciles' : 'Fix the named local problem, then replay the same command'}.`
      : `Hosted ${phase} failed (${detail}). ${cause === 'server-limit' ? 'A retry is likely to fail the same way: record friction with this cause' : 'Push again to resume the retained operation'}; if it persists, inspect the deployment's action logs${requestId ? ' for this request ID' : ''}.`,
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
