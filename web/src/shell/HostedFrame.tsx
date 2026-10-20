import { SourcePinContext } from './ObjectActions';
import { routeUrlState } from './location';
// SPDX-License-Identifier: Apache-2.0
import { type ReactNode } from 'react';
import { useQuery } from 'convex/react';
import { useUser } from '@clerk/react';
import { ProjectSearch } from './ProjectSearch';
import { api } from '../../../convex/_generated/api';
import type { Id } from '../../../convex/_generated/dataModel';
import { navigate } from '../ui/navigation';
import { useDestination, useSection } from '../WorkspaceUI';
import { PublicFrame } from '../landing/PublicFrame';
import { WorkHeaderProvider, type WorkPage } from './WorkHeader';
import { Glyph } from '../ui/Glyph';
import { Shell, type ShellTab } from './Shell';
import { HostedAttention } from './Attention';
import { HostedStrip } from './HostedStrip';
import { hostedSections, hostedTab, type AccountTab, type ProjectTab } from './route';

const projectTabs: readonly ShellTab<ProjectTab>[] = [
  { id: 'now', label: 'Now', glyph: 'now' },
  { id: 'intents', label: 'Work', glyph: 'intent' },
  { id: 'code', label: 'Code', glyph: 'code' },
  { id: 'settings', label: 'Settings', glyph: 'settings' },
];
const accountTabs: readonly ShellTab<AccountTab>[] = [
  { id: 'projects', label: 'Projects', glyph: 'graph', href: '/' },
  { id: 'account', label: 'Settings', glyph: 'settings', href: '/settings' },
];
const allSections = Object.values(hostedSections).flat();
const firstSection: Record<ProjectTab, (typeof allSections)[number]> = {
  now: 'overview',
  intents: 'intent',
  code: 'delivery',
  settings: 'sharing',
};
/** Project-scoped URL state cleared when leaving a project. */
const projectKeys = [
  'project',
  'projectTab',
  'intent',
  'intentTab',
  'lane',
  'session',
  'reviewView',
  'planningItem',
  'planningRoute',
  'itemTab',
  'projectHome',
  'collection',
  'workLens',
  'file',
  'head',
  'sourceHead',
  'sourceLane',
  'sourceBackup',
];
export function leaveProject() {
  const url = routeUrlState();
  for (const key of projectKeys) url.searchParams.delete(key);
  url.pathname = '/';
  url.searchParams.delete('tab');
  url.searchParams.delete('activity');
  url.searchParams.delete('viewId');
  navigate(url);
}

/**
 * Hosted application frame. Signed-out visitors get the public frame; signed-in visitors get account
 * destinations, and inside a project the same four destinations as local Forge.
 */
export function HostedFrame({
  identity,
  surface,
  setSurface,
  account,
  children,
}: {
  identity: boolean;
  surface: AccountTab | 'contact';
  setSurface: (surface: AccountTab) => void;
  account?: ReactNode;
  children: ReactNode;
}) {
  const { user } = useUser();
  const currentAccount = useQuery(api.urlAccounts.current, identity ? {} : 'skip');
  const accountName = user?.fullName || user?.username || currentAccount?.handle || 'Account';
  const [projectId] = useDestination('project');
  const [laneId] = useDestination('lane');
  const [intentId] = useDestination('intent');
  const [viewId] = useDestination('viewId');
  const [planningItem] = useDestination('planningItem');
  const [section, setSection] = useSection('projectTab', allSections, 'overview');
  const inProject = identity && surface === 'projects' && Boolean(projectId);
  const project = useQuery(
    api.projectWork.state,
    inProject ? { projectId: projectId as Id<'hostedProjects'> } : 'skip',
  );
  const tab = hostedTab(section);
  if (!identity)
    return (
      <PublicFrame account={account}>
        <div className="fx-legacy">{children}</div>
      </PublicFrame>
    );
  if (inProject)
    return (
      <SourcePinContext.Provider value={{ backupId: project?.work?.backupId }}>
        <HostedAttention key={projectId} projectId={projectId as Id<'hostedProjects'>}>
          <WorkHeaderProvider
            {...(tab === 'intents' &&
            !laneId &&
            !intentId &&
            !viewId &&
            !(section === 'planning' && planningItem)
              ? { page: (section === 'intent' ? 'intents' : section) as WorkPage }
              : {})}
            onChange={next => setSection(next === 'intents' ? 'intent' : next)}
          >
            <Shell
              hosted
              accountName={accountName}
              accountHandle={currentAccount?.handle}
              search={<ProjectSearch project={projectId!} projectId={projectId as Id<'hostedProjects'>} />}
              tabs={projectTabs}
              current={tab}
              onTab={next => setSection(firstSection[next])}
              context={
                <>
                  <button type="button" className="fx-switch fx-crumb" onClick={leaveProject}>
                    <Glyph name="back" size={13} />
                    <span>Projects</span>
                  </button>
                  <span className="fx-crumb-sep">/</span>
                  <span
                    className="fx-switch"
                    title={project && 'name' in project ? String(project.name) : undefined}
                  >
                    <Glyph name="graph" size={13} />
                    <span>{project && 'name' in project ? String(project.name) : 'Project'}</span>
                  </span>
                </>
              }
              account={account}
              subbar={
                tab === 'settings' ? null : section === 'coordination' || section === 'activity' ? (
                  <div className="fx-page-picker">
                    <button className="fx-crumb fx-switch" onClick={() => setSection('overview')}>
                      Now
                    </button>
                    <span aria-hidden="true"> › </span>
                    <span>Activity</span>
                  </div>
                ) : (
                  <HostedStrip projectId={projectId as Id<'hostedProjects'>} />
                )
              }
            >
              <div className="fx-legacy">{children}</div>
            </Shell>
          </WorkHeaderProvider>
        </HostedAttention>
      </SourcePinContext.Provider>
    );
  return (
    <Shell
      accountName={accountName}
      accountHandle={currentAccount?.handle}
      tabs={accountTabs}
      current={surface === 'contact' ? '' : surface}
      onTab={next => {
        if (next === 'projects') leaveProject();
        setSurface(next);
      }}
      label="Forge"
      account={account}
    >
      <div className="fx-legacy">{children}</div>
    </Shell>
  );
}
