// SPDX-License-Identifier: Apache-2.0
import { invariant } from './errors.js';
import type { GithubRepository } from './github.js';

export type HostedStatus = {
  sourceId: string;
  gitHead?: string;
  hosted: { license: string; [key: string]: unknown };
  [key: string]: unknown;
};
// Counts, analysis provenance and import-time attribution are immutable. Current
// repository metadata and upstream freshness are supplied by the authorized read.
export function hostedStatus(
  status: HostedStatus,
  endpoint: string,
  head: string,
  repository?: GithubRepository,
): object {
  const [name, search] = endpoint.split('?'),
    p = new URLSearchParams(search);
  invariant(name === 'status', 'NOT_FOUND', 'Unknown source query.');
  invariant(
    !p.get('state') || p.get('state') === status.sourceId,
    'STATE_MISMATCH',
    'This link names a different source state. Load the current state explicitly.',
  );
  invariant(
    !p.has('limit') || Number.isSafeInteger(Number(p.get('limit'))),
    'BAD_ARGUMENT',
    'limit must be an integer.',
  );
  return {
    ...status,
    currentGitHead: head,
    freshness: head === status.gitHead ? 'current' : 'stale',
    ...(repository
      ? {
          name: repository.full_name,
          hosted: {
            ...status.hosted,
            upstream: repository.html_url,
            visibility: repository.private ? 'private' : 'public',
            currentLicense: repository.license?.spdx_id ?? 'Not specified',
          },
        }
      : {}),
  };
}
