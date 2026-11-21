// SPDX-License-Identifier: Apache-2.0
import { lazy, Suspense } from 'react';
import { ConvexProvider } from 'convex/react';
import { createRoot } from 'react-dom/client';
import type { Id } from '../../convex/_generated/dataModel';
import type { PlanRow } from '../../src/planning-model';
import { ProjectFrame } from '../../web/src/app/frames';
import type { LineFeed } from '../../web/src/app/Line';
import { Overview } from '../../web/src/app/lanes/Overview';
import type { LaneMeta } from '../../web/src/app/lanes/model';
import { LANE_PAGE } from '../../web/src/app/lanes/reads';
import Billing from '../../web/src/billing/Home';
import { stressText } from '../../web/src/ds/reference/stress-text';
import { fakeConvex } from '../convex-fake.mjs';
import '../../web/src/app/app.css';
import '../../web/src/app/lanes/lanes.css';

const Plan = lazy(() => import('../../web/src/app/plan/Plan'));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const projectId = 'synthetic' as Id<'hostedProjects'>;
const projectName = stressText.identifier;
const viewerHandle = 'sample-one';
const initiative = {
  id: id(500),
  title: stressText.name,
  kind: 'initiative',
  status: 'open',
  position: 0,
} satisfies PlanRow;
const lanes: LaneMeta[] = Array.from({ length: LANE_PAGE }, (_, i) => ({
  laneId: id(i),
  intentId: id(i + 100),
  intent: stressText.titles[i] ?? `Document adapter ${i + 1}`,
  actor: stressText.handles[i] ?? viewerHandle,
  lastSaveAt: null,
  landing: null,
}));
const rows: PlanRow[] = [
  initiative,
  ...lanes.slice(0, stressText.titles.length).map((lane, position) => ({
    id: lane.intentId,
    position,
    kind: 'issue' as const,
    status: 'open' as const,
    title: lane.intent!,
    owner: lane.actor,
    initiativeId: initiative.id,
  })),
];
const feed: LineFeed = {
  lanes: lanes.map(lane => ({
    laneId: lane.laneId,
    stage: 'editing',
    changedAt: 1,
    held: false,
    overlap: false,
  })),
  more: 0,
  moreIsLowerBound: false,
  main: null,
};

const { client } = fakeConvex({
  resolve(name: string) {
    switch (name) {
      case 'projectHostedLiveLanes:list':
        return JSON.stringify({ page: lanes, isDone: true });
      case 'projectHostedQueueView:read':
        return JSON.stringify({ total: 0, held: 0, listed: 0, more: false, entries: [] });
      case 'projectNowOverlaps:now':
        return JSON.stringify({ signals: { lanes: [], paths: [], edits: [], complete: true } });
      case 'projectPlanView:read':
        return {
          rows: JSON.stringify(rows),
          more: false,
          settled: [{ initiativeId: initiative.id, done: 123456, dropped: 4567, atLeast: false }],
          canEdit: true,
        };
      case 'projectPlanCounts:read':
        return {
          exact: true,
          issue: { closed: 123456, open: rows.length - 1, inProgress: 0, proposed: 0, abandoned: 4567 },
          closedToday: null,
        };
      default:
        return null;
    }
  },
});

function Fixture({ place }: { place: 'lanes' | 'plan' }) {
  const route = {
    frame: 'project' as const,
    handle: viewerHandle,
    project: 'synthetic',
    place,
    section: '',
    rest: '',
  };
  const Screen = place === 'lanes' ? Overview : Plan;
  return (
    <ConvexProvider client={client}>
      <ProjectFrame
        route={route}
        name={projectName}
        feed={feed}
        projects={null}
        controls={{ onPalette() {}, onKeys() {}, onPicker() {}, viewerHandle }}
      >
        <Suspense fallback={null}>
          <Screen
            route={route}
            projectId={projectId}
            projectName={projectName}
            feed={feed}
            viewerHandle={viewerHandle}
          />
        </Suspense>
      </ProjectFrame>
    </ConvexProvider>
  );
}

const screen = location.pathname.split('/').at(-1);
if (screen === 'needs') {
  void import('./needs-me');
} else if (screen === 'secrets') {
  void import('./secrets');
} else if (screen === 'you' || screen === 'check' || screen === 'place') {
  void import('./ds-heads');
} else {
  createRoot(document.getElementById('root')!).render(
    screen === 'billing' ? <Billing /> : <Fixture place={screen === 'lanes' ? 'lanes' : 'plan'} />,
  );
}
