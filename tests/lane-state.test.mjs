// SPDX-License-Identifier: Apache-2.0
// One Lane state on every screen (Items 29671737, 31328be4, d9e1ac62, d4b68402): the yard, the Lane page, Needs you,
// the queue rows and the public page all read a Lane's state from web/src/app/lane-state.ts over its CURRENT
// submission; the yard draws only once its reads are in; Lanes of one Item are grouped and a left-behind one says what
// replaced it; a Ready row behind another says what it waits on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { moduleUrl } from './convex-module.mjs';

const state = await import(moduleUrl('../web/src/app/lane-state.ts'));
const model = await import(moduleUrl('../web/src/app/lanes/model.ts'));
const needs = await import(moduleUrl('../web/src/app/needs/model.ts'));
const { landingStateField } = await import(moduleUrl('../src/landing-state.ts'));
const { QUIET_MS } = await import(moduleUrl('../src/lane-quiet.ts'));

const NOW = Date.parse('2026-11-17T14:20:00Z');
const iso = ms => new Date(ms).toISOString();
const mark = (laneId, stage, extra = {}) => ({
  laneId,
  stage,
  held: false,
  overlap: false,
  changedAt: NOW,
  ...extra,
});
const feed = lanes => ({ lanes, more: 0, moreIsLowerBound: false, main: null, exit: null });
const meta = (laneId, intentId, intent, lastSaveAt = iso(NOW)) => ({
  laneId,
  intentId,
  intent,
  actor: 'mara',
  lastSaveAt,
  landing: null,
});
/** A queue entry as projectHostedQueueView:read writes it: the state comes from the shared landing reading. */
const entry = (laneId, record, extra = {}) => ({
  position: null,
  laneId,
  submissionId: `s-${laneId}-${extra.submittedAt ?? ''}`,
  landingState: landingStateField(record),
  phase: record.phase ?? 'ready',
  lastFailingTests: [],
  recomposeCount: 0,
  submittedAt: iso(NOW - 60_000),
  lastProgressAt: iso(NOW - 60_000),
  ...(record.error ? { error: record.error.code } : {}),
  ...extra,
});
const heldForReview = {
  phase: 'ready',
  observation: { state: 'pending', pendingReason: 'waiting-for-review', cause: null },
  error: { code: 'REVIEW_REQUIRED', message: 'A person approves each landing.' },
};
const refused = {
  phase: 'terminal-failed',
  observation: { state: 'terminal-failed', pendingReason: null, cause: 'rejected' },
  error: { code: 'BAD_ARGUMENT', message: 'compact header omits planVisibility' },
};

test('29671737: a held-for-review submission whose record carries REVIEW_REQUIRED never reads as Check failed', () => {
  // The dogfood case: Lane 9e8e8826's current submission passed its check and waits for approval; the queue entry
  // carries error code REVIEW_REQUIRED, which the yard used to read as a failed check.
  const lanes = [mark('9e8e8826', 'ready', { held: true })];
  const queue = { total: 0, held: 1, listed: 1, more: false, entries: [entry('9e8e8826', heldForReview)] };
  const [row] = model.buildYard(feed(lanes), [meta('9e8e8826', 'i1', 'Public pages')], queue, NOW).rows;
  assert.equal(row.word, 'Needs you');
  assert.equal(row.state, 'waiting');
  assert.equal(row.why, 'waiting for approval');
});

test('29671737: after a refused submission and a passed, held resubmission, every screen says the same state', () => {
  const lanes = [mark('lane-a', 'ready', { held: true })];
  const queue = {
    total: 0,
    held: 2,
    listed: 2,
    more: false,
    // The newer, held entry is listed first: a last-wins map would pick the older refusal.
    entries: [
      entry('lane-a', heldForReview, { submittedAt: iso(NOW - 60_000) }),
      entry('lane-a', refused, { submittedAt: iso(NOW - 3_600_000) }),
    ],
  };
  const yardRow = model.buildYard(feed(lanes), [meta('lane-a', 'i1', 'Public pages')], queue, NOW).rows[0];
  const current = state.currentEntries(queue.entries).get('lane-a');
  assert.equal(current.landingState.state, 'held-review', 'the newest submission is the current one');
  // The queue row, the Lane page (mark only) and Needs you (its own hold reason) for the same Lane.
  const queueRow = state.queueEntryState(current, lanes[0]);
  const lanePage = state.laneState(lanes[0]);
  const needsRow = needs.needsView({
    held: [
      {
        laneId: 'lane-a',
        title: 'Public pages',
        actor: 'mara',
        agent: null,
        why: 'review',
        note: null,
        submissionId: null,
        since: NOW,
      },
    ],
    more: 0,
    moreIsLowerBound: false,
    approvals: '{"requests":[]}',
    canDecide: true,
  }).now[0];
  for (const said of [yardRow, queueRow, lanePage].map(x => ({
    stage: x.stage,
    held: x.held ?? true,
    kind: x.state ?? x.kind,
  })))
    assert.deepEqual(said, { stage: 'ready', held: true, kind: 'waiting' });
  assert.equal(queueRow.word, 'Needs you');
  assert.equal(yardRow.word, 'Needs you');
  assert.equal(needsRow.word, 'Needs you');
  // Friction e2f436b6: with the mark alone the Lane page knows the hold, not its reason or whom it waits on.
  assert.equal(lanePage.note, 'held', "the Lane page never guesses the hold is the reader's");
  assert.ok(
    ![yardRow.word, queueRow.word, needsRow.word].includes('Check failed'),
    'the refusal is history only',
  );
});

test('29671737: a queue entry still preparing, out of the order, is not a failed check', () => {
  const preparing = entry(
    'lane-p',
    { phase: 'composing', observation: { state: 'pending', pendingReason: 'queued' } },
    {
      phase: 'composing',
      waitingOn: { kind: 'source-preparation' },
    },
  );
  const said = state.queueEntryState(preparing, null);
  assert.equal(said.held, false);
  assert.notEqual(said.word, 'Check failed');
});

test('31328be4: the yard draws nothing until the feed, the Lane page and the queue have all answered', () => {
  const lanes = [mark('a3cd248a', 'checking', { overlap: true })];
  const f = feed(lanes);
  // A hard reload: the line feed arrives first.
  assert.equal(model.yardReady({ feed: f, lanes: undefined, queue: undefined }), false);
  assert.equal(model.yardReady({ feed: f, lanes: [], queue: undefined }), false);
  assert.equal(model.yardReady({ feed: undefined, lanes: [], queue: { entries: [] } }), false);
  // A failed sub-read still lets the yard draw (it then says what it could not read).
  assert.equal(
    model.yardReady({ feed: f, lanes: undefined, laneError: new Error('x'), queue: { entries: [] } }),
    true,
  );
  assert.equal(model.yardReady({ feed: f, lanes: [], queue: undefined, queueError: new Error('x') }), true);
  // Even drawn from the feed alone, a checking Lane with a saved-file overlap reads Checking, as with its queue entry.
  const alone = model.buildYard(f, [], undefined, NOW).rows[0];
  const full = model.buildYard(
    f,
    [meta('a3cd248a', 'i1', 'Public pages')],
    {
      total: 1,
      listed: 1,
      more: false,
      entries: [
        {
          ...entry('a3cd248a', {
            phase: 'checking',
            observation: { state: 'pending', pendingReason: 'checking' },
          }),
          position: 1,
          phase: 'checking',
        },
      ],
    },
    NOW,
  ).rows[0];
  assert.deepEqual([alone.word, alone.state], [full.word, full.state]);
  assert.equal(full.word, 'Checking');
});

test('31328be4: the public and member reads map the same Lane to the same stop, hold and colour', () => {
  // The public read carries each listed Lane's stage and hold (convex/publicRead.ts); members add the current submission.
  for (const [lane, current] of [
    [{ stage: 'ready', held: true }, heldForReview],
    [
      { stage: 'checking', held: false, overlap: true },
      { phase: 'checking', observation: { state: 'pending', pendingReason: 'checking' } },
    ],
    [{ stage: 'editing', held: false }, null],
  ]) {
    const visitor = state.laneState({ stage: lane.stage, held: lane.held });
    const member = state.laneState(
      lane,
      current ? state.landingOf({ landingState: landingStateField(current) }) : null,
    );
    assert.deepEqual(
      { stage: visitor.stage, held: visitor.held },
      { stage: member.stage, held: member.held },
    );
    if (!lane.overlap) assert.equal(visitor.kind, member.kind, `${lane.stage}: one colour for one state`);
  }
});

test('d9e1ac62: open Lanes of one Item are grouped, carry a short mark, and a left-behind one says what replaced it', () => {
  const lanes = [
    mark('9e8e8826', 'ready', { held: true, changedAt: NOW - 30 * 60_000 }),
    mark('a3cd248a', 'saved', { changedAt: NOW - 5 * 3_600_000 }),
    mark('c13ef400', 'saved', { changedAt: NOW - 5 * 3_600_000 }),
    mark('busy0001', 'editing', { changedAt: NOW - 60_000 }),
  ];
  const quiet = iso(NOW - QUIET_MS - 60_000);
  const yard = model.buildYard(
    feed(lanes),
    [
      meta('9e8e8826', 'pages', 'Public pages'),
      meta('a3cd248a', 'pages', 'Public pages', quiet),
      meta('c13ef400', 'pages', 'Public pages', quiet),
      meta('busy0001', 'other', 'Something else'),
    ],
    { total: 0, held: 1, listed: 1, more: false, entries: [entry('9e8e8826', heldForReview)] },
    NOW,
  );
  const of = id => yard.rows.find(row => row.laneId === id);
  assert.equal(of('9e8e8826').lanes, 3, '"3 Lanes" for the Item');
  assert.equal(of('9e8e8826').mark, '9e8e8826');
  assert.notEqual(of('a3cd248a').mark, of('c13ef400').mark, 'two rows of one Item never look the same');
  assert.equal(of('a3cd248a').replacedBy, '9e8e8826');
  assert.equal(of('a3cd248a').why, 'replaced by 9e8e8826');
  assert.equal(of('9e8e8826').replacedBy, null);
  assert.equal(of('busy0001').lanes, 1);
  // In the work band the replaced Lanes sort below the live work.
  const work = yard.rows.filter(row => row.band === 'work').map(row => row.laneId);
  assert.deepEqual(work, ['busy0001', 'a3cd248a', 'c13ef400']);
});

test('d9e1ac62: Lanes of one Item sit together in a band, live first; nothing is called replaced while all are busy', () => {
  const lanes = [
    mark('x-new', 'saved', { changedAt: NOW - 1_000 }),
    mark('y-other', 'saved', { changedAt: NOW - 2_000 }),
    mark('x-old', 'saved', { changedAt: NOW - 3_000 }),
  ];
  const yard = model.buildYard(
    feed(lanes),
    [meta('x-new', 'x', 'X'), meta('y-other', 'y', 'Y'), meta('x-old', 'x', 'X', iso(NOW - 20 * 60_000))],
    { total: 0, listed: 0, more: false, entries: [] },
    NOW,
  );
  assert.deepEqual(
    yard.rows.map(row => row.laneId),
    ['x-new', 'x-old', 'y-other'],
  );
  assert.ok(
    yard.rows.every(row => row.replacedBy === null),
    'a Lane saved 20 minutes ago is not left behind',
  );
  assert.deepEqual(state.laneState({ stage: 'saved', held: false }).word, 'Saved');
});

test('d9e1ac62 (real case, Item 1dd4e095): an open resolution Lane replaces the Lane it resolves even when both are quiet', () => {
  // ac26ac6f conflicted; c908b679 is its resolution Lane. Both have been quiet for hours, so the quiet rule alone named
  // no replacement and the two rows read the same.
  const lanes = [
    mark('ac26ac6f', 'saved', { changedAt: NOW - 25 * 3_600_000 }),
    mark('c908b679', 'saved', { changedAt: NOW - 21 * 3_600_000 }),
    mark('busy0001', 'editing', { changedAt: NOW - 60_000 }),
  ];
  const yard = model.buildYard(
    feed(lanes),
    [
      meta('ac26ac6f', 'browser', 'Landing check: browser tests', iso(NOW - 25 * 3_600_000)),
      {
        ...meta('c908b679', 'browser', 'Landing check: browser tests', iso(NOW - 21 * 3_600_000)),
        resolves: 'ac26ac6f',
      },
      meta('busy0001', 'other', 'Something else'),
    ],
    { total: 0, listed: 0, more: false, entries: [] },
    NOW,
  );
  const of = id => yard.rows.find(row => row.laneId === id);
  assert.equal(of('ac26ac6f').replacedBy, 'c908b679');
  assert.equal(of('ac26ac6f').why, 'replaced by c908b679');
  assert.equal(of('c908b679').replacedBy, null, 'the resolution Lane is the live one of the pair');
  const order = yard.rows.map(row => row.laneId);
  assert.ok(
    order.indexOf('ac26ac6f') > order.indexOf('c908b679'),
    'the replaced Lane sorts below its resolution',
  );
});

test('d9e1ac62: a resolution never replaces a Lane whose landing is in flight, and a replaced Lane stands in for none', () => {
  const now = NOW;
  const quiet = now - QUIET_MS - 60_000;
  const sib = (laneId, extra = {}) => ({ laneId, intentId: 'i', lastAt: quiet, inFlight: false, ...extra });
  // The origin is checking: it keeps its own row (and the quiet resolution beside it is the one left behind).
  const landing = model.replacedBy(
    [sib('origin', { inFlight: true }), sib('res', { resolves: 'origin' })],
    now,
  );
  assert.deepEqual([...landing], [['res', 'origin']]);
  // The origin was saved again just now, its resolution is quiet: the origin is still the replaced one, never both.
  const both = model.replacedBy([sib('origin', { lastAt: now }), sib('res', { resolves: 'origin' })], now);
  assert.deepEqual([...both], [['origin', 'res']]);
});

test('e2f436b6: the Lane page says "for you" only when Needs me says the hold waits on the reader', () => {
  const lane = (laneId, why, since) => ({
    laneId,
    intentId: 'i',
    title: 'Landing check',
    actor: 'mara',
    agent: 'quiet-otter',
    why,
    note: null,
    submissionId: null,
    since,
  });
  const read = canDecide => ({
    held: [
      lane('review-1', 'review', NOW - 30 * 60_000),
      lane('failed-1', 'check-failed', NOW - 21 * 3_600_000),
    ],
    more: 0,
    moreIsLowerBound: false,
    approvals: '{"requests":[]}',
    canDecide,
  });
  const owner = needs.needsView(read(true));
  assert.equal(needs.holdLine(owner, 'review-1', NOW), 'Held for your approval (30 min).');
  // The real case: another's hold (a failed check the agent fixes) never reads as the owner's.
  assert.equal(
    needs.holdLine(owner, 'failed-1', NOW),
    'Held (21 h): its check failed. Next: mara/quiet-otter fixes it in the same Lane.',
  );
  // A member who cannot decide sees the approval as someone else's.
  assert.match(
    needs.holdLine(needs.needsView(read(false)), 'review-1', NOW),
    /^Held \(30 min\): waiting for approval\./,
  );
  // Before the read answers, or past its limit: no guess at whom it waits on.
  assert.equal(needs.holdLine(undefined, 'review-1', NOW), 'Held.');
  assert.equal(needs.holdLine(owner, 'not-listed', NOW), 'Held.');
  assert.equal(
    needs.holdLine(
      needs.needsView({ ...read(true), held: [lane('u', 'unknown', NOW - 60 * 60_000)] }),
      'u',
      NOW,
    ),
    'Held (1 h): no landing outcome on record. Next: mara/quiet-otter lands it again from the Lane.',
  );
});

// A check-failed sibling is the agent's to fix and goes to FYI (48049998), so both rows here wait on the person.
test('d9e1ac62: Needs you rows of one Item carry their Lane mark and the Item count', () => {
  const view = needs.needsView({
    held: [
      {
        laneId: 'aaaa1111-x',
        intentId: 'i',
        title: 'Same title',
        actor: 'm',
        agent: null,
        why: 'review',
        note: null,
        submissionId: null,
        since: 1,
      },
      {
        laneId: 'bbbb2222-x',
        intentId: 'i',
        title: 'Same title',
        actor: 'm',
        agent: null,
        why: 'review',
        note: null,
        submissionId: null,
        since: 2,
      },
    ],
    more: 0,
    moreIsLowerBound: false,
    approvals: '{"requests":[]}',
    canDecide: true,
  });
  assert.deepEqual(
    view.now.map(row => [row.mark, row.siblings, row.word]),
    [
      ['aaaa1111', 2, 'Needs you'],
      ['bbbb2222', 2, 'Needs you'],
    ],
  );
});

const queued = (laneId, position, phase, extra = {}) => ({
  ...entry(laneId, {
    phase,
    observation: { state: 'pending', pendingReason: phase === 'checking' ? 'checking' : 'queued' },
  }),
  position,
  phase,
  ...extra,
});

test('d4b68402: a Ready row behind a checking one says what it waits on', () => {
  const lanes = [mark('first', 'checking'), mark('second', 'ready')];
  const queue = {
    total: 2,
    listed: 2,
    more: false,
    entries: [
      queued('first', 1, 'checking'),
      queued('second', 2, 'ready', { lastProgressAt: iso(NOW - 2 * 60_000) }),
    ],
  };
  const yard = model.buildYard(feed(lanes), [meta('first', 'a', 'A'), meta('second', 'b', 'B')], queue, NOW);
  const second = yard.rows.find(row => row.laneId === 'second');
  assert.equal(second.word, 'Waiting its turn');
  assert.equal(second.why, 'waits for #1: its check is running');
  assert.equal(second.longWait, false);
});

test('d4b68402: a Ready row behind a recomposing one names the restarts, and says when the wait is long', () => {
  const lanes = [mark('first', 'checking'), mark('second', 'ready')];
  const queue = {
    total: 2,
    listed: 2,
    more: false,
    entries: [
      queued('first', 1, 'checking', { recomposeCount: 3 }),
      queued('second', 2, 'ready', { lastProgressAt: iso(NOW - state.USUAL_CHECK_MS - 60_000) }),
    ],
  };
  const yard = model.buildYard(feed(lanes), [meta('first', 'a', 'A'), meta('second', 'b', 'B')], queue, NOW);
  const second = yard.rows.find(row => row.laneId === 'second');
  assert.equal(second.why, 'waits for #1: its check restarted 3 times because main moved');
  assert.equal(second.longWait, true);
  assert.equal(second.detail, 'longer than a usual check');
  // Who waits on whom gives the same reason.
  const [wait] = model.waits(queue.entries, id => id.toUpperCase());
  assert.deepEqual([wait.on, wait.why], ['FIRST', 'its check restarted 3 times because main moved']);
});

test('d4b68402: the usual check time is the check-p50 speed budget', () => {
  const budgets = JSON.parse(readFileSync(new URL('../src/speed-budgets.json', import.meta.url), 'utf8'));
  const p50 = (budgets.budgets ?? budgets).find(budget => budget.id === 'check-p50');
  assert.equal(p50.unit, 'min');
  assert.equal(state.USUAL_CHECK_MS, p50.max * 60_000);
});

/** Core-claim incident 43b51a5e: a passed entry parked behind an older submission read "being accepted
 * into main". Every reader that holds the order wait says it waits, and for whom: CLI land and wait
 * replies, the compact wait line and the web queue row. */
test('43b51a5e: a parked passed entry reads waiting-for-order on CLI replies, the wait line and the queue row', async () => {
  const { withFinishLandingState } = await import(moduleUrl('../src/hosted-agent-finish-result.ts'));
  const { waitEventLine } = await import(moduleUrl('../src/hosted-wait-line.ts'));
  const older = '190baa00-9c92-429d-8d69-b6fee834155e';
  const submission = { phase: 'ready', observation: { state: 'pending', pendingReason: null, cause: null } };
  const orderWait = {
    submissionId: older,
    message: `Check passed; waiting for older submission ${older} to take main first (submission order).`,
  };
  const field = landingStateField({ ...submission, orderWait });
  assert.equal(field.state, 'waiting-for-order');
  assert.equal(field.nextStep, orderWait.message);
  assert.equal(landingStateField(submission).state, 'landing', 'without a wait it is being accepted');
  assert.equal(
    landingStateField({ ...submission, phase: 'checking', orderWait }).state,
    'queued',
    'only a Ready entry waits for order',
  );
  const reply = withFinishLandingState({}, { submission, orderWait });
  assert.equal(reply.landingState.state, 'waiting-for-order');
  assert.doesNotMatch(reply.landingState.nextStep, /being accepted/);
  const line = waitEventLine({ type: 'submission', operationId: 'op', submission, orderWait });
  assert.equal(line.line.landingState, 'waiting-for-order');
  assert.equal(line.line.waitingFor, older);
  const row = state.queueEntryState({ phase: 'ready', landingState: field }, null);
  assert.equal(row.stage, 'ready');
  assert.equal(row.held, false, 'waiting for order is not a hold');
  assert.equal(row.why, 'waits for an older landing');
  assert.equal(
    state.queueEntryState({ phase: 'ready', landingState: landingStateField(submission) }).why,
    'lands next',
  );
});

test('9b9057a9: a Lane that only shares saved files with another is never Conflict; a held conflict and a landing conflict are', () => {
  // The owner saw purple Conflict on Lanes that had not landed: saved files shared, or a trial-merge flag, no landing
  // that ended in conflict. One rule (isConflict) now decides, for Lanes, the Flow view and the top bar's F.
  for (const stage of ['editing', 'saved', 'queued', 'checking', 'ready']) {
    const shared = { stage, held: false, overlap: true };
    assert.equal(state.isConflict(shared), false, stage);
    assert.notEqual(state.laneState(shared, null).kind, 'conflict', stage);
  }
  const queued = state.laneState(mark('q2', 'queued'));
  assert.deepEqual([queued.kind, queued.why], ['waiting', 'waits for its check']);
  // A held Lane is in conflict when its landing says so; with no landing in hand, when its exact conflict is flagged.
  const held = { stage: 'saved', held: true, overlap: true };
  assert.equal(state.isConflict(held, { state: 'conflict' }), true);
  assert.equal(state.isConflict(held, null), true, 'feed-only readers keep the held conflict');
  assert.equal(
    state.isConflict(held, { state: 'check-failed' }),
    false,
    'its landing says why, not the flag',
  );
  assert.equal(state.isConflict({ ...held, overlap: false }, { state: 'conflict' }), true);
  assert.equal(state.laneState(held, { state: 'conflict' }).kind, 'conflict');
});

test("9b9057a9: only a landing held for review says Needs you; every other hold is its agent's, in its own word", () => {
  for (const [landing, word] of [
    [{ state: 'held-review' }, 'Needs you'],
    [{ state: 'stale-head' }, 'Stopped'],
    [{ state: 'rejected' }, 'Stopped'],
    [{ state: 'unknown' }, 'Stopped'],
    [null, 'Waiting its turn'],
  ]) {
    const said = state.laneState({ stage: 'saved', held: true }, landing);
    assert.equal(said.glyph, word, landing?.state ?? 'no landing');
    assert.doesNotMatch(said.why, /why not reported/);
  }
});
