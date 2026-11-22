// SPDX-License-Identifier: Apache-2.0
// Needs me (Item 48049998) on synthetic data, through the real shell frame, screen, model and the folded Loose ends
// body: `?data=busy` holds a protected-path approval and a question, with an agent's conflict, a refusal and a
// person's own failed check under FYI beside landings and a settings change, plus Lanes parked for the reader (Item
// e1633718): one named to them, one with no one named idle 5 h (shown) and one idle 1 h (not yet); `?data=first` is a
// first day with one approval. The Flow picture (Item 85f456c1) draws the line feed: `busy` holds its held Lanes at
// Saved, In queue and Checking among moving work; `?data=calm` is the same project with nothing waiting on the reader;
// `?data=worst` is 56 open Lanes with long handles, right-to-left and 50+ character titles and a request asked ahead.
// The shell's Needs you count comes from the same rule as the page (needs/count.ts).
import { useState } from 'react';
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { createRoot } from 'react-dom/client';
import '../../web/src/ds';
import '../../web/src/app/app.css';
import { ProjectFrame } from '../../web/src/app/frames';
import type { LineFeed } from '../../web/src/app/Line';
import { needsCount, type NeedsRead } from '../../web/src/app/needs/count';
import type { FyiRead } from '../../web/src/app/needs/fyi';
import { stressText } from '../../web/src/ds/reference/stress-text';
import type { LooseEndsRead } from '../../web/src/app/needs/loose-ends';

const params = new URLSearchParams(location.search);
const stall = params.get('data') === 'stall';
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const review = params.get('data') === 'review';
const first = params.get('data') === 'first' || review;
const connect = params.get('data') === 'connect';
const calm = params.get('data') === 'calm' || stall;
const variant = params.get('data');
const stress = variant === 'stress';
const worst = stress || variant === 'worst' || variant === 'over';
const quiet = variant === 'quiet' || variant === 'empty';
const unavailable = variant === 'loading' || variant === 'error';
const writes: unknown[] = [];
(window as unknown as { writes: unknown[] }).writes = writes;

const NOW = new Date(2026, 10, 17, 15, 0).getTime();
const ago = (minutes: number) => NOW - minutes * 60_000;
const uuid = (n: number) => `5d1c7a0e-0000-4000-8000-${String(n).padStart(12, '0')}`;
const lane = (n: number, why: NeedsRead['held'][number]['why'], minutes: number, extra = {}) => ({
  laneId: uuid(n),
  intentId: uuid(100 + n),
  title: null as string | null,
  actor: 'sample-one',
  agent: 'quiet-otter' as string | null,
  why,
  note: null as string | null,
  submissionId: null,
  since: ago(minutes),
  ...extra,
});
const approval = (laneId: string, reason: string, minutes: number) => ({
  laneId,
  kind: 'lane' as const,
  needsOwner: true,
  label: 'Landing waits for the owner',
  nextStep: 'Approve or decline it in Forge.',
  reason,
  requester: 'sample-one',
  agent: 'amber-fox',
  head: 'a'.repeat(64),
  at: new Date(ago(minutes)).toISOString(),
});

const baseRead: NeedsRead = first
  ? {
      held: [
        lane(1, 'review', 6, {
          title: 'Stream parser: handle split UTF-8',
          agent: 'amber-fox',
          agentClient: 'codex:gpt-example',
          agentAuthored: true,
          ...(review
            ? {
                submissionId: uuid(501),
                attemptId: uuid(502),
                url: `/approve?project=synthetic&submission=${uuid(501)}`,
                note: 'needs owner approval: protected paths .github/workflows/ci.yml',
              }
            : {}),
        }),
      ],
      more: 0,
      moreIsLowerBound: false,
      approvals: JSON.stringify({
        requests: review
          ? []
          : [approval(uuid(1), 'Every landing waits for you until you choose otherwise.', 6)],
        complete: true,
      }),
      canDecide: true,
      asks: [],
    }
  : {
      held: [
        lane(1, 'unknown', 18, { title: 'CI: drop Node 18 from the matrix', agent: 'salt-wren' }),
        // Owner dogfood 2026-11-17: a person's own Lane whose check failed, with a raw id for a goal.
        lane(2, 'check-failed', 11, {
          title: uuid(2),
          agent: null,
          note: 'The admission check of this change alone failed; it did not join a batch.',
        }),
        lane(3, 'conflict', 25, { title: 'Adapter: retry budget for fetch' }),
        lane(4, 'rejected', 40, {
          title: 'Release notes for 3.2',
          agent: 'copper-moth',
          note: 'The landing changes a protected path without an approval.',
        }),
      ],
      more: 0,
      moreIsLowerBound: false,
      approvals: JSON.stringify({
        requests: [
          approval(uuid(1), 'Changes .github/workflows/ci.yml, a protected path.', 18),
          {
            ...approval('setting:runner', '', 31),
            kind: 'setting',
            reason: 'salt-wren asks to let 8 checks run at once, up from 4.',
            setting: { origin: 'runner' },
          },
        ],
        complete: true,
      }),
      canDecide: true,
      asks: [
        {
          id: uuid(50),
          at: ago(9),
          actor: 'sample-two',
          agent: 'amber-fox',
          text: 'The adapter tests can run in 12 Lanes or 4. Which do you want?',
          choices: ['12 Lanes', '4 Lanes'],
          laneId: uuid(3),
        },
      ],
      parked: [
        {
          laneId: uuid(60),
          intentId: uuid(160),
          title: 'Docs: queue limits page',
          actor: 'sample-two',
          agent: 'brisk-heron',
          park: {
            to: 'sample-one',
            named: true,
            reason: 'Waits for you to say which limit the page should state.',
            at: ago(35),
            by: 'sample-two/brisk-heron',
          },
          at: ago(35),
        },
        {
          laneId: uuid(61),
          intentId: uuid(161),
          title: 'Bench: replay the 12-Lane run',
          actor: 'sample-one',
          agent: 'quiet-otter',
          park: {
            named: false,
            reason: 'Parked until the bench window ends.',
            at: ago(300),
            by: 'sample-one/quiet-otter',
          },
          at: ago(300),
        },
        {
          laneId: uuid(62),
          intentId: uuid(162),
          title: 'Parked an hour ago',
          actor: 'sample-one',
          agent: 'quiet-otter',
          park: { named: false, reason: 'Not yet four hours.', at: ago(60), by: 'sample-one/quiet-otter' },
          at: ago(60),
        },
      ],
    };

const landing = (n: number, title: string, minutes: number, extra = {}) => ({
  receiptId: uuid(200 + n),
  sequence: n,
  at: ago(minutes),
  title,
  actor: 'sample-one',
  agent: true,
  checked: true,
  redone: false,
  redoneWhy: null,
  thrown: 0 as number | null,
  laneId: uuid(300 + n),
  ...extra,
});
const fyi: FyiRead = first
  ? {
      owner: true,
      state: { clearedAt: null, clearedSequence: null, dismissed: [] },
      landings: [landing(1, 'CI: run on Forge landings', 45)],
      landingsMore: false,
      broke: [],
      settings: [
        { id: uuid(60), at: ago(50), actor: 'sample-one', areas: ['githubMirror'], rule: 'owner-person' },
      ],
      access: [],
      messages: [],
      messagesMore: false,
    }
  : {
      owner: true,
      state: { clearedAt: null, clearedSequence: null, dismissed: [] },
      landings: [
        landing(4, 'Types: narrow ReadResult', 62),
        landing(3, 'Adapter: abort on timeout', 89),
        landing(2, 'Stream parser: flush on close', 133, { redone: true, thrown: 240 }),
        landing(1, 'Bump the lockfile', 170, { checked: false }),
      ],
      landingsMore: false,
      broke: [],
      mainCheckedAt: ago(12),
      settings: [
        { id: uuid(61), at: ago(108), actor: 'sample-one', areas: ['checks'], rule: 'owner-approved' },
      ],
      access: [
        {
          id: uuid(62),
          at: ago(200),
          role: 'read',
          handle: 'odile',
          state: 'accepted',
          inviter: 'sample-one',
        },
      ],
      messages: [
        {
          id: uuid(63),
          at: ago(4),
          actor: 'sample-two',
          agent: 'still-heron',
          text: 'I moved the fixtures to tests/fixtures/streaming; nothing for you to do.',
          laneId: uuid(3),
        },
      ],
      messagesMore: false,
    };

const loose: LooseEndsRead = {
  at: NOW,
  setAside: { authorityEpoch: 1 },
  groups: {
    idle: {
      reported: true,
      more: false,
      rows: first
        ? []
        : [
            {
              laneId: uuid(70),
              intentId: uuid(170),
              title: 'Try a faster tokenizer',
              actor: 'sample-one',
              agent: 'copper-moth',
              paths: 4,
              at: ago(3 * 24 * 60),
            },
          ],
    },
    stopped: { reported: true, more: false, rows: [] },
    checked: { reported: true, more: false, rows: [] },
    projects: { reported: false, why: 'the project list is read on its own page' },
    dated: { reported: true, more: false, rows: [] },
    ...(stall
      ? {
          active: {
            reported: true,
            more: false,
            rows: [
              {
                laneId: uuid(500),
                intentId: uuid(600),
                title: 'Compare and restore Item versions',
                actor: 'sample-one',
                agent: 'zesty-salmon',
                paths: 0,
                at: ago(108),
                heldBy: 'Landing queue',
              },
            ],
          } as const,
        }
      : {}),
  },
};

// `?data=connect` (Item c63c2171): an agent's GitHub connect asked ahead, in its words; its grant continues to GitHub.
const LONG = 'a-handle-much-longer-than-any-real-one/an-agent-name-longer-still-for-tags';
const RTL = 'تحديث مكتبة الاختبار لدعم البث المتقطع في المحولات الجديدة';
const worstRead: NeedsRead = {
  held: [
    lane(1, 'review', 14, { title: RTL, actor: LONG.split('/')[0], agent: LONG.split('/')[1] }),
    lane(2, 'review', 9, {
      title: 'Streaming adapters: retry with backoff, jitter and a per-host budget for every transport',
      agent: LONG.split('/')[1],
    }),
    ...(stress
      ? [
          lane(4, 'conflict', 10, { title: stressText.email, actor: 'j' }),
          lane(5, 'conflict', 7, { title: stressText.identifier, actor: '👩🏽‍💻' }),
        ]
      : []),
    lane(3, 'conflict', 6, {
      title: 'Docs: الأسئلة الشائعة about queue limits and fairness',
      agent: 'still-heron',
    }),
  ],
  more: 0,
  moreIsLowerBound: false,
  approvals: JSON.stringify({
    requests: [
      approval(uuid(2), 'Changes .github/workflows/release.yml, a protected path.', 9),
      approval(uuid(1), `${RTL}: changes a protected path.`, 14),
      {
        ...approval('setting:runner', '', 31),
        kind: 'setting',
        reason: `${LONG.split('/')[1]} asks to let 8 checks run at once: ${RTL}`,
        setting: { origin: 'runner' },
      },
    ],
    complete: true,
  }),
  canDecide: true,
  asks: [],
};
const extraDecisions = Array.from({ length: 5 }, (_, i) =>
  lane(i + 1, 'review', 15 - i, { title: `Decision ${i + 1}` }),
);
const extraRead: NeedsRead = {
  ...worstRead,
  held: extraDecisions,
  approvals: JSON.stringify({
    requests: extraDecisions.map(row => approval(row.laneId, 'Review this Lane.', 15)),
    complete: true,
  }),
};
const conversationRead: NeedsRead = {
  held: [],
  more: 0,
  moreIsLowerBound: false,
  // Item 0a99ab23: a Lane request asked before the Lane holds a landing is listed ahead, decided on its Lane page.
  approvals: JSON.stringify({
    requests: [approval(uuid(9), 'Touches the billing migration; look first.', 5)],
    complete: true,
  }),
  canDecide: true,
  asks: [
    {
      id: uuid(70),
      at: ago(8),
      actor: 'sample-two',
      agent: 'amber-fox',
      text: 'Which endpoint?',
      choices: ['Use v1', 'Use v2'],
      laneId: uuid(3),
    },
    {
      id: uuid(71),
      at: ago(12),
      actor: 'sample-two',
      agent: 'amber-fox',
      text: 'Tried both clients',
      choices: ['Decline'],
      laneId: uuid(4),
      handBack: { head: 'b'.repeat(64), left: 'Decide which client ships', to: 'sample-one' },
    },
    {
      id: uuid(72),
      at: ago(10),
      actor: 'sample-two',
      agent: 'amber-fox',
      text: 'Use the new client next time?',
      choices: ['Use it', 'Keep the old one'],
      laneId: null,
      planningItemId: uuid(5),
      ahead: true,
    },
  ],
};
const read: NeedsRead =
  variant === 'conversation'
    ? conversationRead
    : variant === 'held-more'
      ? extraRead
      : worst || variant === 'towers'
        ? worstRead
        : calm || quiet || unavailable
          ? {
              held: [],
              more: 0,
              moreIsLowerBound: false,
              approvals: JSON.stringify({ requests: [], complete: true }),
              canDecide: true,
              asks: [],
            }
          : connect
            ? {
                held: [],
                more: 0,
                moreIsLowerBound: false,
                approvals: JSON.stringify({
                  requests: [
                    {
                      ...approval(
                        'setting:github-connect',
                        'Mirror main to synthetic/repo so reviewers on GitHub see each landing.',
                        4,
                      ),
                      kind: 'setting',
                      setting: { origin: 'github-connect' },
                    },
                  ],
                  complete: true,
                }),
                canDecide: true,
                asks: [],
              }
            : baseRead;
type Mark = LineFeed['lanes'][number];
const moving = (n: number, stage: Mark['stage'], minutes: number, check?: string): Mark => ({
  laneId: uuid(400 + n),
  stage,
  held: false,
  overlap: false,
  changedAt: ago(minutes),
  ...(check ? { check } : {}),
});
// Where each held Lane stands: the failed check back at Saved, a refusal in the queue, an approval at Checking.
const heldAt = {
  'check-failed': 'saved',
  conflict: 'saved',
  rejected: 'queued',
  review: 'ready',
  unknown: 'ready',
};
// Today on the line: landings per hour since 06:00, a needs fix, a revert, CI minutes (src/flow-day.ts).
const hourOf = (minutes: number) => Math.floor(ago(minutes) / 3_600_000);
const partial = params.get('data')?.startsWith('partial-');
const flow: NonNullable<LineFeed['flow']> = {
  hours: Array.from({ length: 9 }, (_, i) => [
    hourOf((8 - i) * 60),
    [4, 9, 12, 7, 11, 14, 10, 13, 12][i]!,
    i === 5 ? 2 : i === 7 ? 1 : 0,
    i === 6 ? 1 : 0,
    0,
    3600 + i * 600,
    i === 5 ? 1200 : 0,
  ]),
  ...(partial
    ? {
        took: params.get('data') === 'partial-measured' ? [[hourOf(2), 400]] : [],
        audit: { red: false, at: ago(20) },
        repair: {
          day: Math.floor(NOW / 86_400_000) * 86_400_000,
          partial: ['took', 'needsFix', 'ciMinutes'],
        },
      }
    : {
        took: Array.from({ length: 20 }, (_, i) => [hourOf(i * 20), 240 + ((i * 97) % 600)]),
        main: { red: false, since: ago(400) },
      }),
};
const busyLanes: Mark[] = [
  ...read.held.map(row => ({
    laneId: row.laneId,
    stage: (heldAt[row.why as keyof typeof heldAt] ?? 'saved') as Mark['stage'],
    held: true,
    overlap: row.why === 'conflict',
    changedAt: row.since,
  })),
  ...Array.from({ length: 6 }, (_, i) => moving(i, 'editing', 5 + i * 7)),
  ...Array.from({ length: 3 }, (_, i) => moving(10 + i, 'saved', 3 + i)),
  ...Array.from({ length: 3 }, (_, i) => moving(20 + i, 'queued', 2 + i)),
  moving(30, 'checking', 4, 'c0ffee01'),
  moving(31, 'checking', 4, 'c0ffee01'),
  moving(32, 'checking', 2, 'c0ffee02'),
  moving(33, 'ready', 1),
  moving(34, 'checking', 9, 'c0ffee00'),
];
// 56 open Lanes: the held three among 53 moving ones across the stops.
const worstLanes: Mark[] = [
  ...busyLanes.filter(mark => mark.held),
  ...Array.from({ length: 53 }, (_, i) =>
    moving(
      100 + i,
      (['editing', 'editing', 'saved', 'queued', 'checking'] as const)[i % 5]!,
      1 + i,
      i % 5 === 4 ? `c0ffee0${i % 3}` : undefined,
    ),
  ),
];
const towers = [
  ...Array.from({ length: 7 }, (_, i) => moving(300 + i, 'checking', 32 - i, `check-${i}`)),
  ...Array.from({ length: 24 }, (_, i) => moving(320 + i, 'checking', 24 - i, 'tower')),
];
const stalledLanes = [
  ...Array.from({ length: 4 }, (_, i) => moving(100 + i, 'checking', i === 0 ? 108 : 4 + i, `stall-${i}`)),
  ...Array.from({ length: 6 }, (_, i) => moving(110 + i, 'ready', 10 + i)),
];
const fixtureFeed: LineFeed = {
  lanes: quiet
    ? []
    : variant === 'towers'
      ? towers
      : stall
        ? stalledLanes
        : first || connect
          ? [moving(81, 'editing', 1)]
          : variant === 'over'
            ? [...worstLanes, ...Array.from({ length: 4 }, (_, i) => moving(200 + i, 'saved', 1))]
            : worst
              ? worstLanes
              : busyLanes,
  more: variant === 'over' ? 17 : 0,
  moreIsLowerBound: false,
  main: variant === 'empty' ? null : { head: 'b'.repeat(64), at: new Date(ago(62)).toISOString() },
  ...(first || connect || variant === 'empty' ? {} : { flow }),
  checks: quiet
    ? { runs: [], free: 4 }
    : stall
      ? {
          runs: stalledLanes
            .slice(0, 4)
            .map((lane, i) => ({ groups: [`stall-${i}`], lanes: 1, at: lane.changedAt })),
          free: 0,
        }
      : worst
        ? {
            runs: [
              { groups: ['c0ffee01'], lanes: 4, at: ago(4) },
              { groups: ['c0ffee00'], lanes: 3, at: ago(3) },
              { groups: ['c0ffee02'], lanes: 3, at: ago(2), reserved: true },
            ],
            free: 1,
          }
        : {
            runs: [
              { groups: ['c0ffee01'], lanes: 2, at: ago(4) },
              { groups: ['c0ffee02'], lanes: 1, at: ago(2) },
            ],
            free: 2,
          },
};

const projectName = stress ? stressText.identifier : 'tidepool';
const route = {
  frame: 'project' as const,
  handle: 'sample-one',
  project: 'tidepool',
  place: 'needs' as const,
  section: '',
  rest: '',
};
const record =
  (name: string) =>
  async (input: unknown): Promise<string> => {
    writes.push([name, input]);
    // The server's grant of a connect names GitHub's authorization (projectHostedApprovals:decide → grantConnect).
    if (connect && name === 'decide')
      return JSON.stringify({
        approval: { status: 'granted' },
        applied: { authorizeUrl: 'https://github.com/login/oauth/authorize?state=synthetic' },
      });
    return JSON.stringify({ before: fyi.state, changed: true });
  };

const { NeedsMeView } = await import('../../web/src/app/needs/NeedsMe');
const { LooseFoldView } = await import('../../web/src/app/needs/LooseFold');
const { DrawerView, StationDrawer } = await import('../../web/src/app/flow/Drawer');

type DrawerRead = { name: string; limit?: number };
const drawerReads: DrawerRead[] = [];
const queryFixture = {
  watchQuery(query: FunctionReference<'query'>, args: { limit?: number }) {
    const name = getFunctionName(query);
    return {
      localQueryResult: () => JSON.stringify({ page: [], rows: [] }),
      onUpdate: () => {
        drawerReads.push({ name, limit: args.limit });
        return () => {};
      },
    };
  },
} as unknown as ConvexReactClient;

function Fixture() {
  const [feed, setFeed] = useState(variant === 'loading' ? undefined : fixtureFeed);
  Object.assign(window, {
    drawerReads,
    advanceFlow: (step: 'save' | 'land' | 'unrelated') =>
      setFeed(current => {
        const laneId = uuid(400);
        if (!current) return current;
        if (step === 'unrelated') return { ...current, flow: { ...flow, main: { red: true, since: NOW } } };
        return step === 'save'
          ? {
              ...current,
              lanes: current.lanes.map(lane =>
                lane.laneId === laneId ? { ...lane, stage: 'saved', changedAt: NOW } : lane,
              ),
            }
          : {
              ...current,
              lanes: current.lanes.filter(lane => lane.laneId !== laneId),
              exit: { laneId, kind: 'landed', at: NOW },
            };
      }),
  });
  return (
    <ProjectFrame
      route={route}
      name={projectName}
      feed={feed}
      needs={needsCount(read, NOW)}
      projects={null}
      controls={{ onPalette: () => {}, onKeys: () => {}, viewerHandle: 'sample-one', onPicker: () => {} }}
    >
      <NeedsMeView
        route={route}
        projectName={projectName}
        feed={feed}
        feedError={variant === 'error'}
        feedReadAt={ago(2)}
        drawer={props =>
          params.has('live-drawer') ? (
            <ConvexProvider client={queryFixture}>
              <StationDrawer {...props} projectId={'fixture-project' as never} />
            </ConvexProvider>
          ) : (
            <DrawerView {...props} lanes={[]} landed={[]} />
          )
        }
        read={read}
        fyi={fyi}
        counts={{
          exact: true,
          issue: first
            ? { proposed: 0, open: 0, inProgress: 1, closed: 1, abandoned: 0 }
            : stress
              ? { proposed: 1234, open: 12345, inProgress: 5, closed: 123456, abandoned: 1 }
              : { proposed: 2, open: 7, inProgress: 5, closed: 46, abandoned: 1 },
          closedToday: null,
        }}
        decide={record('decide')}
        answer={async (ask, choice, reason) => void writes.push(['answer', ask.id, choice, reason])}
        dismiss={record('dismiss')}
        loose={open =>
          open ? (
            <LooseFoldView
              read={loose}
              setAside={record('setAside')}
              allHref="/-/sample-one/tidepool/needs/loose-ends"
              copy={async text => void writes.push(['copy', text])}
            />
          ) : null
        }
        now={NOW}
      />
    </ProjectFrame>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
