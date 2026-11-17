// SPDX-License-Identifier: Apache-2.0
// Pure migration-report contract for CLI and web. No transport or application imports.
export type MigrationCounts = {
  issues: number | null;
  pullRequests: number | null;
  branches: number | null;
  collaborators: number | null;
  notReportedReason?: string | undefined;
};
/** Shared CLI/web language; source readiness and Git history catch-up are distinct. */
export function migrationSummary(counts?: MigrationCounts): string {
  const value = (kind: 'issues' | 'pullRequests' | 'branches' | 'collaborators') =>
    counts?.[kind] == null ? 'not reported' : String(counts[kind]);
  return `Selected source comes to Forge; Git history is acquired separately. At the origin: Issues ${value('issues')}, pull requests ${value('pullRequests')}, branch heads ${value('branches')}, collaborators ${value('collaborators')}. Backlog recreation is separate; pull-request work, tags, CI run history and accounts are not imported.`;
}
