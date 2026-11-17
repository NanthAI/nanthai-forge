// SPDX-License-Identifier: Apache-2.0
// Needs me as data (Items 9e748e41, 12fde646): the count is the top bar's held-Lane number, requests asked ahead are
// listed and never counted, a Lane's approval is drawn on its held row only, the longest hold comes first, and a
// reason Forge did not record is said as not reported, never guessed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

const { needsView, needsSentence, itemCounts, moving, whoOf } = await import(
  moduleUrl('../web/src/app/needs/model.ts')
);
const { heldCount } = await import(moduleUrl('../web/src/app/Line.tsx'));
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

test('the Needs you count is the held-Lane count the top bar shows; asked-ahead requests are not counted', () => {
  const lanes = [held('l1', 'check-failed', 30), held('l2', 'review', 10)];
  const view = needsView(read(lanes, [request('l2', 'lane'), request('setting:runner', 'setting')]));
  const feed = {
    lanes: lanes.map(lane => ({
      laneId: lane.laneId,
      stage: 'saved',
      held: true,
      overlap: false,
      changedAt: 1,
    })),
    more: 0,
    moreIsLowerBound: false,
    main: null,
    exit: null,
  };
  assert.equal(view.count, heldCount(feed));
  assert.equal(view.ahead.length, 1, 'only the request that holds no Lane is asked ahead');
  assert.equal(view.ahead[0].laneId, 'setting:runner');
  const withApproval = view.now.find(row => row.laneId === 'l2');
  assert.equal(withApproval.approval.laneId, 'l2', 'the Lane request is drawn on its held row, not twice');
  assert.match(needsSentence(view).bold, /^2 Lanes are held until you decide\.$/);
  assert.match(needsSentence(view).rest, /^1 request asked ahead holds nothing yet\.$/);
});

test('48049998: every hold that waits for the owner has a decision target; a request asked ahead keeps its own head', () => {
  const view = needsView(
    read(
      [
        held('policy', 'review', 10, { submissionId: 's1', attemptId: 'a1' }),
        held('asked', 'review', 20, { submissionId: 's2', attemptId: 'a2' }),
        held('conflict', 'conflict', 30, { submissionId: 's3' }),
      ],
      [
        request('asked', 'lane', { head: 'b'.repeat(64) }),
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
    { head: 'b'.repeat(64) },
    "a Lane's request decides its held landing too",
  );
  assert.equal(target('conflict'), null, 'nothing for the owner to approve');
  assert.equal(view.ahead[0].head, 'a'.repeat(64), 'the decision names the request head, never the row text');
  assert.equal(view.ahead[0].question, 'Run 8 checks at once.');
});

test('the longest hold comes first and each row is titled by its Item and reason', () => {
  const view = needsView(read([held('new', 'conflict', 300), held('old', 'check-failed', 100)], []));
  assert.deepEqual(
    view.now.map(row => row.laneId),
    ['old', 'new'],
  );
  assert.equal(view.now[0].word, 'Check failed');
  assert.match(view.now[0].head, /^Title old: its check failed\./);
  assert.equal(view.now[1].word, 'Conflict');
  assert.equal(view.now[0].who, 'sample-one/quiet-otter');
  assert.equal(whoOf('sample-one', null), '@sample-one');
  assert.equal(whoOf(null, 'quiet-otter'), null, 'no person is invented when the reader may not see people');
});

test('an unrecorded reason is not reported, never guessed; a waiting Lane request names it', () => {
  const unknown = needsView(read([held('l1', 'unknown', 1, { title: null })], []));
  assert.equal(unknown.now[0].head, 'Lane l1 is held. Why: not reported.');
  const review = needsView(read([held('l1', 'unknown', 1)], [request('l1', 'lane')]));
  assert.equal(review.now[0].why, 'review');
});

test('a count past the read limit reconciles with the rows shown', () => {
  const lanes = Array.from({ length: 30 }, (_, i) => held(`l${i}`, 'review', i));
  const view = needsView(read(lanes, [], 1, true));
  assert.equal(view.count, 31);
  assert.equal(view.atLeast, true);
  assert.equal(needsSentence(view).bold, 'At least 31 Lanes are held until you decide.');
  assert.equal(needsSentence(needsView(read([], []))).bold, 'Nothing needs you.');
});

test('incomplete approval coverage is reported, not read as none', () => {
  const view = needsView({ ...read([], []), approvals: JSON.stringify({ requests: [], complete: false }) });
  assert.equal(view.approvalsComplete, false);
});

test('standing counts Items: Left is planned work, proposed is its own fact, partial coverage says so', () => {
  const counts = itemCounts({
    counts: { closed: 5, 'in-progress': 2, open: 7, proposed: 3, abandoned: 1 },
    isDone: true,
  });
  assert.deepEqual(counts, { done: 5, inProgress: 2, left: 7, proposed: 3, complete: true });
  assert.equal(itemCounts({ counts: { open: 1 }, isDone: false }).complete, false);
  assert.equal(
    itemCounts({ counts: {}, isDone: true, coverage: 'partial-needs-preparation' }).complete,
    false,
  );
  assert.equal(itemCounts({ isDone: true }), null, 'no counts is not reported, never zero');
});

test('moving without you lists the line marks that are not held, by stop', () => {
  const lane = (laneId, stage, isHeld = false) => ({
    laneId,
    stage,
    held: isHeld,
    overlap: false,
    changedAt: 1,
  });
  const result = moving({
    lanes: [lane('a', 'checking'), lane('b', 'saved'), lane('c', 'saved'), lane('d', 'saved', true)],
    more: 0,
    moreIsLowerBound: false,
    main: null,
    exit: null,
  });
  assert.equal(result.total, 3);
  assert.equal(result.parts, '2 saved, 1 checking');
});
