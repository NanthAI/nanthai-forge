// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { slimReceipt } from '../dist/receipt-slim.js';

// Issue 47558a99: receipts leave the process without facts the agent already holds. Budgets are
// characters of the printed JSON (tokens are about chars / 4); raise one only with numbers on the Issue.
const SAVE_WITH_ADVISORY_OVERLAPS = 2_000; // 2026-11-06: a live save with 3 advisory overlaps was 6,180 and is 1,744; this fixture 5,090 -> 1,582
const sha = 'a'.repeat(64);
const laneId = randomUUID();
const peer = n => ({ lane: randomUUID(), actor: 'someone', intent: `Peer change ${n}` });
const notice = (required, count = 3) => {
  const items = Array.from({ length: count }, (_, i) => ({
    noticeId: sha.replace(/a/g, String(i)),
    class: required ? 'blocking' : 'advisory',
    reason: 'unavailable',
    file: 'src/a.ts',
    participants: [{ lane: laneId, actor: 'me', intent: 'Mine' }, peer(i)],
    text: `advisory overlap: src/a.ts; Lane ${randomUUID()} (Peer change ${i}); unavailable.`,
    lanes: [laneId, randomUUID()],
  }));
  return {
    unacknowledgedOverlaps: {
      laneId,
      head: sha,
      count,
      blockingCount: required ? count : 0,
      advisoryCount: required ? 0 : count,
      coverage: 'hosted-incomplete',
      items,
    },
    overlapNotice: {
      required,
      summary: `${count} file overlap(s) between this Lane and other open Lanes.`,
      count,
      coverage: 'hosted-incomplete',
      items: items.map(item => ({
        ...item,
        with: item.participants.slice(1),
        participants: undefined,
        text: undefined,
        lanes: undefined,
      })),
      choices: { 'accept-order': 'Keep your change.', swap: 'Ask first.', split: 'Route around.' },
      acknowledge: `nforge agent '/root' overlap-acks '${JSON.stringify({ answers: items.map(i => ({ operationId: randomUUID(), laneId, noticeId: i.noticeId, choice: 'accept-order' })) })}'`,
      routeAround: `nforge agent '/root' overlap-acks '${JSON.stringify({ answers: items.map(i => ({ operationId: randomUUID(), laneId, noticeId: i.noticeId, choice: 'split' })) })}'`,
    },
  };
};
const save = extra => ({
  schema: 1,
  cliCommit: sha,
  transport: 'hosted',
  action: 'save',
  operationId: randomUUID(),
  resolved: { operationId: 'x' },
  result: {
    at: '2026-01-01T00:00:00.000Z',
    attemptId: randomUUID(),
    outcome: {
      result: {
        at: '2026-01-01T00:00:00.000Z',
        head: sha,
        laneId,
        operationId: 'x',
        saveId: randomUUID(),
        schema: 1,
        sourceVersion: 1,
        unchanged: false,
        version: 1,
      },
      status: 'completed',
    },
  },
  behindMain: {
    head: sha,
    baseHead: sha,
    baseSequence: 30000,
    commits: 0,
    conflictingPaths: [],
    more: 0,
    coverage: 'hosted',
  },
  ...extra,
});
const chars = value => JSON.stringify(value).length;

test('a save with advisory overlaps keeps every decision fact once', t => {
  const full = save(notice(false)),
    slim = slimReceipt(full);
  t.diagnostic(`save with 3 advisory overlaps: ${chars(full)} -> ${chars(slim)} chars`);
  assert(chars(slim) <= SAVE_WITH_ADVISORY_OVERLAPS, `${chars(slim)} chars`);
  // Counts, class, file, the other Lane's actor and intent, and the saved head survive.
  assert.equal(slim.unacknowledgedOverlaps.count, 3);
  assert.equal(slim.unacknowledgedOverlaps.advisoryCount, 3);
  assert.equal(slim.overlapNotice.items.length, 3);
  assert.equal(slim.overlapNotice.items[1].file, 'src/a.ts');
  assert.equal(slim.overlapNotice.items[1].with[0].intent, 'Peer change 1');
  assert.equal(slim.result.outcome.result.head, sha);
  assert.equal(slim.result.outcome.result.saveId, full.result.outcome.result.saveId);
  // An advisory notice needs no answer, so it carries no answer commands.
  assert(!('acknowledge' in slim.overlapNotice) && !('routeAround' in slim.overlapNotice));
  assert.deepEqual(slim.behindMain, { commits: 0, coverage: 'hosted' });
});

test('a blocking notice keeps its ready-to-run answers', () => {
  const full = save(notice(true)),
    slim = slimReceipt(full);
  assert.equal(slim.overlapNotice.required, true);
  assert.equal(slim.overlapNotice.acknowledge, full.overlapNotice.acknowledge);
  assert.equal(slim.overlapNotice.routeAround, full.overlapNotice.routeAround);
  assert(!('choices' in slim.overlapNotice));
});

test('behind main, a checkout and a healthy mirror report only what differs', () => {
  const lane = { laneId, head: sha, version: 0, base: { head: sha } };
  const start = slimReceipt({
    transport: 'hosted',
    result: { lane, checkout: { ...lane, root: '/lane', downloadedObjects: 0, replayed: false } },
    behindMain: {
      head: sha,
      baseHead: sha,
      baseSequence: 1,
      commits: 2,
      conflictingPaths: ['a'],
      more: 0,
      coverage: 'hosted',
    },
  });
  assert.deepEqual(start.result.checkout, { root: '/lane', downloadedObjects: 0, replayed: false });
  assert.equal(start.behindMain.commits, 2, 'a Lane that is behind keeps its full detail');
  assert.deepEqual(start.behindMain.conflictingPaths, ['a']);
  const status = slimReceipt({
    transport: 'hosted',
    result: {
      head: sha,
      githubMirror: {
        repository: 'o/r',
        status: 'synced',
        targetHead: sha,
        mirroredHead: sha,
        lagging: false,
        failures: 0,
        error: null,
      },
    },
  });
  assert.deepEqual(status.result.githubMirror, { status: 'synced', repository: 'o/r' });
  const failing = {
    transport: 'hosted',
    result: { githubMirror: { status: 'synced', lagging: false, failures: 2, error: null } },
  };
  assert.deepEqual(slimReceipt(failing), failing, 'a mirror with failures keeps all fields');
});

test('preflight counts the deferred tests instead of listing hundreds', () => {
  const deferredTests = Array.from({ length: 800 }, (_, i) => `tests/file-${i}.test.mjs`);
  const full = {
    transport: 'hosted',
    result: { plan: { tests: ['tests/a.test.mjs'], deferredTests, reason: 'r' } },
  };
  const slim = slimReceipt(full);
  assert.deepEqual(slim.result.plan, { tests: ['tests/a.test.mjs'], reason: 'r', deferredTestCount: 800 });
  assert(chars(slim) * 20 < chars(full));
});

test('peers keeps the evidence once', () => {
  const items = [{ noticeId: 'n', file: 'a', participants: [{ lane: 'x' }] }];
  const slim = slimReceipt({
    transport: 'hosted',
    result: {
      unacknowledgedOverlaps: { laneId, head: sha, count: 1, items },
      peerEvidence: { count: 1, items },
    },
  });
  assert.deepEqual(slim.result.unacknowledgedOverlaps, { count: 1 });
  assert.deepEqual(slim.result.peerEvidence.items, items);
});

test('native and non-object receipts pass through untouched', () => {
  const native = { transport: 'native', overlapNotice: { required: false, choices: {} } };
  assert.equal(slimReceipt(native), native);
  assert.equal(slimReceipt(undefined), undefined);
  assert.deepEqual(slimReceipt([1]), [1]);
});
