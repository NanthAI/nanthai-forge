// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { networkFetch, networkTimeout } from './network-fetch.js';
import type { MigrationCounts } from './migration-ledger.js';

const kinds = ['issues', 'pullRequests', 'branches', 'collaborators'] as const;
const unknownCounts = (notReportedReason: string): MigrationCounts => ({
  issues: null,
  pullRequests: null,
  branches: null,
  collaborators: null,
  notReportedReason,
});
// Separate nullable roots keep an unavailable collaborator/Issue permission from hiding other totals.
// Only aggregates are selected: no issue bodies, member identities, edges or pagination.
const query = `query MigrationCounts($owner: String!, $name: String!) {
  issues: repository(owner: $owner, name: $name) { issues(first: 1) { totalCount } }
  pullRequests: repository(owner: $owner, name: $name) { pullRequests(first: 1) { totalCount } }
  branches: repository(owner: $owner, name: $name) { refs(refPrefix: "refs/heads/", first: 1) { totalCount } }
  collaborators: repository(owner: $owner, name: $name) { collaborators(first: 1) { totalCount } }
}`;

/** One best-effort metadata batch, never a source-transfer failure or an additional sign-in. */
export async function githubMigrationCounts(
  repository: string,
  token?: string,
  request: typeof fetch = networkFetch,
): Promise<MigrationCounts> {
  if (!token) return unknownCounts('credential-unavailable');
  const [owner, name, extra] = repository.split('/');
  if (!owner || !name || extra) return unknownCounts('metadata-unavailable');
  try {
    const response = await request('https://api.github.com/graphql', {
      method: 'POST',
      redirect: 'error',
      signal: networkTimeout(15_000),
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'NanthAi-Forge',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables: { owner, name } }),
    });
    if (!response.ok) return unknownCounts('metadata-unavailable');
    const reply = (await response.json()) as {
      data?: Record<string, Record<string, { totalCount?: unknown }> | null>;
    };
    const counts = unknownCounts('partial-metadata');
    for (const kind of kinds) {
      const value = reply.data?.[kind]?.[kind === 'branches' ? 'refs' : kind]?.totalCount;
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) counts[kind] = value;
    }
    if (kinds.every(kind => counts[kind] !== null)) delete counts.notReportedReason;
    return counts;
  } catch {
    // Never retain provider error bodies: they may contain private identity information.
    return unknownCounts('metadata-unavailable');
  }
}
