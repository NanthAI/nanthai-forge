// SPDX-License-Identifier: Apache-2.0
// The Lanes yard (Items 29671737, d9e1ac62, d4b68402) on synthetic data, through its real model and row component: a
// Lane held for approval whose record carries REVIEW_REQUIRED, two older Lanes of the same Item left behind, three
// Lanes of another Item still busy, a Ready Lane waiting behind one whose check restarted, and (Item 1dd4e095's real
// case) a quiet Lane beside its quiet resolution Lane. `?dense=1` draws the dense yard a long list uses.
// Who waits on whom (Item 9e748e41) renders the same queue plus one Lane further back, so its wait is traced to the
// front.
import { createRoot } from 'react-dom/client';
import { Region } from '../../web/src/ds';
import '../../web/src/app/app.css';
import '../../web/src/app/lanes/lanes.css';
import { buildYard, waits, type LaneMeta, type QueueEntry } from '../../web/src/app/lanes/model';
import { WaitRow } from '../../web/src/app/lanes/Touching';
import { Yard } from '../../web/src/app/lanes/Yard';
import type { LineFeed } from '../../web/src/app/Line';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';

const NOW = Date.parse('2026-11-17T14:20:00Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const ids = {
  held: '9e8e8826-db5d-40d1-9199-328383d25641',
  oldA: 'a3cd248a-7ed4-4b01-8590-5e607ac26e75',
  oldB: 'c13ef400-dd3c-43a9-9020-55e7a8ab459c',
  first: '4333f92b-12c5-4ac3-b811-b4ff78d48840',
  second: 'e698324f-a04c-4eb1-9d82-2ef3582ad943',
  acct1: '91767b23-6afd-47b1-a841-8a21c8546326',
  acct2: '10b90147-9c37-4221-8b7c-c4e86209c8a4',
  acct3: 'a1d903ed-cf63-4d65-80ee-4eb026539545',
  origin: 'ac26ac6f-afcd-46f9-9637-cd543c51c900',
  resolution: 'c908b679-0edc-4c3c-83cf-bc44468343e5',
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
    mark(ids.held, 'ready', 58, true),
    mark(ids.oldA, 'saved', 290),
    mark(ids.oldB, 'saved', 292),
    mark(ids.first, 'checking', 47),
    mark(ids.second, 'ready', 14),
    mark(ids.acct1, 'saved', 6),
    mark(ids.acct2, 'saved', 21),
    mark(ids.acct3, 'editing', 26),
    mark(ids.origin, 'saved', 25 * 60),
    mark(ids.resolution, 'saved', 21 * 60),
  ],
  more: 0,
  moreIsLowerBound: false,
  main: null,
};
const BROWSER = 'Landing check: browser tests skip silently (no browser installed), plus two L10 follow-ups';
const meta = (
  laneId: string,
  intentId: string,
  intent: string,
  actor: string,
  savedAgo: number,
): LaneMeta => ({
  laneId,
  intentId,
  intent,
  actor,
  lastSaveAt: at(savedAgo),
  landing: null,
});
const lanes = [
  meta(ids.held, 'pages', 'Public pages: share cards, sitemap and page titles', 'mara/quiet-otter', 58),
  meta(ids.oldA, 'pages', 'Public pages: share cards, sitemap and page titles', 'mara/quiet-otter', 290),
  meta(ids.oldB, 'pages', 'Public pages: share cards, sitemap and page titles', 'mara/salt-wren', 292),
  meta(ids.first, 'cli', 'Hosted CLI and agent workflow papercuts', 'devon/brisk-heron', 47),
  meta(ids.second, 'stamp', 'Stamp every save and landing with who made it', 'devon/amber-finch', 14),
  // Item e1633718: parked on a named holder, with the reason under it.
  {
    ...meta(ids.acct1, 'acct', 'Account Projects page in the redesign', 'mara/upbeat-stork', 6),
    park: {
      to: 'devon',
      named: true,
      reason: 'Waits for devon to pick the empty-state copy.',
      at: NOW - 40 * 60_000,
      by: 'mara/upbeat-stork',
    },
  },
  meta(ids.acct2, 'acct', 'Account Projects page in the redesign', 'mara/wild-gecko', 21),
  meta(ids.acct3, 'acct', 'Account Projects page in the redesign', 'mara/calm-lynx', 26),
  meta(ids.origin, 'browser', BROWSER, 'mara/true-petrel', 25 * 60),
  { ...meta(ids.resolution, 'browser', BROWSER, 'mara/true-petrel', 21 * 60), resolves: ids.origin },
];
const entries: QueueEntry[] = [
  {
    position: 1,
    laneId: ids.first,
    landingState: { state: 'checking' },
    phase: 'checking',
    recomposeCount: 3,
    submittedAt: at(47),
    lastProgressAt: at(2),
  },
  {
    position: 2,
    laneId: ids.second,
    landingState: { state: 'landing' },
    phase: 'ready',
    recomposeCount: 0,
    submittedAt: at(30),
    lastProgressAt: at(14),
  },
  {
    position: null,
    laneId: ids.held,
    landingState: { state: 'held-review' },
    phase: 'ready',
    error: 'REVIEW_REQUIRED',
    hold: { kind: 'review', reason: 'A person approves each landing.', paths: null },
    submittedAt: at(58),
    lastProgressAt: at(58),
  },
];
const yard = buildYard(feed, lanes, { total: 2, held: 1, listed: 3, more: false, entries }, NOW);
const titles = new Map(lanes.map(lane => [lane.laneId, lane.intent]));
const titleOf = (laneId: string) => titles.get(laneId) ?? `Lane ${laneId.slice(0, 8)}`;
const pairs = waits(
  [
    ...entries,
    { position: 3, laneId: ids.acct1, phase: 'queued', submittedAt: at(9), lastProgressAt: at(9) },
  ],
  titleOf,
);

createRoot(document.getElementById('root')!).render(
  <main>
    <h1 className="sr">Lanes</h1>
    <Region
      title="On the way to main"
      weight="act"
      waiting={yard.counts.needs}
      count={yard.rows.length}
      hint="stuck work first"
    >
      <Yard rows={yard.rows} hrefOf={id => `#${id}`} dense={params.get('dense') === '1'} />
    </Region>
    <Region title="Who waits on whom" weight="act" waiting={1} count={pairs.length}>
      {pairs.map(pair => (
        <WaitRow
          key={pair.laneId}
          pair={pair}
          titleOf={titleOf}
          laneHref={id => `#${id}`}
          decideHref="#needs"
          now={NOW}
        />
      ))}
    </Region>
  </main>,
);
