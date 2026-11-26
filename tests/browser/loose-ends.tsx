// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Needs me › Loose ends (Item fc1831eb) on synthetic data, through the real shell frame and the real route screen, with
// a Convex client that records every call (window.calls) behind the app's sleeping live reads (window.reads).
// `?data=demo` has all five groups, with more pages in Lanes nobody holds, leftover projects
// and dated checks; the second dated page is empty and continues. `?data=worst` has long, right-to-left and CJK text,
// 25 Lanes with more, and dated coverage still being prepared. `?data=one` is exactly one Lane; `?data=empty` is
// nothing left; `?data=loading` never answers; `?data=error` fails the live read and a retry answers.
// `&fail=page` fails the first next-page call; `&fail=stale` refuses the first dated cursor as WORK_STALE; `&fail=set`
// fails the first set-aside call; `&fail=trash` fails the first trash call; `&owner=0` is a member. A Lane set aside or
// saved meanwhile leaves the live read and comes back when Undo reopens it; a project in the trash leaves it and comes
// back when restored. Open Intents with no Item are read on request (the Intent cursor): the first page has a long
// right-to-left title, an Intent whose Item link is not reported and one whose activity is not known; its second page is
// empty and continues, its third ends the group. `&fail=tidy` fails the first batch call; `&fail=undo` fails the first reopen; Intent ...0002 gained a save
// meanwhile (skipped and named); Undo reopens through the lifecycle transition. tidepool-import-test changed meanwhile, so its trash call is refused (WORK_STALE). The clipboard
// is recorded (window.copied).
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { createRoot } from 'react-dom/client';
import '../../web/src/ds';
import '../../web/src/app/app.css';
import '../../web/src/app/needs/needs.css';
import { Region } from '../../web/src/ds';
import { ProjectFrame } from '../../web/src/app/frames';
import type { LooseEndsRead } from '../../web/src/app/needs/loose-ends';
import { createLiveReads } from '../../web/src/live-reads';

const params = new URLSearchParams(location.search);
const data = params.get('data') ?? 'demo';
const fail = params.get('fail');
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const NOW = Date.UTC(2026, 10, 22, 10, 2);
const ago = (minutes: number) => NOW - minutes * 60_000;
const day = 24 * 60;
const LONG = 'bartholomew-fitzgerald';
const LONG_AGENT = 'incandescent-mantis-shrimp';
const lane = (n: number, title: string, minutes: number, extra = {}) => ({
  laneId: `5d1c7a0e-0000-4000-8000-${String(n).padStart(12, '0')}`,
  intentId: `5d1c7a0e-0000-4000-8001-${String(n).padStart(12, '0')}`,
  title,
  actor: 'sample-one',
  agent: 'quiet-otter',
  paths: 2,
  at: ago(minutes),
  ...extra,
});
const project = (
  n: number,
  name: string,
  days: number | null,
  role = 'owner',
  stored: { openLanes?: number; bytes?: number } = {},
) => ({
  projectId: `p${n}`,
  name,
  role,
  lastLandingAt: days === null ? null : ago(days * day),
  reason: days === null ? 'No landing recorded since creation' : 'No landing in the past 30 days',
  ...stored,
  ...(role === 'owner' ? { trash: { expectedRevision: 10 + n } } : {}),
});
const dated = (n: number, text: string, date: string, reason: string, title = 'v3 release', extra = {}) => ({
  selection: { itemId: `0e6c1f2a-0000-4000-8000-${String(n).padStart(12, '0')}`, expectedVersion: 9 },
  title,
  date,
  line: 3,
  text,
  reason,
  ...extra,
});
const INTENTS = 'forge-loose-ends-intents-v1:';
const intentAt = (n: number) => ({
  projectId: 'fixture-project',
  intentId: `5d1c7a0e-0000-4000-8002-${String(n).padStart(12, '0')}`,
  version: 3,
  laneRevision: 0,
  observedAt: NOW,
});
const intent = (n: number, title: string, days: number | null, extra = {}) => ({
  selection: intentAt(n),
  status: 'active',
  title,
  lastActivityAt: days === null ? null : new Date(ago(days * day)).toISOString(),
  reason: 'No linked Item',
  ...extra,
});
const waiting = [{ id: 'req-1', selector: 'the trash', projects: 40, byDevice: true }];
const none = { reported: true as const, rows: [], continueCursor: null };

function first(): LooseEndsRead {
  const setAside = params.get('owner') === '0' ? null : { authorityEpoch: 1 };
  if (data === 'empty')
    return {
      at: NOW,
      setAside,
      groups: { idle: none, stopped: none, checked: none, projects: none, dated: none },
    };
  if (data === 'one')
    return {
      at: NOW,
      setAside,
      groups: {
        idle: {
          reported: true,
          rows: [lane(1, 'Fix flaky retry timer', 6 * day, { saves: 3 })],
          continueCursor: null,
        },
        stopped: none,
        checked: none,
        projects: none,
        dated: none,
      },
    };
  if (data === 'worst')
    return {
      at: NOW,
      setAside,
      groups: {
        idle: {
          reported: true,
          continueCursor: 'idle-p2',
          rows: [
            lane(1, 'ストリームパーサー：チャンク境界で分割されたUTF-8シーケンスを処理する', 330 * day, {
              actor: LONG,
              agent: LONG_AGENT,
              paths: 12_840,
              saves: 1_284,
            }),
            lane(2, 'x', 2 * day, { actor: 'jo', agent: 'ox', paths: 1, saves: 1 }),
            // A Lane written before the counts existed: its row says "not recorded", never a guessed number.
            lane(3, '', 3 * day, { paths: 0 }),
            ...Array.from({ length: 22 }, (_, i) =>
              lane(10 + i, `Sample Lane ${i + 4}`, (4 + i) * day, {
                saves: i + 2,
                ...(i % 2 ? {} : { actor: LONG }),
                ...(i === 3 ? { landedBefore: true } : {}),
              }),
            ),
          ],
        },
        stopped: {
          reported: true,
          continueCursor: null,
          rows: [
            lane(40, 'Benachrichtigungseinstellungen für Übersetzungsaufträge', 3 * day, {
              actor: LONG,
              agent: LONG_AGENT,
              saves: 318,
            }),
          ],
        },
        checked: {
          reported: true,
          continueCursor: null,
          rows: [
            lane(
              45,
              'Revert "Revert "Stream parser: handle split UTF-8 sequences across chunk boundaries when the upstream transform emits zero-length buffers""',
              330 * day,
              { actor: 'jo', agent: 'ox', saves: 4, passedAt: ago(330 * day) },
            ),
          ],
        },
        projects: {
          reported: true,
          continueCursor: 'projects-p2',
          deleteRequests: [{ ...waiting[0]!, projects: 212 }],
          rows: [
            project(
              1,
              'tidepool-benchmark-streaming-backpressure-integration-fixtures-zoo-n10-rerun-after-queue-fix-2',
              400,
              'owner',
              { openLanes: 37, bytes: 1_200_000_000_000 },
            ),
            project(2, 'x', null),
            project(3, 'مشروع-اختبار-٣', 31, 'write', { openLanes: 0, bytes: 0 }),
          ],
        },
        dated: {
          reported: true,
          why: 'The Plan search index is still being prepared. Dated checks may be incomplete.',
          continueCursor: null,
          rows: [
            dated(
              1,
              'تحديث مكتبة الاختبار لدعم البث المتقطع في المحولات الجديدة قبل إصدار النسخة الثالثة',
              '2026-11-06',
              'Date passed',
              'Revert "Revert "Stream parser: handle split UTF-8 sequences across chunk boundaries""',
            ),
            dated(2, 'x', '2027-01-01', 'Upcoming date', 'v3 release', {
              owner: `@${LONG}/${LONG_AGENT}`,
              proposed: true,
            }),
          ],
        },
        active: {
          reported: true,
          rows: [lane(50, 'Compare and restore Item versions', 108, { heldBy: 'Landing queue' })],
        },
      },
    };
  return {
    at: NOW,
    setAside,
    groups: {
      idle: {
        reported: true,
        continueCursor: 'idle-p2',
        rows: [
          lane(1, 'Fix flaky retry timer', 6 * day, { paths: 2, saves: 3 }),
          lane(2, 'Try streaming decoder', 3 * day, {
            actor: 'mara',
            agent: 'salt-wren',
            paths: 7,
            saves: 1,
          }),
          lane(3, 'Revert the parser rewrite', 3 * day - 60, {
            actor: 'mara',
            agent: 'still-heron',
            paths: 1,
            saves: 1,
            landedBefore: true,
          }),
        ],
      },
      stopped: {
        reported: true,
        continueCursor: null,
        rows: [
          lane(4, 'Docs: migration guide v3', 180, {
            actor: 'jun',
            agent: 'copper-moth',
            paths: 3,
            saves: 3,
          }),
        ],
      },
      checked: {
        reported: true,
        continueCursor: null,
        rows: [
          lane(5, 'Docs: typo sweep', 3 * day, {
            actor: 'mara',
            agent: 'still-heron',
            paths: 1,
            saves: 2,
            passedAt: ago(3 * day),
          }),
        ],
      },
      projects: {
        reported: true,
        continueCursor: 'projects-p2',
        deleteRequests: waiting,
        rows: [
          project(1, 'mara-scratch', 41, 'owner', { openLanes: 0, bytes: 12_000_000 }),
          project(2, 'tidepool-import-test', null, 'owner', { openLanes: 0, bytes: 310_000_000 }),
        ],
      },
      dated: {
        reported: true,
        continueCursor: 'dated-p2',
        rows: [
          dated(1, 'Run the benchmark again after v3 ships', '2026-12-01', 'Upcoming date', 'v3 release', {
            owner: '@mara',
            proposed: true,
          }),
          dated(2, 'Re-check the mirror lag', '2026-11-20', 'Date passed', 'Mirror health'),
        ],
      },
    },
  };
}

/** The Intent group's pages, as the Intent cursor of projectLooseEnds:read answers them. */
function intentPage(cursor: string) {
  const group = (rows: unknown[], continueCursor: string | null) => ({
    at: NOW,
    setAside: { authorityEpoch: 1 },
    groups: { intents: { reported: true, rows, continueCursor } },
  });
  if (cursor === INTENTS)
    return group(
      [
        intent(1, 'Spike: try the streaming decoder on the old parser', 40),
        intent(2, 'Investigate flaky retry timer', 12),
        intent(3, 'ストリームパーサー：チャンク境界で分割されたUTF-8シーケンスを処理する', 6, {
          status: 'proposed',
        }),
        intent(4, 'تحديث مكتبة الاختبار لدعم البث المتقطع', 3),
        intent(5, 'Imported work whose Item link is not reported', 2, { reason: 'Item link not reported' }),
        intent(6, 'An Intent with more Lanes than one read covers', null),
      ],
      'intents-p2',
    );
  if (cursor === 'intents-p2') return group([], 'intents-p3');
  return group([intent(7, 'Older experiment', 90)], null);
}

/** The next page for a cursor, as projectLooseEnds:read answers it. */
function next(cursor: string): LooseEndsRead {
  if (cursor === 'idle-p2')
    return {
      at: NOW,
      setAside: { authorityEpoch: 1 },
      groups: {
        idle: { reported: true, continueCursor: null, rows: [lane(60, 'Older experiment', 20 * day)] },
        stopped: none,
      },
    };
  if (cursor === 'projects-p2')
    return {
      at: NOW,
      groups: {
        projects: {
          reported: true,
          continueCursor: null,
          rows: [project(9, 'tidepool-docs-old', 30, 'owner', { openLanes: 1, bytes: 88_000_000 })],
        },
      },
    };
  if (cursor === 'dated-p2')
    return { at: NOW, groups: { dated: { reported: true, rows: [], continueCursor: 'dated-p3' } } };
  return {
    at: NOW,
    groups: {
      dated: {
        reported: true,
        continueCursor: null,
        rows: [dated(3, 'Remove the legacy fallback', '2026-12-15', 'Upcoming date', 'Loose ends')],
      },
    },
  };
}

const calls: string[] = [];
let pageFailures = fail === 'page' ? 1 : 0;
let setFailures = fail === 'set' ? 1 : 0;
let trashFailures = fail === 'trash' ? 1 : 0;
let tidyFailures = fail === 'tidy' ? 1 : 0;
let undoFailures = fail === 'undo' ? 1 : 0;
let subscriptions = 0;
let staleSeen = false;
/** Lanes the live read no longer lists: set aside, or saved meanwhile (no longer idle). */
const gone = new Set<string>();
const listeners = new Set<() => void>();
const name = (query: FunctionReference<'query' | 'mutation'>) => getFunctionName(query);
const live = () => {
  const read = first();
  const idle = read.groups.idle;
  if (idle?.reported) idle.rows = idle.rows.filter(row => !gone.has(row.laneId));
  const projects = read.groups.projects;
  if (projects?.reported) projects.rows = projects.rows.filter(row => !gone.has(row.projectId));
  return JSON.stringify(read);
};
const rerun = () => queueMicrotask(() => listeners.forEach(listener => listener()));
const copied: string[] = [];
const subscriptionChanges: string[] = [];
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: async (text: string) => void copied.push(text) },
});
const fake = {
  watchQuery(query: FunctionReference<'query'>, args: Record<string, unknown>) {
    const { projectId: _, ...rest } = args;
    return {
      localQueryResult: () => {
        if (!args.details) return live();
        if (data === 'loading') return undefined;
        // The failed read answers once the page subscribes again (its Try again).
        if (data === 'error' && subscriptions < 2) throw new Error('Synthetic read failure');
        return live();
      },
      onUpdate: (listener: () => void) => {
        if (args.details) subscriptions++;
        listeners.add(listener);
        const joined = `subscribe ${name(query)} ${JSON.stringify(rest)}`;
        subscriptionChanges.push(joined);
        if (args.details) calls.push(joined);
        // The fresh subscription's answer arrives from the server.
        if (args.details && data === 'error' && subscriptions === 2) queueMicrotask(listener);
        return () => {
          listeners.delete(listener);
          subscriptionChanges.push(`unsubscribe ${name(query)} ${JSON.stringify(rest)}`);
          if (args.details) calls.push(`unsubscribe ${name(query)}`);
        };
      },
    };
  },
  async query(query: FunctionReference<'query'>, args: { cursor?: string; details?: true }) {
    calls.push(`query ${name(query)} ${args.cursor ?? (args.details ? 'details' : '')}`);
    if (args.cursor?.startsWith('dated') && fail === 'stale' && !staleSeen) {
      staleSeen = true;
      throw new ConvexError({
        code: 'WORK_STALE',
        message: 'The Plan changed. Start a new Loose ends read.',
      });
    }
    if (args.cursor && pageFailures-- > 0) throw new Error('Synthetic page failure');
    if (args.cursor && (args.cursor === INTENTS || args.cursor.startsWith('intents-')))
      return JSON.stringify(intentPage(args.cursor));
    return JSON.stringify(args.cursor ? next(args.cursor) : first());
  },
  async mutation(
    mutation: FunctionReference<'mutation'>,
    args: {
      abandon?: string[];
      reopen?: { laneId: string; version: number }[];
      projectId?: string;
      expectedRevision?: number;
    },
  ) {
    const called = name(mutation);
    if (called === 'projectLooseEndIntents:setAside') {
      const { request, operationId } = args as unknown as { request: string; operationId: string };
      const intents = (JSON.parse(request) as { intents: { intentId: string; version: number }[] }).intents;
      calls.push(`mutation ${called} ${operationId} ${intents.map(row => row.intentId.slice(-3)).join(',')}`);
      if (tidyFailures-- > 0) throw new Error('Synthetic tidy failure');
      return JSON.stringify({
        operationId,
        receiptId: 'r1',
        results: intents.map(row =>
          row.intentId.endsWith('000000000002')
            ? { intentId: row.intentId, result: 'saved-since-selection' }
            : { intentId: row.intentId, result: 'set-aside', receiptId: 'r', version: row.version + 1 },
        ),
      });
    }
    if (called === 'projectHostedLifecycle:transition') {
      const { target, action } = JSON.parse((args as unknown as { request: string }).request) as {
        action: string;
        target: { intentId: string; version: number };
      };
      calls.push(`mutation ${called} ${action} ${target.intentId.slice(-3)} ${target.version}`);
      if (undoFailures-- > 0) throw new Error('Synthetic reopen failure');
      return '{}';
    }
    if (called === 'projectLifecycle:trash' || called === 'projectLifecycle:restore') {
      calls.push(`mutation ${called} ${args.projectId} ${args.expectedRevision}`);
      if (called === 'projectLifecycle:trash' && trashFailures-- > 0)
        throw new Error('Synthetic trash failure');
      if (called === 'projectLifecycle:trash' && args.projectId === 'p2')
        throw new ConvexError({ code: 'WORK_STALE', message: 'Project changed.' });
      if (called === 'projectLifecycle:trash') gone.add(args.projectId!);
      else gone.delete(args.projectId!);
      rerun();
      return null;
    }
    if (args.reopen?.length) {
      calls.push(`mutation ${called} reopen ${JSON.stringify(args.reopen)}`);
      for (const pin of args.reopen) gone.delete(pin.laneId);
      rerun();
      return JSON.stringify({
        results: args.reopen.map(pin => ({
          laneId: pin.laneId,
          result: 'reopened',
          version: pin.version + 1,
        })),
      });
    }
    calls.push(`mutation ${called} ${JSON.stringify(args.abandon)}`);
    if (setFailures-- > 0) throw new Error('Synthetic set-aside failure');
    // Lane 2 gained a save while the reader was choosing. Both leave the live list, which re-runs at once.
    for (const laneId of args.abandon ?? []) gone.add(laneId);
    rerun();
    return JSON.stringify({
      results: (args.abandon ?? []).map(laneId =>
        laneId.endsWith('000000000002')
          ? { laneId, result: 'not-dormant' }
          : { laneId, result: 'abandoned', version: 5 },
      ),
    });
  },
};
const reads = createLiveReads();
Object.assign(window, { calls, reads, copied, subscriptionChanges });
const client = reads.client(fake) as unknown as ConvexReactClient;
const route = {
  frame: 'project' as const,
  handle: 'sample-one',
  project: 'tidepool',
  place: 'needs' as const,
  section: '',
  rest: '',
};
const { LooseBody } = await import('../../web/src/app/needs/LooseFold');

createRoot(document.getElementById('root')!).render(
  <ProjectFrame
    route={route}
    name="tidepool"
    feed={undefined}
    needs={{ n: 0, atLeast: false }}
    projects={null}
    controls={{ onPalette: () => {}, onKeys: () => {}, viewerHandle: 'sample-one', onPicker: () => {} }}
  >
    <ConvexProvider client={client}>
      <div className="needs-me">
        <Region title="Loose ends">
          <LooseBody
            route={route}
            projectId={(params.get('here') ?? 'fixture-project') as never}
            projectName="tidepool"
            viewerHandle="sample-one"
            open
            setAside={async () => {
              throw new Error('The Select fixture exercises the detailed actions.');
            }}
          />
        </Region>
      </div>
    </ConvexProvider>
  </ProjectFrame>,
);
