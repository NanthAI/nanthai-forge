// SPDX-License-Identifier: Apache-2.0
import { ErrorToast } from './ui/Toast';
import { Component, useEffect, useMemo, type ReactNode } from 'react';
import { usePaginatedQuery, useQuery } from 'convex/react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { Lane, PlanningItem, WorkData } from '../../src/work-types';
import { useWorkIndex, useWorkRecords } from './hosted-work-index';
import { portfolioWork } from './portfolio-work';
// Shared number only (no server code): the page size of the account read.
const ACCOUNT_PROJECTS_PAGE = 50;
export type PortfolioProject = {
  id: Id<'hostedProjects'>;
  name: string;
  shared: boolean;
  visibility: 'private' | 'public';
  starred?: boolean;
  role?: 'Owner' | 'Contributor' | 'Reader';
};
export type ProjectSummary = ReturnType<typeof portfolioWork> & {
  loading: boolean;
  initialLoading: boolean;
  error: string;
  available: boolean;
};
/** Every active project the person owns or is a member of, from the one account read (convex/accountProjects.ts),
 * newest activity first: removed projects never fill a page. "Load more" reads the next page by cursor. */
export function usePortfolioProjects(_discoverReaders = true) {
  const read = usePaginatedQuery(api.accountProjects.list, {}, { initialNumItems: ACCOUNT_PROJECTS_PAGE });
  const projects = useMemo(
    () =>
      read.results.map(item => ({
        id: item.id,
        name: item.name,
        shared: item.role !== 'owner',
        visibility: item.visibility,
        starred: item.starred,
        role: roleWords[item.role],
      })),
    [read.results],
  );
  return {
    projects,
    loading: read.status === 'LoadingFirstPage',
    more: read.status === 'CanLoadMore',
    loadMore: () => read.loadMore(ACCOUNT_PROJECTS_PAGE),
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
