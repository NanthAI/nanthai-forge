// SPDX-License-Identifier: Apache-2.0
// The top bar's main segment (Item 32e8de50) on synthetic data, through the real project frame: `?land=0|1|300`
// sets today's landings on main (300 with 261 first tries), with a few Lanes at each stop and a long project name.
import { createRoot } from 'react-dom/client';
import '../../web/src/ds';
import '../../web/src/app/app.css';
import { AccountFrame, ProjectFrame } from '../../web/src/app/frames';
import type { LineFeed } from '../../web/src/app/Line';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const landed = Number(params.get('land') ?? '0');
const hour = Math.floor(Date.now() / 3_600_000);
const first = landed === 300 ? 261 : landed;
const uuid = (n: number) => `5d1c7a0e-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lane = (n: number, stage: LineFeed['lanes'][number]['stage'], held = false) => ({
  laneId: uuid(n),
  stage,
  held,
  overlap: false,
  changedAt: Date.now() - n * 60_000,
});
// `first` ([hour, first tries, landings judged]) rides the feed's Flow day; the frame's type leaves it to flow-day.ts.
const feed = {
  lanes: [
    ...Array.from({ length: 12 }, (_, i) => lane(i, 'editing')),
    ...Array.from({ length: 16 }, (_, i) => lane(20 + i, 'saved', i < 2)),
    lane(40, 'checking'),
    lane(41, 'checking'),
    lane(42, 'ready', true),
  ],
  more: 0,
  moreIsLowerBound: false,
  main: landed ? { head: 'b'.repeat(64), at: new Date().toISOString() } : null,
  ...(landed
    ? {
        flow: {
          hours: [[hour, landed, landed === 300 ? 39 : 0, 0, 0, 0, 0]],
          took: [[hour, 240]],
          first: [[hour, first, landed]],
        },
      }
    : {}),
} as LineFeed;
const route = {
  frame: 'project' as const,
  handle: 'sample-one',
  project: 'tidepool-ingest',
  place: 'needs' as const,
  section: '',
  rest: '',
};
const projectHref = '/sample-one/tidepool-ingest';
const controls = { onPalette: () => {}, onKeys: () => {}, viewerHandle: 'sample-one' };
const content = (
  <section className="region" aria-label="Page">
    <h1>Top bar fixture</h1>
  </section>
);
createRoot(document.getElementById('root')!).render(
  params.get('frame') === 'account' ? (
    <AccountFrame place="projects" back={{ href: projectHref, name: 'tidepool-ingest' }} controls={controls}>
      {content}
    </AccountFrame>
  ) : (
    <ProjectFrame
      route={route}
      name="tidepool-ingest"
      feed={feed}
      needs={{ n: 3, atLeast: false }}
      projects={null}
      controls={{ ...controls, onPicker: () => {} }}
    >
      {content}
    </ProjectFrame>
  ),
);
