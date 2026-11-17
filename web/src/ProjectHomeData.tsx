// SPDX-License-Identifier: Apache-2.0
import { ErrorToast } from './ui/Toast';
import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { Lane, PlanningItem, WorkData } from '../../src/work-types';
import { useWorkIndex, useWorkRecords } from './hosted-work-index';
import { portfolioWork } from './portfolio-work';
// Shared numbers only (no server code): the page sizes of the account read.
const ACCOUNT_PROJECTS_DEFAULT = 50;
const ACCOUNT_PROJECTS_MAX = 200;
export type PortfolioProject = {
  id: Id<'hostedProjects'>;
  name: string;
  shared: boolean;
  role?: 'Owner' | 'Contributor' | 'Reader';
};
export type ProjectSummary = ReturnType<typeof portfolioWork> & {
  loading: boolean;
  initialLoading: boolean;
  error: string;
  available: boolean;
};
/** Every active project the person owns or is a member of, from the one account read (convex/accountProjects.ts):
 * removed projects never fill the page. "Load more" asks once for the larger page. */
export function usePortfolioProjects(_discoverReaders = true) {
  const [limit, setLimit] = useState<number>(ACCOUNT_PROJECTS_DEFAULT);
  const read = useQuery(api.accountProjects.list, { limit });
  const projects = useMemo(
    () =>
      (read?.projects ?? []).map(item => ({
        id: item.id,
        name: item.name,
        shared: item.role !== 'owner',
        role: roleWords[item.role],
      })),
    [read],
  );
  return {
    projects,
    loading: read === undefined,
    more: !!read?.more && limit < ACCOUNT_PROJECTS_MAX,
    loadMore: () => setLimit(ACCOUNT_PROJECTS_MAX),
  };
}
const roleWords = { owner: 'Owner', write: 'Contributor', read: 'Reader' } as const;
/** An access change in one project must leave the rest of Home usable. */
export class PortfolioBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <ErrorToast read error="Could not load project Work." retry={() => this.setState({ failed: false })} />
    ) : (
      this.props.children
    );
  }
}
export function PortfolioData({
  project,
  onChange,
}: {
  project: PortfolioProject;
  onChange: (id: string, value: ProjectSummary) => void;
}) {
  const state = useQuery(api.projectWork.state, { projectId: project.id });
  const { workspace, error } = useWorkIndex(project.id, state?.work);
  const intents = useWorkRecords<WorkData['intents'][number]>(project.id, workspace, 'intents');
  const lanes = useWorkRecords<Lane>(project.id, workspace, 'lanes');
  const views = useWorkRecords<WorkData['views'][number]>(project.id, workspace, 'views');
  const plans = useWorkRecords<PlanningItem>(
    project.id,
    workspace,
    'planningItems',
    undefined,
    !!workspace?.capabilities.owner && !!workspace?.capabilities.planning,
  );
  const summary = useMemo(
    () => ({
      ...portfolioWork({
        intents: intents.records,
        lanes: lanes.records,
        views: views.records,
        plans: plans.records,
      }),
      loading: !workspace || intents.loading || lanes.loading || views.loading || plans.loading,
      initialLoading:
        !workspace ||
        intents.initialLoading ||
        lanes.initialLoading ||
        views.initialLoading ||
        plans.initialLoading,
      error,
      available: !!workspace,
    }),
    [
      intents.initialLoading,
      lanes.initialLoading,
      views.initialLoading,
      plans.initialLoading,
      intents.records,
      lanes.records,
      views.records,
      plans.records,
      intents.loading,
      lanes.loading,
      views.loading,
      plans.loading,
      workspace,
      error,
    ],
  );
  useEffect(() => onChange(project.id, summary), [project.id, summary, onChange]);
  return null;
}

export function missingReaderDiscovery(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Could not find public function for ['"]projectReaders:shared['"]/.test(message);
}
/** Older deployments can serve owned/contributor projects while reader discovery rolls out. */
export class ReaderDiscoveryBoundary extends Component<
  { children: (available: boolean) => ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error && !missingReaderDiscovery(this.state.error)) throw this.state.error;
    return this.props.children(!this.state.error);
  }
}
