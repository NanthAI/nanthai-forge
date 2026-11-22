// SPDX-License-Identifier: Apache-2.0
// Pure migration-report contract for CLI and web. No transport or application imports.
export type MigrationCounts = {
  issues: number | null;
  pullRequests: number | null;
  branches: number | null;
  collaborators: number | null;
  notReportedReason?: string | undefined;
};
/** What stays on GitHub, said once for the web, the CLI and the docs (Item bd24f0a6, owner Q59: no issue import). */
export const importStaysLine =
  'Issues, pull requests, people and tags stay on GitHub. CI config comes with the source and keeps working with your own CI.';
/** The next step for the backlog: an agent recreates what is worth keeping, through the planning import. */
export const importAgentLine =
  'To keep issues, ask an agent to triage the ones worth keeping and recreate them as Items.';
export const importAgentGuide = '/docs/planning/#recipe-recreate-past-milestones-then-plan-the-next-one';
/** Shared CLI/web language; source readiness and Git history catch-up are distinct. */
export function migrationSummary(counts?: MigrationCounts): string {
  const value = (kind: 'issues' | 'pullRequests' | 'branches' | 'collaborators') =>
    counts?.[kind] == null ? 'not reported' : String(counts[kind]);
  return `Comes to Forge: the selected source; the full Git history is acquired separately. ${importStaysLine} At the origin: Issues ${value('issues')}, pull requests ${value('pullRequests')}, branch heads ${value('branches')}, collaborators ${value('collaborators')}. ${importAgentLine} Guide: https://forge.nanthai.tech${importAgentGuide}`;
}
