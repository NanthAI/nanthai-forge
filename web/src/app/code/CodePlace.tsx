// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Code place (Items 90e5bc9c, 3968a655): what landed on main, each with its receipt, and the files at main or at
// any exact State. Loaded with its route. The views take the project, its main and the address, and nothing about
// who is reading, so the signed-out public pages (4c164732) mount them under their own route.
import { Component, type ReactNode } from 'react';
import type { AppRoute } from '../paths';
import { useSearch } from '../router';
import { timelinePath } from './code-words';
import type { PlaceProps } from '../screens';
import { Files } from './Files';
import { History } from './History';
import type { ProjectId } from './code-data';
import './code.css';

export type CodeRoute = Extract<AppRoute, { frame: 'project' }>;
export type CodeProps = {
  route: CodeRoute;
  projectId: ProjectId;
  projectName: string;
  /** main's head State; undefined while it loads, null when the project has no main yet. */
  mainHead: string | null | undefined;
  /** The line feed's running day (src/flow-day.ts), for landings today as the top bar counts them. */
  flow?: unknown;
};

/** The Code place as the project frame mounts it (code/route.ts): main's head comes from the line it already reads. */
export default function CodePlace({ route, projectId, projectName, feed, feedError }: PlaceProps) {
  const props: CodeProps = {
    route,
    projectId,
    projectName,
    mainHead: feed === undefined ? undefined : (feed.main?.head ?? null),
    flow: feedError ? undefined : feed?.flow,
  };
  return <CodeScreen {...props} />;
}

export function CodeScreen(props: CodeProps) {
  const search = useSearch();
  const { route } = props;
  // Old /code?path= links named the ledger. Keep them valid after Files becomes the default.
  const oldLedger = !route.rest && !search.has('at') && timelinePath(`?${search}`) !== null;
  if (oldLedger && route.section === 'files') return <History {...props} route={{ ...route, section: '' }} />;
  return route.section === 'files' ? <Files {...props} /> : <History {...props} />;
}

/** Loading or failure in one region keeps the rest of the page: this region says so and offers Retry. */
export class RegionBoundary extends Component<
  { label: string; children: ReactNode },
  { failed: string | null }
> {
  state = { failed: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    const data = (error as { data?: { message?: unknown } })?.data;
    return { failed: typeof data?.message === 'string' ? data.message : 'The read did not finish.' };
  }
  render() {
    if (this.state.failed === null) return this.props.children;
    return (
      <div className="pad" role="alert">
        <p>
          {this.props.label} could not load. {this.state.failed}
        </p>
        <p>
          <button type="button" className="btn sm" onClick={() => this.setState({ failed: null })}>
            Retry
          </button>
        </p>
      </div>
    );
  }
}
