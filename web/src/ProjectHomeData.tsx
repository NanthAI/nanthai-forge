import { ErrorToast } from './ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { Component, useEffect, useMemo, type ReactNode } from 'react';
import { usePaginatedQuery, useQuery } from 'convex/react';
import { makeFunctionReference, type PaginationOptions, type PaginationResult } from 'convex/server';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { Lane, PlanningItem, WorkData } from '../../src/work-types';
import { useWorkIndex, useWorkRecords } from './hosted-work-index';
import { portfolioWork } from './portfolio-work';
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
export function usePortfolioProjects(discoverReaders = true) {
  const owned = usePaginatedQuery(api.projectBackups.list, {}, { initialNumItems: 20 });
  const shared = usePaginatedQuery(api.projectContributors.shared, {}, { initialNumItems: 20 });
  const readers = usePaginatedQuery(
    makeFunctionReference<
      'query',
      { paginationOpts: PaginationOptions },
      PaginationResult<{ id: Id<'hostedProjects'>; name: string }>
    >('projectReaders:shared'),
    discoverReaders ? {} : 'skip',
    { initialNumItems: 20 },
  );
  const projects = useMemo(
    () => [
      ...new Map(
        [
          ...readers.results.map(item => ({ ...item, shared: true, role: 'Reader' as const })),
          ...shared.results.map(item => ({
            id: item.id,
            name: item.name,
            shared: true,
            role: 'Contributor' as const,
          })),
          ...owned.results
            .filter(item => !item.removal)
            .map(item => ({ id: item.id, name: item.name, shared: false, role: 'Owner' as const })),
        ].map(item => [item.id, item]),
      ).values(),
    ],
    [owned.results, shared.results, readers.results],
  );
  return {
    projects,
    loading:
      owned.status === 'LoadingFirstPage' ||
      shared.status === 'LoadingFirstPage' ||
      (discoverReaders && readers.status === 'LoadingFirstPage'),
    more:
      owned.status === 'CanLoadMore' || shared.status === 'CanLoadMore' || readers.status === 'CanLoadMore',
    loadMore: () => {
      if (readers.status === 'CanLoadMore') readers.loadMore(20);
      if (owned.status === 'CanLoadMore') owned.loadMore(20);
      if (shared.status === 'CanLoadMore') shared.loadMore(20);
    },
  };
}
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
