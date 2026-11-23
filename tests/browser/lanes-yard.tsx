// SPDX-License-Identifier: Apache-2.0
// The Lanes yard (Items 29671737, d9e1ac62, d4b68402) on synthetic data, through its real model and row component: a
// Lane held for approval whose record carries REVIEW_REQUIRED, two older Lanes of the same Item left behind, three
// Lanes of another Item still busy, a Ready Lane waiting behind one whose check restarted, and (Item 1dd4e095's real
// case) a quiet Lane beside its quiet resolution Lane. `?dense=1` draws the dense yard a long list uses.
// Who waits on whom (Item 9e748e41) renders the same queue plus one Lane further back, so its wait is traced to the
// front. Three Lanes share saved files (Item f787005c): each of their rows says how many, linked to Who is touching
// what for that Lane.
// Served under the app's own address (/…/lanes), it renders the real Lanes place on the same data plus one Lane whose
// check failed, over a fake Convex client that counts reads, and names the screen the real route registry gives the
// current address, so the links the overview draws, browser Back and unknown addresses are all followed for real
// (Item e317b6ea). `?double` doubles the open Lanes for the scale measurement. The fixture's frame subscribes Needs
// me's read as App.tsx does, so the page's Needs you is seen to share it. `?state=` draws the overview empty, loading
// (the Lane page never answers), failed (the Lane page read fails) or worst (long, non-Latin and extreme values).
import { ConvexProvider, useQuery } from 'convex/react';
import { needsRead } from '../../web/src/app/needs/count';
import { createRoot } from 'react-dom/client';
import type { Id } from '../../convex/_generated/dataModel';
import { Region } from '../../web/src/ds';
import '../../web/src/app/app.css';
import '../../web/src/app/lanes/lanes.css';
import {
  buildYard,
  sharesByLane,
  waits,
  type LaneMeta,
  type QueueEntry,
} from '../../web/src/app/lanes/model';
import { WaitChains, type ChainLane } from '../../web/src/app/lanes/WaitChains';
import { HistoryView } from '../../web/src/app/lanes/History';
import { Yard } from '../../web/src/app/lanes/Yard';
import type { LineFeed } from '../../web/src/app/Line';
import LanesPlace from '../../web/src/app/lanes/LanesPlace';
import { useRoute } from '../../web/src/app/router';
import { projectScreenFor, type ScreenRoutes } from '../../web/src/app/screen-route';
import { fakeConvex } from '../convex-fake.mjs';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';

const project = { handle: 'sample-owner', project: 'sample-project' };
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
  failed: 'f41ed0a2-3b6c-4d1e-9a7f-2c8e5b0d4f19',
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
  {
    ...meta(ids.held, 'pages', 'Public pages: share cards, sitemap and page titles', 'mara', 58),
    agentRun: 'quiet-otter',
    agentClient: 'codex:gpt-example',
  },
  meta(ids.oldA, 'pages', 'Public pages: share cards, sitemap and page titles', 'mara/quiet-otter', 290),
  meta(ids.oldB, 'pages', 'Public pages: share cards, sitemap and page titles', 'mara', 292),
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
const stallMarks = Array.from({ length: 10 }, (_, i) =>
  mark(
    `a0000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    i < 4 ? 'checking' : 'ready',
    i === 0 ? 108 : 10,
  ),
);
const stallEntries = stallMarks.map((lane, i) => ({
  laneId: lane.laneId,
  position: i + 1,
  phase: lane.stage,
  landingState: { state: i < 4 ? 'checking' : 'waiting-for-order' },
}));
const yard = params.has('stall')
  ? buildYard(
      { ...feed, lanes: stallMarks },
      [],
      { total: 10, held: 0, listed: 10, more: false, entries: stallEntries },
      NOW,
    )
  : buildYard(feed, lanes, { total: 2, held: 1, listed: 3, more: false, entries }, NOW);
const base = [
  ...entries,
  { position: 3, laneId: ids.acct1, phase: 'queued', submittedAt: at(9), lastProgressAt: at(9) },
] as QueueEntry[];
// `?waits=12` / `?waits=50`: that many open Lanes in one queue, each behind the one ahead, plus one held for a person
// and a loop of two Lanes that depend on each other (`?waits=loop` is the loop alone), with long and non-Latin titles.
const crowd = Number(params.get('waits'));
const lane = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const crowded: QueueEntry[] = Array.from({ length: Number.isFinite(crowd) ? crowd : 0 }, (_, i) => ({
  position: i + 1,
  laneId: lane(i),
  landingState: { state: i === 0 ? 'checking' : 'waiting-for-order' },
  phase: i === 0 ? 'checking' : 'queued',
  submittedAt: at(90 - i),
  lastProgressAt: at(1),
}));
const loop: QueueEntry[] = ['one', 'two'].map((name, i) => ({
  position: null,
  laneId: lane(900 + i),
  submissionId: `loop-${name}`,
  landingState: { state: 'held-dependency' },
  phase: 'ready',
  hold: { kind: 'dependency', reason: 'Waits for the Lane it depends on.', paths: null },
  dependsOn: { submissionId: `loop-${i ? 'one' : 'two'}` },
  submittedAt: at(120),
  lastProgressAt: at(120),
}));
const waitEntries = params.get('waits') === 'loop' ? loop : crowd > 0 ? [...crowded, ...loop] : base;
const titles = new Map(lanes.map(lane => [lane.laneId, lane.intent]));
const crowdTitle = (laneId: string) => {
  const n = Number(laneId.slice(-12));
  return n >= 900
    ? `A dependency loop, Lane ${n - 899}`
    : n % 5 === 3
      ? `長いタイトルのレーンです、番号 ${n}`
      : `Lane ${n}: ${'a very long Item title that has to be cut '.repeat((n % 4) + 1)}`;
};
const titleOf = (laneId: string) =>
  titles.get(laneId) ?? (laneId.startsWith('b0000000') ? crowdTitle(laneId) : `Lane ${laneId.slice(0, 8)}`);
const pairs = waits(waitEntries, titleOf);
const laneOf = (laneId: string): ChainLane => ({
  title: titleOf(laneId),
  state: yard.rows.find(row => row.laneId === laneId)?.state ?? (laneId.endsWith('0') ? 'active' : 'waiting'),
  word: 'open',
});

const shares = sharesByLane([
  { path: 'web/src/app/account/Projects.tsx', laneIds: [ids.acct1, ids.acct2, ids.acct3] },
  { path: 'web/src/app/account/account.css', laneIds: [ids.acct1, ids.acct2] },
]);

// The overview on its real address: the same Lanes, one more whose check failed, served by the real Lanes place.
const failedMark = mark(ids.failed, 'checking', 12, true);
const failedMeta = meta(ids.failed, 'stream', 'Stream parser: handle split UTF-8', 'devon/salt-wren', 12);
const failedEntry: QueueEntry = {
  position: null,
  laneId: ids.failed,
  landingState: { state: 'check-failed' },
  phase: 'ready',
  lastFailingTests: ['tests/stream-backpressure.test.ts'],
  submittedAt: at(12),
  lastProgressAt: at(12),
};
// Doubled scale: every open Lane again under a new id, the queue unchanged.
const twin = (laneId: string) => `d${laneId.slice(1)}`;
const scale = params.has('double') ? 2 : 1;
const openMarks = [...feed.lanes, failedMark];
const openMeta = [...lanes, failedMeta];
const state = params.get('state');
// Worst case (break-ui): a 200-character title, a long handle and run, a 1,284th place, Japanese and Arabic titles,
// markup in a title, an emoji handle, and a run that declared no app.
const worst = {
  long: 'b0000000-0000-4000-8000-000000000001',
  ja: 'b0000000-0000-4000-8000-000000000002',
  ar: 'b0000000-0000-4000-8000-000000000003',
  tag: 'b0000000-0000-4000-8000-000000000004',
  emoji: 'b0000000-0000-4000-8000-000000000005',
};
const worstMarks = [
  mark(worst.long, 'saved', 5200, true),
  mark(worst.ja, 'checking', 1),
  mark(worst.ar, 'queued', 3),
  mark(worst.tag, 'editing', 2),
  mark(worst.emoji, 'saved', 4320),
];
const worstMeta: LaneMeta[] = [
  {
    ...meta(
      worst.long,
      'long',
      'Rewrite the chunked transfer decoder so that trailers, zero-length chunks and a missing final CRLF are all accepted without buffering the whole body in memory (fixes #1284, follow-up to the surrogate-pair revert)',
      'bartholomew-fitzgerald',
      5200,
    ),
    agentRun: 'incandescent-mantis-shrimp',
    agentClient: 'an-agent-app-with-a-very-long-name:model-with-a-very-long-identifier-12',
  },
  {
    ...meta(
      worst.ja,
      'ja',
      'ストリームパーサー：チャンク境界で分割されたUTF-8シーケンスを処理する',
      'mara/amber-fox',
      1,
    ),
    agentClient: 'claude-code:claude-opus-5-5',
  },
  {
    ...meta(worst.ar, 'ar', 'إصلاح تسرب الذاكرة في محوّل الجلب عند إلغاء الطلب', 'mara/still-heron', 3),
    agentClient: 'codex',
  },
  meta(worst.tag, 'tag', '<b>prod</b> &amp; staging hotfix', 'jo', 2),
  { ...meta(worst.emoji, 'emoji', 'Fix tests', '🦊/owl', 4320), agent: true },
];
const worstEntries: QueueEntry[] = [
  {
    position: 1,
    laneId: worst.ja,
    phase: 'checking',
    landingState: { state: 'checking' },
    submittedAt: at(1),
    lastProgressAt: at(1),
  },
  {
    position: 1284,
    laneId: worst.ar,
    phase: 'queued',
    landingState: { state: 'waiting-for-order' },
    submittedAt: at(3),
    lastProgressAt: at(3),
  },
  {
    position: null,
    laneId: worst.long,
    phase: 'conflict',
    landingState: { state: 'conflict' },
    error: 'CONFLICT',
    submittedAt: at(5200),
    lastProgressAt: at(5200),
  },
];
const readyMarks =
  scale === 2 ? [...openMarks, ...openMarks.map(m => ({ ...m, laneId: twin(m.laneId) }))] : openMarks;
const overviewFeed: LineFeed = {
  ...feed,
  lanes: state === 'empty' ? [] : state === 'worst' ? [...openMarks, ...worstMarks] : readyMarks,
  ...(state === 'worst' ? { more: 1283, moreIsLowerBound: true } : {}),
};
const overviewMeta =
  state === 'empty'
    ? []
    : state === 'worst'
      ? [...openMeta, ...worstMeta]
      : scale === 2
        ? [...openMeta, ...openMeta.map(l => ({ ...l, laneId: twin(l.laneId) }))]
        : openMeta;
const overviewQueue =
  state === 'empty'
    ? { total: 0, held: 0, listed: 0, more: false, entries: [] }
    : {
        total: state === 'worst' ? 1286 : 2,
        held: state === 'worst' ? 3 : 2,
        listed: 4,
        more: state === 'worst',
        entries: [...entries, failedEntry, ...(state === 'worst' ? worstEntries : [])],
      };
// Needs me's read: the approval waits on this reader; the failed check is its agent's next step (48049998).
const heldLane = (laneId: string, why: 'review' | 'check-failed' | 'conflict') => ({
  laneId,
  title: titles.get(laneId) ?? null,
  actor: 'mara',
  agent: null,
  why,
  note: null,
  submissionId: `s-${laneId}`,
  since: NOW,
});
const overviewNeeds = {
  held:
    state === 'empty'
      ? []
      : [
          heldLane(ids.held, 'review'),
          heldLane(ids.failed, 'check-failed'),
          ...(state === 'worst' ? [heldLane(worst.long, 'conflict')] : []),
        ],
  more: 0,
  moreIsLowerBound: false,
  approvals: '{}',
  canDecide: true,
  parked: [],
};
const overlap = {
  lanes: [{ laneId: ids.acct1 }, { laneId: ids.acct2 }, { laneId: ids.acct3 }],
  paths: ['web/src/app/account/Projects.tsx', 'web/src/app/account/account.css'],
  edits: [
    { lane: 0, paths: [0, 1] },
    { lane: 1, paths: [0, 1] },
    { lane: 2, paths: [0] },
  ],
  complete: true,
};
const fake = fakeConvex({
  resolve: (name: string) =>
    name === 'projectNeedsMe:read'
      ? overviewNeeds
      : name === 'projectHostedLiveLanes:list'
        ? state === 'loading'
          ? undefined
          : state === 'failed'
            ? (() => {
                throw new Error('the Lane page could not be read');
              })()
            : JSON.stringify({ page: overviewMeta, isDone: true })
        : name === 'projectHostedQueueView:read'
          ? JSON.stringify(overviewQueue)
          : name === 'projectNowOverlaps:now'
            ? JSON.stringify({ signals: overlap })
            : name === 'projectPlanCounts:read'
              ? // The project's Item counts (Needs me's and Plan's read); ?state=nocounts: the read gives none.
                state === 'nocounts'
                ? null
                : {
                    exact: true,
                    issue: { proposed: 2, open: 9, inProgress: 4, closed: 31, abandoned: 1 },
                    closedToday: null,
                  }
              : null,
});
Object.assign(window, { forgeReads: fake.stats, forgeLive: (name: string) => fake.count(name) });
// The real registry, collected the way screens.tsx collects it; each entry is named by its folder and index.
const registry = Object.entries(
  import.meta.glob<ScreenRoutes>('../../web/src/app/*/route.ts', { eager: true, import: 'default' }),
);
const entriesOfAll = registry.flatMap(([, routes]) => routes);
const folderOf = new Map(
  registry.flatMap(([path, routes]) =>
    routes.map((entry, i) => [entry, `${/app\/([^/]+)\/route\.ts$/.exec(path)![1]}#${i}`] as const),
  ),
);

function Routed() {
  const route = useRoute();
  // The frame's own subscription for the top bar's Needs you count (App.tsx).
  useQuery(needsRead, { projectId: 'sample' as Id<'hostedProjects'> });
  if (route.frame !== 'project') return <main data-screen="none" />;
  const entry = projectScreenFor(entriesOfAll, route);
  const screen = (entry && folderOf.get(entry)) ?? 'placeholder';
  return (
    <main id="main" tabIndex={-1} data-screen={screen}>
      {screen === 'lanes#0' ? (
        <LanesPlace
          route={route}
          projectId={'sample' as Id<'hostedProjects'>}
          projectName="Sample project"
          feed={overviewFeed}
          viewerHandle="mara"
        />
      ) : (
        <h1>Screen {screen}</h1>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  location.pathname !== '/yard.html' ? (
    <ConvexProvider client={fake.client as never}>
      <Routed />
    </ConvexProvider>
  ) : (
    <main>
      <h1 className="sr">Lanes</h1>
      <Region
        title="On the way to main"
        weight="act"
        waiting={yard.counts.needs}
        count={yard.rows.length}
        hint="stuck work first"
      >
        <Yard
          project={project}
          rows={yard.rows}
          checking={yard.checking}
          hrefOf={id => `#${id}`}
          dense={params.get('dense') === '1'}
          sharesOf={id => shares.get(id)}
          sharesHref={id => `#touching-${id}`}
        />
      </Region>
      {params.has('history') ? (
        <HistoryView
          project={project}
          trail={[]}
          page={{
            started: false,
            through: null,
            newest: 3,
            next: null,
            scanned: 3,
            rows: [
              { sequence: 3, actor: 'mara', agent: true, agentRun: 'quiet-otter', model: 'gpt-example' },
              { sequence: 2, actor: null, agent: true, agentRun: 'amber-fox', model: 'unknown' },
              { sequence: 1, actor: 'devon', agent: false, agentRun: null, model: null },
            ].map(stamp => ({
              ...stamp,
              title: ['Preserve read marks', 'Trace review order', 'Handle split UTF-8'][stamp.sequence - 1]!,
              receiptId: String(stamp.sequence),
              at: at(2),
              goal: null,
              message: null,
              item: null,
              laneId: null,
              automatic: true,
              read: false,
            })),
          }}
          error={false}
          filter={{ unread: false, by: null, item: null }}
          approvals={0}
          needsMe="#needs"
          laneHref={id => `#${id}`}
          receiptHref={id => `#receipt-${id}`}
          onFilter={() => {}}
          onMark={() => {}}
          onMarkAll={() => {}}
          showEarlier={() => {}}
          busy={false}
          earlierFailed={false}
          status={null}
        />
      ) : null}
      <Region title="Who waits on whom" weight="act" waiting={1} count={pairs.length}>
        <WaitChains waits={pairs} laneOf={laneOf} laneHref={id => `#${id}`} decideHref="#needs" now={NOW} />
      </Region>
    </main>
  ),
);
