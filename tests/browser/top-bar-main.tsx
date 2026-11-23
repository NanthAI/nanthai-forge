// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The top bar on synthetic data through the real project frame. `?land=` sets today's landings on main,
// and `?name=` can stress the space that the project picker leaves to the line.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../web/src/ds';
import '../../web/src/app/app.css';
import { AccountFrame, ProjectFrame } from '../../web/src/app/frames';
import type { LineFeed } from '../../web/src/app/Line';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const landed = Number(params.get('land') ?? '0');
const crowded = params.get('lanes') === '50';
const hour = Math.floor(Date.now() / 3_600_000);
const first = landed === 300 ? 261 : landed === 101 ? 28 : landed === 1284 ? 360 : landed;
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
const crowdedFeed: LineFeed = {
  ...feed,
  lanes: Array.from({ length: 50 }, (_, i) => {
    const stage = i < 13 ? 'editing' : i < 26 ? 'saved' : i < 38 ? 'queued' : 'checking';
    return lane(i, i === 1 && params.has('exits') ? 'ready' : stage, i % 10 === 0);
  }),
};
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
    <div className="bulk">Selected rows</div>
    <div style={{ height: 2400 }} />
  </section>
);
function Fixture() {
  const [current, setCurrent] = useState(crowded ? crowdedFeed : feed);
  useEffect(() => {
    const deliver = (event: Event) => setCurrent((event as CustomEvent<(prev: LineFeed) => LineFeed>).detail);
    window.addEventListener('deliver-line', deliver);
    return () => window.removeEventListener('deliver-line', deliver);
  }, []);
  return params.get('frame') === 'account' ? (
    <AccountFrame place="projects" back={{ href: projectHref, name: 'tidepool-ingest' }} controls={controls}>
      {content}
    </AccountFrame>
  ) : (
    <ProjectFrame
      route={route}
      name={params.get('name') ?? 'tidepool-ingest'}
      feed={params.has('unloaded') ? undefined : current}
      needs={{ n: landed === 1284 ? 1284 : 3, atLeast: false }}
      projects={null}
      controls={{ ...controls, onPicker: () => {} }}
    >
      {content}
    </ProjectFrame>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
