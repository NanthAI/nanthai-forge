// SPDX-License-Identifier: Apache-2.0
// The yard's running checks (Item ecd6e610) on synthetic data, through its real model and row: a check running for
// `?elapsed=` minutes (default 3), one past the usual slowest check (overdue), one that passed and waits its turn, and one
// that failed, against a project whose checks usually take 10 min and at slowest 18 min. Starts count back from the
// real clock, so the browser's own animation timeline places the marks. A watch region: the first stop's edge beat
// (ds-beat) would add an animation of its own to what the test counts.
import { createRoot } from 'react-dom/client';
import { Region } from '../../web/src/ds';
import '../../web/src/app/app.css';
import '../../web/src/app/lanes/lanes.css';
import { buildYard, type LaneMeta, type QueueEntry } from '../../web/src/app/lanes/model';
import { Yard } from '../../web/src/app/lanes/Yard';
import type { LineFeed } from '../../web/src/app/Line';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const elapsed = Number(params.get('elapsed') ?? 3);

const NOW = Date.now();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const ids = {
  running: '4333f92b-12c5-4ac3-b811-b4ff78d48840',
  overdue: 'e698324f-a04c-4eb1-9d82-2ef3582ad943',
  passed: '91767b23-6afd-47b1-a841-8a21c8546326',
  failed: 'a1d903ed-cf63-4d65-80ee-4eb026539545',
};
const mark = (
  laneId: string,
  stage: LineFeed['lanes'][number]['stage'],
  minutesAgo: number,
  held = false,
) => ({
  laneId,
  stage,
  held,
  overlap: false,
  changedAt: NOW - minutesAgo * 60_000,
});
const feed: LineFeed = {
  lanes: [
    mark(ids.running, 'checking', elapsed),
    mark(ids.overdue, 'checking', 25),
    mark(ids.passed, 'ready', 1),
    mark(ids.failed, 'checking', 2, true),
  ],
  more: 0,
  moreIsLowerBound: false,
  main: null,
};
const meta = (laneId: string, intent: string, actor: string): LaneMeta => ({
  laneId,
  intentId: laneId,
  intent,
  actor,
  lastSaveAt: at(30),
  landing: null,
});
const lanes = [
  meta(ids.running, 'Hosted CLI and agent workflow papercuts', 'devon/brisk-heron'),
  meta(ids.overdue, 'Stamp every save and landing with who made it', 'devon/amber-finch'),
  meta(ids.passed, 'Account Projects page in the redesign', 'mara/upbeat-stork'),
  meta(ids.failed, 'Public pages: share cards, sitemap and page titles', 'mara/quiet-otter'),
];
const checking = (laneId: string, position: number, minutesAgo: number): QueueEntry => ({
  position,
  laneId,
  landingState: { state: 'checking' },
  phase: 'checking',
  recomposeCount: 0,
  submittedAt: at(minutesAgo + 1),
  lastProgressAt: at(minutesAgo),
  checkStartedAt: at(minutesAgo),
});
const entries: QueueEntry[] = [
  checking(ids.running, 1, elapsed),
  checking(ids.overdue, 2, 25),
  {
    position: 3,
    laneId: ids.passed,
    landingState: { state: 'landing' },
    phase: 'ready',
    submittedAt: at(14),
    lastProgressAt: at(1),
  },
  {
    position: null,
    laneId: ids.failed,
    landingState: { state: 'check-failed' },
    phase: 'terminal-failed',
    lastFailingTests: ['tests/public-pages.test.mjs'],
    submittedAt: at(16),
    lastProgressAt: at(2),
  },
];
const yard = buildYard(
  feed,
  lanes,
  {
    total: 3,
    listed: 4,
    more: false,
    entries,
    usualCheck: { seconds: 600, slowSeconds: 1080, landings: 40 },
  },
  NOW,
);

createRoot(document.getElementById('root')!).render(
  <main>
    <h1 className="sr">Lanes</h1>
    <Region title="On the way to main" weight="watch" count={yard.rows.length}>
      <Yard rows={yard.rows} hrefOf={id => `#${id}`} dense={params.get('dense') === '1'} />
    </Region>
  </main>,
);
