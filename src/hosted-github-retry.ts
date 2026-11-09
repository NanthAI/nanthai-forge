// SPDX-License-Identifier: Apache-2.0
/** One bounded policy for GitHub read-after-write lag on objects the mirror job
 * itself just created or uploaded (incident 8568bc76; adff6f58). Pure data and
 * patterns, so Convex mutations and the mirror runner share it. */

/** Scheduled backoff before each extra try; its length is the retry budget. */
export const missingObjectDelays = [2_000, 10_000] as const;

/** POST git/trees: "tree.sha X is not a valid blob" for a blob this job uploaded. */
export const treeBlobPattern = /\btree\.sha ([0-9a-f]{40}) is not a valid blob\b/;

/** POST git/commits: "Tree SHA does not exist" for the tree this job just created. */
export const commitTreePattern = /\bTree SHA(?: [0-9a-f]{40})? does not exist\b/i;

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
 * unexpected exception. They share the 429/5xx budget (5 tries, 1-8 min backoff)
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
