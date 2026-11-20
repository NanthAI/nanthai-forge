// SPDX-License-Identifier: Apache-2.0
// Needs me (Item 48049998) on synthetic data, through the real shell frame, screen, model and the folded Loose ends
// body: `?data=busy` holds a protected-path approval and a question, with an agent's conflict, a refusal and a
// person's own failed check under FYI beside landings and a settings change, plus Lanes parked for the reader (Item
// e1633718): one named to them, one with no one named idle 5 h (shown) and one idle 1 h (not yet); `?data=first` is a
// first day with one approval.
// The shell's Needs you count comes from the same rule as the page (needs/count.ts).
import { createRoot } from 'react-dom/client';
import '../../web/src/ds';
import '../../web/src/app/app.css';
import { ProjectFrame } from '../../web/src/app/frames';
import type { LineFeed } from '../../web/src/app/Line';
import { needsCount, type NeedsRead } from '../../web/src/app/needs/count';
import type { FyiRead } from '../../web/src/app/needs/fyi';
import type { LooseEndsRead } from '../../web/src/app/needs/loose-ends';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
const first = params.get('data') === 'first';
const connect = params.get('data') === 'connect';
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
      held: [lane(1, 'review', 6, { title: 'Stream parser: handle split UTF-8', agent: 'amber-fox' })],
      more: 0,
      moreIsLowerBound: false,
      approvals: JSON.stringify({
        requests: [approval(uuid(1), 'Every landing waits for you until you choose otherwise.', 6)],
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
  },
};

// `?data=connect` (Item c63c2171): an agent's GitHub connect asked ahead, in its words; its grant continues to GitHub.
const read: NeedsRead = connect
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
const feed: LineFeed = {
  lanes: [
    ...read.held.map(row => ({
      laneId: row.laneId,
      stage: 'saved' as const,
      held: true,
      overlap: false,
      changedAt: row.since,
    })),
    { laneId: uuid(80), stage: 'checking', held: false, overlap: false, changedAt: ago(3) },
    { laneId: uuid(81), stage: 'editing', held: false, overlap: false, changedAt: ago(1) },
  ],
  more: 0,
  moreIsLowerBound: false,
  main: { head: 'b'.repeat(64), at: new Date(ago(62)).toISOString() },
};

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
createRoot(document.getElementById('root')!).render(
  <ProjectFrame
    route={route}
    name="tidepool"
    feed={feed}
    needs={needsCount(read, NOW)}
    projects={null}
    controls={{ onPalette: () => {}, onKeys: () => {}, viewerHandle: 'sample-one', onPicker: () => {} }}
  >
    <NeedsMeView
      route={route}
      projectName="tidepool"
      feed={feed}
      read={read}
      fyi={fyi}
      counts={{
        exact: true,
        issue: first
          ? { proposed: 0, open: 0, inProgress: 1, closed: 1, abandoned: 0 }
          : { proposed: 2, open: 7, inProgress: 5, closed: 46, abandoned: 1 },
        closedToday: null,
      }}
      decide={record('decide')}
      answer={async (ask, choice) => void writes.push(['answer', ask.id, choice])}
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
  </ProjectFrame>,
);
