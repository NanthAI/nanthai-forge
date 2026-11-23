// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { createRoot } from 'react-dom/client';
import type { Id } from '../../convex/_generated/dataModel';
import type { PlanRow } from '../../src/planning-model';
import { ProjectFrame } from '../../web/src/app/frames';
import type { NeedsRead } from '../../web/src/app/needs/count';
import type { PlanCountsRead } from '../../web/src/app/progress';
import type { ProjectRoute } from '../../web/src/app/screen-route';
import '../../web/src/app/app.css';
import { fakeConvex } from '../convex-fake.mjs';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const projectId = 'progress-fixture' as Id<'hostedProjects'>;
const projectName = 'Parser project';
const viewerHandle = 'sample-one';
const data = params.get('data');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const initiativeId = uuid(1);
const route: ProjectRoute = {
  frame: 'project',
  handle: viewerHandle,
  project: 'parser',
  place: data === 'plan' || data === 'initiative' ? 'plan' : 'needs',
  section: '',
  rest: data === 'initiative' ? initiativeId : '',
};
const rows: PlanRow[] = [
  { id: initiativeId, kind: 'initiative', title: 'Parser release', status: 'open', position: 0 },
  {
    id: uuid(2),
    kind: 'issue',
    title: 'Handle split frames',
    initiativeId,
    status: 'in-progress',
    position: 1,
  },
  { id: uuid(3), kind: 'issue', title: 'Write the changelog', status: 'open', position: 2 },
  { id: uuid(4), kind: 'issue', title: 'Trace frame checksums', status: 'proposed', position: 3 },
  { id: uuid(5), kind: 'issue', title: 'Document parser errors', status: 'proposed', position: 4 },
  { id: uuid(6), kind: 'issue', title: 'Improve stream diagnostics', status: 'open', position: 5 },
  { id: uuid(7), kind: 'issue', title: 'Update example frames', status: 'open', position: 6 },
];
const exact = !params.has('capped');
// Compact Plan rows have Initiative totals. The project also has closed work outside this Initiative.
const plan = {
  rows: JSON.stringify(rows),
  more: false,
  settled: [{ initiativeId, done: 4, dropped: 1, atLeast: !exact }],
  canEdit: true,
};
const counts: PlanCountsRead = {
  exact,
  issue: { proposed: 2, open: 3, inProgress: 1, closed: exact ? 1_207 : 989, abandoned: 5 },
  closedToday: null,
};
const needs: NeedsRead = {
  held: [],
  more: 0,
  moreIsLowerBound: false,
  canDecide: false,
  approvals: JSON.stringify({ requests: [], complete: true }),
};
const reads = new Map<string, unknown>([
  ['projectPlanCounts:read', counts],
  ['projectPlanView:read', plan],
  ['projectNeedsMe:read', needs],
  ['projectPlanWorkers:read', JSON.stringify({ lanes: [] })],
]);
const backend = fakeConvex({
  resolve: (name: string, args: { projectId?: string }) =>
    args.projectId === projectId ? reads.get(name) : undefined,
});
const { default: Screen } =
  route.place === 'plan'
    ? await import('../../web/src/app/plan/Plan')
    : await import('../../web/src/app/needs/NeedsMe');

createRoot(document.getElementById('root')!).render(
  <ConvexProvider client={backend.client as unknown as ConvexReactClient}>
    <ProjectFrame
      route={route}
      name={projectName}
      feed={undefined}
      projects={null}
      controls={{ viewerHandle, onPicker() {}, onPalette() {}, onKeys() {} }}
    >
      <Screen
        route={route}
        projectId={projectId}
        projectName={projectName}
        viewerHandle={viewerHandle}
        feed={undefined}
      />
    </ProjectFrame>
  </ConvexProvider>,
);
