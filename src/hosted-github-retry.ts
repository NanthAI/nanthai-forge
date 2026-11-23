// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** One bounded policy for GitHub read-after-write lag on objects the mirror job
 * itself just created or uploaded (incident 8568bc76; adff6f58). Pure data and
 * patterns, so Convex mutations and the mirror runner share it. */

/** Scheduled backoff before each extra try; its length is the retry budget. */
export const missingObjectDelays = [2_000, 10_000] as const;

/** POST git/trees: "tree.sha X is not a valid blob" for a blob this job uploaded. */
export const treeBlobPattern = /\btree\.sha ([0-9a-f]{40}) is not a valid blob\b/;

/** POST git/commits: "Tree SHA does not exist" for the tree this job just created. */
export const commitTreePattern = /\bTree SHA(?: [0-9a-f]{40})? does not exist\b/i;

/** POST git/trees: GitHub gave up on the work behind one base_tree call ("Sorry, your request
 * timed out. ... Consider building the tree incrementally"), State 6f14cecd on 59-64 KB pieces.
 * Not a refusal: the mirror splits the piece, then builds per directory (hosted-github-mirror.ts). */
export const treeTimeoutPattern = /\brequest timed out\b/i;
export function isTreeTimeout(status: number, operation: string, githubError: string | undefined): boolean {
  return status === 422 && operation === 'POST git/trees' && treeTimeoutPattern.test(githubError ?? '');
}
/** GitHub 4xx answers that are not refusals and clear by waiting: a tree timeout that still
 * reaches the scheduler, or a 403 primary or secondary rate limit. They take the 429/5xx budget. */
export function isRetryable4xx(status: number, operation: string, githubError: string | undefined): boolean {
  return (
    isTreeTimeout(status, operation, githubError) ||
    (status === 403 && /\brate limit\b/i.test(githubError ?? ''))
  );
}

/** True when a 422 from git/trees or git/commits names a missing or invalid
 * SHA of this job's own objects. Every other 422 stays terminal. */
export function isMissingObject(status: number, operation: string, githubError: string | undefined): boolean {
  if (status !== 422 || !githubError) return false;
  if (operation === 'POST git/trees') return treeBlobPattern.test(githubError);
  if (operation === 'POST git/commits') return commitTreePattern.test(githubError);
  return false;
}

/** Mirror failures that are not a GitHub HTTP answer but can clear on their own:
 * a transport fault or deadline (`networkFetch` raises NetworkTransportError,
 * not a ForgeError), unavailable source bytes, GitHub LFS 5xx, and any other
 * unexpected exception. They share the 429/5xx budget (`transientAttempts` below)
 * instead of stopping the queue terminally with no retry (incident 2026-11-09,
 * State c36418d6: a generic GITHUB_SYNC_FAILED held GitHub main for 17 min). */
export const transientMirrorCodes: readonly string[] = [
  'GITHUB_SYNC_NETWORK',
  'GITHUB_SYNC_FAILED',
  'SOURCE_UNAVAILABLE',
  'GITHUB_UNAVAILABLE',
];

const knownExceptions = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'TimeoutError',
  'AbortError',
  'ConvexError',
  'NetworkTransportError',
  'SourceIoError',
];

/** Code and bounded, credential-free detail for an exception that is not a
 * ForgeError, so the job row keeps the real cause. URLs, long opaque runs and
 * the given secrets are removed; at most 240 characters of message remain. */
export function unexpectedMirrorFailure(
  error: unknown,
  secrets: string[] = [],
): { code: string; detail: string } {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const name = error instanceof Error && knownExceptions.includes(error.name) ? error.name : 'UnknownError';
  const raw =
    typeof record.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(record.code) ? record.code : null;
  const network = raw === 'EXCHANGE_REQUEST_FAILED' || raw === 'EXCHANGE_REQUEST_TIMEOUT';
  // A JSON SyntaxError quotes its input (a response body): keep only the fact.
  let message = name === 'SyntaxError' ? 'not valid JSON' : error instanceof Error ? error.message : '';
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
  message = message
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240)
    .replace(/[.\s]+$/, '');
  const extra = [
    raw && !network ? raw : null,
    typeof record.stage === 'string' && /^[a-z-]{1,32}$/.test(record.stage) ? `stage ${record.stage}` : null,
    Number.isInteger(record.httpStatus) ? `HTTP ${record.httpStatus}` : null,
  ].filter(Boolean);
  return {
    code: network ? 'GITHUB_SYNC_NETWORK' : 'GITHUB_SYNC_FAILED',
    detail: `Mirror step stopped on ${raw && network ? raw : name}${extra.length ? ` (${extra.join(', ')})` : ''}${message ? `: ${message}` : ''}.`,
  };
}

/** Tries for a GitHub 429/5xx or a transient fault before the mirror stops and asks a person.
 * 1, 2, 4, 8, 15, 15, 15 minutes (about an hour) with +-20% jitter: a GitHub outage that
 * outlasts it is a real stop (2026-11-23: five 502s in 15 minutes held 11 landings). */
export const transientAttempts = 8;
export const transientDelayCapMs = 15 * 60_000;

/** Delay before the next try after `failures` consecutive transient failures, or null when spent. */
export function transientDelay(failures: number, random: () => number = Math.random): number | null {
  if (failures >= transientAttempts) return null;
  const base = Math.min(60_000 * 2 ** (failures - 1), transientDelayCapMs);
  return Math.round(base * (0.8 + 0.4 * random()));
}
