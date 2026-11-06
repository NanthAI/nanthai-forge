// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recordsFixture } from './hosted-context-records-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const limits = await import(moduleUrl('../src/hosted-overlap.ts'));
const day = 24 * 3_600_000;
const T0 = Date.parse('2026-11-06T00:00:00Z');
const notice = i => String(i).padStart(64, '0');
const answer = (laneId, i, extra = {}) => ({
  operationId: randomUUID(),
  laneId,
  noticeId: notice(i),
  choice: 'accept-order',
  ...extra,
});
const append = (s, answers) =>
  s.request('projectHostedOverlapAcks:append', { operationId: randomUUID(), answers });
const read = (s, args) => s.invoke('projectHostedOverlapAnswers:read', { projectId: 'project', ...args });

test('the retention value is the owner decision: 90 days', () => {
  assert.equal(limits.OVERLAP_ANSWER_RETENTION_MS, 90 * day);
  assert.equal(limits.OVERLAP_ANSWER_CLEANUP_BATCH, 10);
});

test('an answer stays readable after its Lane lands and leaves the peers view', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const s = recordsFixture();
  const landed = randomUUID(),
    other = randomUUID();
  await append(s, [
    answer(landed, 1, { text: 'I will land first.' }),
    answer(other, 2, { choice: 'split', text: 'Different files.' }),
  ]);
  // The advisory rows of the landed Lane are gone from open/peers reads; the answer is not in them.
  s.tables.projectHostedOverlapLanes ??= new Map();
  s.tables.projectHostedOverlapLanes.set('row', {
    _id: 'row',
    projectId: 'project',
    laneId: landed,
    open: false,
  });
  s.tables.projectHostedOverlapLanes.delete('row');
  t.mock.timers.tick(30 * day);
  const byLane = await read(s, { laneId: landed });
  assert.equal(byLane.answers.length, 1);
  assert.equal(byLane.answers[0].text, 'I will land first.');
  assert.equal(byLane.answers[0].laneId, landed);
  assert.equal(byLane.retentionDays, 90);
  assert.equal(byLane.nextCursor, null);
  const window = await read(s, {
    from: new Date(T0 - day).toISOString(),
    to: new Date(T0 + 40 * day).toISOString(),
  });
  assert.deepEqual(
    window.answers.map(a => a.laneId),
    [landed, other],
  );
});

test('an answer is removed after 90 days: unreadable at once, deleted by the next answer write', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const s = recordsFixture();
  const lane = randomUUID();
  await append(s, [answer(lane, 1, { text: 'old answer' })]);
  assert.equal(s.tables.projectHostedOverlapAcks.size, 1);
  assert.equal(s.tables.projectHostedAckBatches.size, 1);
  t.mock.timers.tick(90 * day - 1000);
  assert.equal((await read(s, { laneId: lane })).answers.length, 1, 'still kept just inside 90 days');
  t.mock.timers.tick(2000);
  assert.equal((await read(s, { laneId: lane })).answers.length, 0, 'gone from the read past 90 days');
  assert.equal(s.tables.projectHostedOverlapAcks.size, 1, 'a read deletes nothing');
  await append(s, [answer(randomUUID(), 2, { text: 'fresh' })]);
  assert.equal(s.tables.projectHostedOverlapAcks.size, 1, 'the expired answer and its batch are deleted');
  assert.equal(s.tables.projectHostedAckBatches.size, 1);
  const rest = [...s.tables.projectHostedOverlapAcks.values()].map(row => JSON.parse(row.value).text);
  assert.deepEqual(rest, ['fresh']);
});

test('cleanup is one bounded batch per answer write and a replay does no cleanup', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const s = recordsFixture();
  await append(
    s,
    Array.from({ length: 25 }, (_, i) => answer(randomUUID(), i)),
  );
  t.mock.timers.tick(91 * day);
  assert.equal(s.tables.projectHostedOverlapAcks.size, 25);
  const batch = { operationId: randomUUID(), answers: [answer(randomUUID(), 99)] };
  await s.request('projectHostedOverlapAcks:append', batch);
  assert.equal(s.tables.projectHostedOverlapAcks.size, 25 - limits.OVERLAP_ANSWER_CLEANUP_BATCH + 1);
  assert.equal(s.tables.projectHostedAckBatches.size, 1, 'the expired batch record went; the new one stays');
  const before = s.counts();
  await s.request('projectHostedOverlapAcks:append', batch);
  assert.deepEqual(s.counts().writes, before.writes, 'a replay writes and deletes nothing');
  assert.equal(s.tables.projectHostedOverlapAcks.size, 25 - limits.OVERLAP_ANSWER_CLEANUP_BATCH + 1);
});

test('pages are bounded by rows and by 64 KB, follow nextCursor and keep the window', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: T0 });
  const s = recordsFixture();
  const lane = randomUUID();
  const big = 'x'.repeat(30_000);
  for (let i = 0; i < 12; i++) {
    await append(s, [answer(lane, i, { text: big })]);
    t.mock.timers.tick(1000);
  }
  const seen = [];
  let cursor,
    pages = 0;
  do {
    const page = await read(s, { laneId: lane, ...(cursor ? { cursor } : {}) });
    assert.ok(JSON.stringify(page).length < 64 * 1024, 'each page is under 64 KB');
    assert.ok(page.answers.every(a => a.textTruncated === true && a.text.length === 4000));
    seen.push(...page.answers.map(a => a.noticeId));
    cursor = page.nextCursor ?? undefined;
    pages++;
  } while (cursor);
  assert.deepEqual(
    seen,
    Array.from({ length: 12 }, (_, i) => notice(i)),
  );
  assert.ok(pages >= 1);
  const small = await read(s, { laneId: lane, limit: 5 });
  assert.equal(small.answers.length, 5);
  assert.ok(small.nextCursor);
  await assert.rejects(
    read(s, {
      laneId: lane,
      from: new Date(T0).toISOString(),
      to: new Date(T0 + day).toISOString(),
      cursor: String(T0 - day),
    }),
    error => error.data?.code === 'BAD_ARGUMENT',
  );
  await assert.rejects(read(s, {}), error => error.data?.code === 'BAD_ARGUMENT');
  // An answer of another Lane never appears in a Lane read.
  await append(s, [answer(randomUUID(), 50)]);
  assert.equal((await read(s, { laneId: lane, limit: 50 })).answers.length, 12);
});
