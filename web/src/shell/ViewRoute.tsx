import { ErrorToast } from '../ui/Toast';
// SPDX-License-Identifier: Apache-2.0
import { Component, lazy, Suspense, type ReactNode } from 'react';
import type { Id } from '../../../convex/_generated/dataModel';
import type { WorkIndexWorkspace } from '../hosted-work-index';
import { PageHead } from './Shell';
type HostedProps = { projectId: Id<'hostedProjects'>; workspace: WorkIndexWorkspace; viewId: string };
const Hosted = lazy(async () => ({ default: (await import('../views/HostedView')).HostedView }));
function Unavailable() {
  return (
    <div className="fx-page">
      <PageHead title="Candidate" />
      <ErrorToast retry={() => location.reload()}>This Candidate page could not load.</ErrorToast>
    </div>
  );
}
class ViewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <Unavailable /> : this.props.children;
  }
}
const pending = (
  <div className="fx-page" aria-busy="true">
    <PageHead title="Candidate" />
    <p role="status">Loading Candidate…</p>
  </div>
);
export function HostedViewRoute(props: HostedProps) {
  return (
    <ViewBoundary key={props.viewId}>
      <Suspense fallback={pending}>
        <Hosted {...props} />
      </Suspense>
    </ViewBoundary>
  );
}
