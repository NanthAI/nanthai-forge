// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Why main failed, on the server (Item ae068e0c): projectMainRed:read answers one red by its audit event's sequence
// with the landings since the last pass, the culprit only when the bisect named one (else every landing is a
// candidate), and how it ended: still red with the live reason, recovered by the revert of the culprit, or counted as
// flaky. The read stays bounded however long the project's history is, and the FYI row names the same culprit from
// the events it already reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lanesFixture } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const red = await import(moduleUrl('../convex/projectMainRed.ts'));
const fyi = await import(moduleUrl('../convex/projectNeedsFyi.ts'));

const T0 = Date.UTC(2026, 10, 20, 9);
const at = minutes => new Date(T0 + minutes * 60_000).toISOString();

function fixture() {
  const s = lanesFixture();
  const projectId = s.insert('hostedProjects', {
    key: 'synthetic',
    name: 'Synthetic',
    currentBackup: null,
    revision: 0,
    owner: 'owner',
    visibility: 'public',
    sourceAuthority: { mode: 'server', epoch: 1 },
  });
  const receipts = new Map();
  const accept = (sequence, message, { revertOf } = {}) => {
    const id = randomUUID();
    const submissionId = randomUUID();
    s.insert('projectHostedAcceptances', {
      projectId,
      receiptId: id,
      submissionId,
      attemptId: randomUUID(),
      sequence,
      value: JSON.stringify({ id, at: at(sequence), message, actor: { id: 'sample-one', kind: 'agent' } }),
    });
    if (revertOf)
      s.insert('projectHostedLandingRequests', {
        projectId,
        channel: 'main',
        submissionId,
        operationId: randomUUID(),
        actor: 'owner',
        sequence,
        runnable: false,
        phase: 'landed',
        runId: null,
        attemptId: randomUUID(),
        value: JSON.stringify({ request: { revertOf } }),
      });
    receipts.set(sequence, id);
    return id;
  };
  const event = (kind, sequence, minute, extra = {}) =>
    s.insert('projectHostedMainAuditEvents', {
      projectId,
      kind,
      at: at(minute),
      head: `${kind[0]}${String(sequence).padStart(63, '0')}`,
      runId: `${kind}-run-${sequence}-${minute}`,
      sequence,
      ...extra,
    });
  const read = sequence =>
    s
      .call('mainRedRead', red.read, { projectId, ...(sequence === undefined ? {} : { sequence }) }, 'owner')
      .then(JSON.parse);
  return { s, projectId, accept, event, read, receipts };
}

test('a red the bisect solved names its culprit, and the revert of it is how it ended', async () => {
  const f = fixture();
  f.accept(1, 'Docs: tidy');
  f.event('green', 1, 1);
  const culprit = f.accept(2, 'Parser: stream chunks\n\nbody');
  f.accept(3, 'Types: narrow ReadResult');
  f.event('red', 3, 4);
  f.event('culprit', 2, 6, { culprit });
  const revert = f.accept(4, 'Revert “Parser: stream chunks”', { revertOf: culprit });
  f.event('green', 4, 9, { reverted: true });
  const view = await f.read(3);
  assert.equal(view.red.sequence, 3);
  assert.deepEqual(
    view.landings.map(row => row.title),
    ['Types: narrow ReadResult', 'Parser: stream chunks'],
    'the landings since the last pass, newest first',
  );
  assert.equal(view.lastGreen.sequence, 1);
  assert.equal(view.culprit.receiptId, culprit);
  assert.equal(view.culprit.landing.title, 'Parser: stream chunks');
  assert.equal(view.end.how, 'recovered');
  assert.equal(view.end.reverted, true);
  assert.deepEqual([view.end.by.kind, view.end.by.landing.receiptId], ['revert', revert]);
  // The FYI row names the same culprit from the events it already holds.
  const list = JSON.parse(await f.s.call('fyiRead', fyi.read, { projectId: f.projectId }, 'owner'));
  assert.deepEqual(
    list.broke.map(row => [row.sequence, row.culprit]),
    [[3, culprit]],
  );
});

test('without a culprit the landings are candidates, and a red still open says why from main’s audit row', async () => {
  const f = fixture();
  f.event('green', 0, 0);
  f.accept(1, 'Adapter: abort on timeout');
  f.accept(2, 'Cache: evict on size');
  f.event('red', 2, 3);
  f.s.insert('projectHostedMainAudits', {
    projectId: f.projectId,
    red: {
      since: at(3),
      head: 'r'.repeat(64),
      runId: 'red-run-2-3',
      tests: ['tests/cache.test.mjs'],
      reason: 'The newest audit failed on tests/cache.test.mjs.',
    },
  });
  const view = await f.read(2);
  assert.equal(view.culprit, null, 'no culprit is claimed before the bisect proves one');
  assert.equal(view.landings.length, 2);
  assert.deepEqual(view.end, {
    how: 'red',
    reason: 'The newest audit failed on tests/cache.test.mjs.',
    tests: ['tests/cache.test.mjs'],
    moreTests: 0,
  });
  assert.equal(view.run, null, 'a run that is not on record is not reported, never invented');
  assert.equal((await f.read()).red.sequence, 2, 'without a sequence: the newest red');
  assert.deepEqual(
    await f.read(99),
    { red: null, note: 'No red at this sequence.' },
    'a sequence with no red says so',
  );
});

test('a red counted as flaky ends there; the read stays bounded on a long history', async () => {
  const f = fixture();
  // A long history before the red: hundreds of landings and audits, none of which the read may touch.
  for (let sequence = 1; sequence <= 300; sequence++) {
    f.accept(sequence, `Landing ${sequence}`);
    if (sequence % 3 === 0) f.event('green', sequence, sequence);
  }
  f.accept(301, 'Flaky neighbour');
  f.event('red', 301, 302);
  f.event('flake', 301, 305);
  for (let sequence = 302; sequence <= 340; sequence++) f.accept(sequence, `Later ${sequence}`);
  f.event('green', 340, 400);
  const before = f.s.counts.length;
  const view = await f.read(301);
  assert.equal(view.end.how, 'flaky', 'the first ending after the red wins');
  assert.equal(view.lastGreen.sequence, 300);
  assert.deepEqual(
    view.landings.map(row => row.title),
    ['Flaky neighbour'],
  );
  const meter = f.s.counts.slice(before).at(-1);
  // Access (2), the red (at most 8 at its sequence), two event pages, the audit and run rows, the landings page and the recovery (none here).
  const budget = 2 + 8 + 2 * red.MAIN_RED_EVENTS + 2 + red.MAIN_RED_LANDINGS + 1;
  assert.ok(meter.documents <= budget, `${meter.documents} documents read, budget ${budget}`);
  assert.equal(meter.writes, 0, 'reading why main failed writes nothing');
});

test('the full log links to the CI’s own page when the runner has one, and to nothing otherwise', () => {
  assert.equal(
    red.runLink({
      configuration: { provider: 'github-actions', repository: 'synthetic/checks' },
      executionId: '123',
    }),
    'https://github.com/synthetic/checks/actions/runs/123',
  );
  assert.equal(
    red.runLink({ configuration: { provider: 'ci-status' }, ci: { link: 'https://ci.example/run/9' } }),
    'https://ci.example/run/9',
  );
  assert.equal(red.runLink({ configuration: { provider: 'modal' }, executionId: 'x' }), null);
});

test('review ae068e0c: while red, the last pass is main’s own record, so landings a full check passed are not candidates', async () => {
  const f = fixture();
  f.event('green', 1, 1);
  for (let sequence = 2; sequence <= 6; sequence++) f.accept(sequence, `Landing ${sequence}`);
  f.event('red', 6, 7);
  // Landing 4 passed a full check while main was green: main's lastGreen moved to 4 with no audit event.
  f.s.insert('projectHostedMainAudits', {
    projectId: f.projectId,
    lastGreen: { sequence: 4, head: 'f'.repeat(64), runId: 'full-run-4' },
    red: { since: at(7), head: 'r'.repeat(64), runId: 'red-run-6-7' },
  });
  const view = await f.read(6);
  assert.deepEqual([view.lastGreen.sequence, view.lastGreen.audited], [4, false]);
  assert.deepEqual(
    view.landings.map(row => row.sequence),
    [6, 5],
    'only landings after the last pass are candidates',
  );
});

test('review ae068e0c: a culprit from a later episode, or written after the red ended, is never claimed', async () => {
  const f = fixture();
  f.event('green', 0, 0);
  f.accept(1, 'One');
  f.accept(2, 'Two');
  f.event('red', 2, 3);
  f.event('green', 3, 6);
  const late = f.accept(3, 'Three');
  f.event('culprit', 1, 8, { culprit: f.receipts.get(1) }); // written after the red ended
  f.event('red', 3, 9);
  f.event('culprit', 3, 10, { culprit: late }); // the later episode's own culprit
  const first = await f.read(2);
  assert.equal(first.culprit, null, 'no culprit was proven inside the first episode');
  const second = await f.read(3);
  assert.equal(second.culprit.receiptId, late);
  const list = JSON.parse(await f.s.call('fyiRead', fyi.read, { projectId: f.projectId }, 'owner'));
  assert.deepEqual(
    list.broke.map(row => [row.sequence, row.culprit]),
    [
      [3, late],
      [2, null],
    ],
    'the FYI row applies the same rule as the view',
  );
});

test('review ae068e0c: the revert of the culprit is named as the recovery even beside a revert of another landing', async () => {
  const f = fixture();
  f.event('green', 0, 0);
  const other = f.accept(1, 'Other');
  const culprit = f.accept(2, 'Culprit');
  f.event('red', 2, 3);
  f.event('culprit', 2, 4, { culprit });
  const revert = f.accept(3, 'Revert Culprit', { revertOf: culprit });
  f.accept(4, 'Revert Other', { revertOf: other });
  f.event('green', 4, 9, { reverted: true });
  const view = await f.read(2);
  assert.deepEqual(
    [view.end.by.kind, view.end.by.landing.receiptId, view.end.by.of, view.end.by.more],
    ['revert', revert, 2, false],
  );
});

test('incident 687d1eda: a newly covered red names the landing that made its tests run, while red and after green', async () => {
  // 11-19: a coverage landing made browser tests run; one of them had never passed. The view listed every landing
  // as a candidate and, once main recovered, nothing said which landing made the test run.
  const f = fixture();
  f.accept(1, 'Docs: tidy');
  f.event('green', 1, 1);
  const coverage = f.accept(2, 'Checks: run browser tests in the landing check');
  f.accept(3, 'Plan: unrelated');
  f.event('red', 3, 4);
  // Recovery (projectHostedCulprit fixForward) names it on main's audit row and in one event, at its sequence.
  const audit = f.s.insert('projectHostedMainAudits', {
    projectId: f.projectId,
    red: {
      since: at(4),
      head: 'r'.repeat(64),
      runId: 'red-run-3-4',
      tests: ['tests/lane-review-browser.test.mjs'],
      reason: 'Newly covered: tests/lane-review-browser.test.mjs had no pass on the last green main.',
      covered: coverage,
      intentId: 'fix-intent',
    },
  });
  const whileRed = await f.read(3);
  assert.equal(whileRed.newlyCoveredBy?.receiptId, coverage, 'while red: main’s audit row names it');
  assert.equal(whileRed.newlyCoveredBy.landing.title, 'Checks: run browser tests in the landing check');
  assert.equal(whileRed.culprit, null, 'a coverage landing is never the culprit');
  f.event('culprit', 2, 5, { covered: coverage });
  assert.equal((await f.read(3)).culprit, null, 'its event names no culprit either');
  // The fix lands; main passes; the audit row's red is gone.
  f.accept(4, 'Lane review: fit 390 px');
  f.event('green', 4, 9);
  f.s.patch('projectHostedMainAudits', audit, { red: undefined });
  const after = await f.read(3);
  assert.equal(after.end.how, 'recovered');
  assert.equal(
    after.newlyCoveredBy?.receiptId,
    coverage,
    'after green: the event written once still names it',
  );
  assert.equal(after.culprit, null);
  const list = JSON.parse(await f.s.call('fyiRead', fyi.read, { projectId: f.projectId }, 'owner'));
  assert.deepEqual(
    list.broke.map(row => [row.sequence, row.culprit]),
    [[3, null]],
    'the FYI row never calls it the culprit',
  );
});
