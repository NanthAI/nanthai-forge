// SPDX-License-Identifier: Apache-2.0
// Needs me as data (Items 9e748e41, 12fde646, 48049998): Needs you holds only what a person can act on and its count is
// the shell's (needs/count.ts); an agent's conflict and a refusal are FYI rows naming who acts next; a protected-path
// approval stays in Needs you; requests asked ahead are listed and never counted; a Lane's approval is drawn on its
// held row only; the longest hold comes first; a reason Forge did not record is said as not reported, never guessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { needsView, needsSentence, whoOf, parkLine } = await import(
  moduleUrl('../web/src/app/needs/model.ts')
);
const countModule = await import(moduleUrl('../web/src/app/needs/count.ts'));
const { needsCount } = countModule;
const { decideTarget } = await import(moduleUrl('../web/src/app/needs/decide.ts'));

const held = (laneId, why, since, extra = {}) => ({
  laneId,
  title: `Title ${laneId}`,
  actor: 'sample-one',
  agent: 'quiet-otter',
  why,
  note: null,
  submissionId: null,
  since,
  ...extra,
});
const request = (laneId, kind, extra = {}) => ({
  laneId,
  kind,
  needsOwner: true,
  label: `${kind} request`,
  nextStep: 'Decide in Forge.',
  head: 'a'.repeat(64),
  at: '2026-11-16T10:00:00.000Z',
  ...extra,
});
const read = (lanes, requests, more = 0, moreIsLowerBound = false) => ({
  held: lanes,
  more,
  moreIsLowerBound,
  approvals: JSON.stringify({ requests, complete: true }),
  canDecide: true,
});

test('the shell count is the page count: what waits on a person, never what asks nobody or is asked ahead', () => {
  const lanes = [held('l1', 'check-failed', 30), held('l2', 'review', 10)];
  const input = read(lanes, [request('l2', 'lane'), request('setting:runner', 'setting')]);
  const view = needsView(input);
  assert.deepEqual(needsCount(input), { n: view.count, atLeast: false });
  assert.equal(view.count, 1, "an agent's failed check is its agent's to fix");
  assert.deepEqual(
    view.fyi.map(row => row.laneId),
    ['l1'],
  );
  assert.equal(view.ahead.length, 1, 'only the request that holds no Lane is asked ahead');
  assert.equal(view.ahead[0].laneId, 'setting:runner');
  const withApproval = view.now.find(row => row.laneId === 'l2');
  assert.equal(withApproval.approval.laneId, 'l2', 'the Lane request is drawn on its held row, not twice');
  assert.match(needsSentence(view).bold, /^1 thing holds work until you decide\.$/);
  assert.match(needsSentence(view).rest, /^1 request asked ahead holds nothing yet\.$/);
});

test('48049998: every hold that waits for the owner has a decision target; a request asked ahead keeps its own head', () => {
  const view = needsView(
    read(
      [
        held('policy', 'review', 10, { submissionId: 's1', attemptId: 'a1' }),
        held('asked', 'review', 20, { submissionId: 's2', attemptId: 'a2' }),
        held('conflict', 'conflict', 30, { submissionId: 's3' }),
        held('request-only', 'unknown', 40),
      ],
      [
        request('asked', 'lane', { head: 'b'.repeat(64) }),
        request('request-only', 'lane', { head: 'c'.repeat(64) }),
        request('setting:runner', 'setting', { reason: 'Run 8 checks at once.' }),
      ],
    ),
  );
  const target = laneId => decideTarget(view.now.find(row => row.laneId === laneId));
  assert.deepEqual(
    target('policy'),
    { landing: { submissionId: 's1', attemptId: 'a1' } },
    'a landing-policy hold',
  );
  assert.deepEqual(
    target('asked'),
    { landing: { submissionId: 's2', attemptId: 'a2' } },
    'the exact submission stays the decision target when its Lane also has a request',
  );
  assert.deepEqual(
    target('request-only'),
    { head: 'c'.repeat(64) },
    'a standalone Lane request still names its own head',
  );
  assert.equal(
    decideTarget(view.fyi.find(row => row.laneId === 'conflict')),
    null,
    'nothing for the owner to approve',
  );
  assert.equal(view.ahead[0].head, 'a'.repeat(64), 'the decision names the request head, never the row text');
  assert.equal(view.ahead[0].question, 'Run 8 checks at once.');
});

test("an agent's conflict and a refusal go to FYI naming the agent's next step; a protected-path approval stays", () => {
  const input = read(
    [
      held('conflict', 'conflict', 10),
      held('refused', 'rejected', 20, { agent: null }),
      held('protected', 'unknown', 30),
    ],
    [request('protected', 'lane', { reason: 'Changes .github/workflows/ci.yml (protected path)' })],
  );
  const view = needsView(input);
  assert.deepEqual(
    view.now.map(row => [row.laneId, row.why]),
    [['protected', 'review']],
    'the approval holds the landing, whoever started it',
  );
  assert.deepEqual(
    view.fyi.map(row => [row.laneId, row.head, row.next]),
    [
      [
        'conflict',
        'Title conflict conflicts with another change.',
        'sample-one/quiet-otter updates it from main and lands again',
      ],
      ['refused', 'Forge refused the landing of Title refused.', '@sample-one reads why and lands again'],
    ],
  );
  assert.equal(needsCount(input).n, 1);
});

test("Needs you holds only what the reader decides: a person's own stuck Lane is FYI; a question is counted", () => {
  const input = {
    ...read([held('mine', 'check-failed', 5, { agent: null }), held('ask', 'review', 9)], []),
    asks: [
      {
        id: 'q1',
        at: 3,
        actor: 'cloud-agent',
        agent: 'amber-fox',
        text: 'Which lands first?',
        choices: ['Mine', 'Theirs'],
        laneId: 'mine',
      },
    ],
  };
  const view = needsView(input);
  assert.deepEqual(
    view.now.map(row => row.laneId),
    ['ask'],
    "owner dogfood 2026-11-17: nothing on a failed check is the reader's to decide here",
  );
  assert.deepEqual(
    view.fyi.map(row => [row.laneId, row.next]),
    [['mine', '@sample-one fixes it in the same Lane']],
  );
  assert.deepEqual(
    view.asks.map(row => [row.id, row.who]),
    [['q1', 'cloud-agent/amber-fox']],
  );
  assert.equal(view.count, 2);
  assert.deepEqual(needsCount(input), { n: 2, atLeast: false });
  assert.equal(needsSentence(view).bold, '2 things hold work until you decide.');

  const reader = { ...input, canDecide: false };
  assert.deepEqual(needsView(reader).now, [], 'a review hold waits on the owner, not on a reader');
  assert.match(
    needsView(reader).fyi.find(row => row.laneId === 'ask').next,
    /the project owner approves or declines it/,
  );
  assert.deepEqual(
    needsCount(reader),
    { n: 1, atLeast: false },
    'the shell counts the same rule for the same reader',
  );
});

test('the longest hold comes first; FYI says the real cause; a bare id is never a title', () => {
  const view = needsView(
    read(
      [
        held('new', 'review', 300),
        held('old', 'review', 100),
        held('9f4ff056-050a-4fac-8552-950ef37feaa2', 'check-failed', 200, {
          title: '9f4ff056-050a-4fac-8552-950ef37feaa2',
        }),
      ],
      [],
    ),
  );
  assert.deepEqual(
    view.now.map(row => row.laneId),
    ['old', 'new'],
  );
  const failed = view.fyi[0];
  assert.equal(failed.word, 'Check failed');
  assert.equal(failed.head, 'Lane 9f4ff056: its check failed.', 'the Lane mark, never the raw goal id');
  assert.equal(view.now[0].who, 'sample-one/quiet-otter');
  assert.equal(whoOf('sample-one', 'quiet-otter'), 'sample-one/quiet-otter');
  assert.equal(whoOf(null, 'quiet-otter'), null, 'no person is invented when the reader may not see people');
});

test('an unrecorded reason is not reported, never guessed; a waiting Lane request names it', () => {
  const unknown = needsView(read([held('l1', 'unknown', 1, { title: null, agent: null })], []));
  assert.equal(unknown.fyi[0].head, 'Lane l1 is held. Why: not reported.');
  assert.match(unknown.fyi[0].next, /Forge did not record what it waits on/);
  const review = needsView(read([held('l1', 'unknown', 1)], [request('l1', 'lane')]));
  assert.equal(review.now[0].why, 'review');
});

test('a count past the read limit reconciles with the rows shown', () => {
  const lanes = Array.from({ length: 30 }, (_, i) => held(`l${i}`, 'review', i));
  const view = needsView(read(lanes, [], 1, true));
  assert.equal(view.count, 30);
  assert.equal(view.atLeast, true);
  assert.equal(needsSentence(view).bold, 'At least 30 things hold work until you decide.');
  assert.equal(needsSentence(needsView(read([], []))).bold, 'Nothing needs you.');
});

test('incomplete approval coverage is reported, not read as none', () => {
  const view = needsView({ ...read([], []), approvals: JSON.stringify({ requests: [], complete: false }) });
  assert.equal(view.approvalsComplete, false);
});

test('one progress definition (3fa3187d): Done is all closed Issues, Left is planned plus proposed (d3357f40), capped figures read N+', async () => {
  const { progressOf, progressCells } = await import(moduleUrl('../web/src/app/progress.ts'));
  const issue = { closed: 579, inProgress: 57, open: 237, proposed: 8, abandoned: 4 };
  const now = Date.parse('2026-11-17T15:00:00Z');
  const exact = progressOf({ exact: true, issue, closedToday: { day: '2026-11-17', n: 12 } }, now);
  assert.deepEqual(exact, { done: 579, inProgress: 57, left: 245, proposed: 8, today: 12, atLeast: false });
  const cells = progressCells(exact, { inProgress: '3 Lanes open' });
  assert.deepEqual(
    [cells.done.n, cells.done.more, cells.done.atLeast, cells.left.more, cells.inProgress.more],
    [579, '12 today', false, undefined, '3 Lanes open'],
  );
  assert.equal(progressOf({ exact: true, issue, closedToday: { day: '2026-11-16', n: 9 } }, now).today, 0);
  const capped = progressCells(progressOf({ exact: false, issue, closedToday: null }, now));
  assert.deepEqual(
    [capped.done.atLeast, capped.inProgress.atLeast, capped.left.atLeast, capped.done.more, capped.left.more],
    [true, true, true, undefined, undefined],
  );
  assert.equal(
    capped.left.n,
    245,
    'Left counts the proposals too, so the strip and the headline share one number',
  );
  assert.equal(
    progressCells(exact, { left: 'next: X' }).left.more,
    'next: X',
    "only the page's own hint rides beside Left",
  );
  assert.equal(progressOf(undefined), null, 'no read is loading, never zero');
});

test('0cb9b064: a landing its agent withdrew is FYI, labelled withdrawn, and never counted in Needs you', () => {
  const view = needsView(read([held('l1', 'withdrawn', 30), held('l2', 'review', 10)], []));
  assert.deepEqual(
    view.now.map(row => row.laneId),
    ['l2'],
  );
  assert.equal(view.count, 1);
  assert.equal(view.fyi.length, 1);
  const [fyi] = view.fyi;
  assert.deepEqual(
    [fyi.word, fyi.tag, fyi.next],
    ['Set aside', 'Withdrawn', 'sample-one/quiet-otter lands again when ready'],
    'FYI names who acts next',
  );
  assert.match(fyi.head, /: its agent withdrew the landing\.$/);
  assert.doesNotMatch(fyi.head, /refused/i);
  assert.equal(needsSentence(needsView(read([held('l1', 'withdrawn', 30)], []))).bold, 'Nothing needs you.');
});

// Item e1633718, owner decision ead78765: a named holder sees a parked Lane at once; with no one named, the starter
// sees it once it has had no activity for 4 h, marked "parked, no one named". The page decides by the time its read
// arrived, so the shell count and the page agree and nothing ticks.
test('e1633718: a Lane parked for the reader counts at once; one parked with no one named only after 4 h idle', () => {
  const { PARK_UNNAMED_AFTER_MS } = countModule;
  const parked = (laneId, park, at) => ({
    laneId,
    intentId: `i-${laneId}`,
    title: `Title ${laneId}`,
    actor: 'sample-one',
    agent: 'quiet-otter',
    park,
    at,
  });
  const named = parked(
    'p1',
    { to: 'sample-one', named: true, reason: 'Bench window', at: 50, by: 'sample-lead/brisk-heron' },
    50,
  );
  const unnamed = parked(
    'p2',
    { named: false, reason: 'Until the lead decides', at: 100, by: 'sample-one' },
    100,
  );
  const input = { ...read([], []), parked: [named, unnamed] };
  const early = 100 + PARK_UNNAMED_AFTER_MS - 1;
  const soon = needsView(input, early);
  assert.deepEqual(
    soon.parked.map(row => row.laneId),
    ['p1'],
    'unnamed waits for 4 h of no activity',
  );
  assert.equal(soon.parked[0].head, 'Title p1 is parked for you.');
  assert.equal(soon.parked[0].who, 'sample-lead/brisk-heron', 'who parked it');
  assert.deepEqual(needsCount(input, early), { n: 1, atLeast: false }, 'the shell count agrees');
  const late = needsView(input, 100 + PARK_UNNAMED_AFTER_MS);
  assert.deepEqual(
    late.parked.map(row => row.laneId),
    ['p1', 'p2'],
  );
  assert.equal(late.parked[1].head, 'Title p2 is parked, no one named.');
  assert.equal(late.parked[1].tag, 'Parked, no one named');
  assert.equal(
    late.parked[1].who,
    'sample-one',
    'the park names the recorded person, even on a Lane held by an agent',
  );
  assert.equal(late.count, 2);
  assert.match(needsSentence(late).bold, /^2 things hold work until you decide\.$/);
  assert.deepEqual(needsCount(input, 100 + PARK_UNNAMED_AFTER_MS), { n: 2, atLeast: false });
  const run = needsView(
    { ...input, parked: [parked('p3', { ...named.park, to: 'sample-one/quiet-otter' }, 50)] },
    60,
  );
  assert.equal(run.parked[0].head, 'Title p3 is parked for your agent run quiet-otter.');
});

test('e1633718: the Lane page says who a parked Lane waits on, how long, and why', () => {
  const at = 0;
  assert.equal(
    parkLine(
      { to: 'sample-lead', named: true, reason: 'Waits for the  bench window.', at, by: 'x' },
      90 * 60_000,
    ),
    'Parked for @sample-lead (1 h 30 min): Waits for the bench window.',
  );
  assert.equal(
    parkLine({ named: false, reason: 'Until the lead decides.', at, by: 'x' }, 5 * 60_000),
    'Parked, no one named (5 min): Until the lead decides.',
  );
});

test('a Lane held for a dependency names the Lane it lands after when the read names it (9e748e41)', () => {
  const view = needsView({
    held: [
      held('d1', 'dependency', 1, { dependsOn: { laneId: 'p1-lane-0000', title: 'Parent work' } }),
      held('d2', 'dependency', 2, {
        dependsOn: { laneId: 'abcdef12-0000-4000-8000-000000000000', title: null },
      }),
      held('d3', 'dependency', 3),
    ],
    more: 0,
    moreIsLowerBound: false,
    approvals: '{"requests":[]}',
    canDecide: true,
  });
  assert.equal(view.count, 0, 'a dependency asks nobody');
  assert.deepEqual(
    view.fyi.map(row => [row.head, row.next]),
    [
      ['Title d1 waits for Parent work to land.', 'it lands after Parent work'],
      ['Title d2 waits for Lane abcdef12 to land.', 'it lands after Lane abcdef12'],
      ['Title d3 waits for the Lane it depends on.', 'it lands after the Lane it depends on'],
    ],
  );
});

test('questions asked ahead are listed separately and a hand-back counts in both Needs you views', () => {
  const base = {
    id: 'open',
    at: 3,
    actor: 'sample-one',
    agent: 'amber-fox',
    text: 'Which endpoint?',
    choices: ['A', 'B'],
    laneId: 'lane',
  };
  const input = {
    ...read([], []),
    asks: [
      base,
      { ...base, id: 'ahead', ahead: true },
      {
        ...base,
        id: 'hand-back',
        choices: ['Decline'],
        handBack: { head: 'save', left: 'Decide', to: 'owner' },
      },
    ],
  };
  const view = needsView(input);
  assert.deepEqual(
    view.asks.map(row => row.id),
    ['open', 'hand-back'],
  );
  assert.deepEqual(
    view.askedAhead.map(row => row.id),
    ['ahead'],
  );
  assert.equal(view.count, needsCount(input).n);
  assert.equal(view.count, 2);
});

test('a capped Needs you read with no visible asks reports incomplete coverage', () => {
  const view = needsView({ ...read([], []), asksMore: true });
  assert.equal(view.atLeast, true);
  assert.equal(view.count, 0);
  assert.equal(needsSentence(view).bold, 'Some requests could not be listed.');
});

test('4f1f7984: Asked ahead lists only requests that still wait for the owner; a granted or declined one is not listed', () => {
  const waiting = request('lane-asked', 'lane', { state: 'requested' });
  const granted = request('lane-granted', 'lane', {
    state: 'granted',
    needsOwner: false,
    label: 'Lane approval granted',
    nextStep: 'Nothing to do; the Lane can land.',
  });
  const declined = request('lane-declined', 'lane', { state: 'declined', needsOwner: false });
  const view = needsView(read([], [granted, waiting, declined]));
  assert.deepEqual(
    view.ahead.map(row => row.laneId),
    ['lane-asked'],
  );
  assert.match(needsSentence(view).rest, /^1 request asked ahead holds nothing yet\.$/);
  const none = needsView(read([], [granted, declined]));
  assert.equal(none.ahead.length, 0);
  assert.equal(needsSentence(none).bold, 'Nothing needs you.');
  assert.doesNotMatch(needsSentence(none).rest, /asked ahead/);
});
