// SPDX-License-Identifier: Apache-2.0
// Who works on an unowned Item now (Item d3357f40, owner 2026-11-19: rows said "no one yet" while agents worked on
// them). The server read asks by Intent (the page's in-progress Items and two follow-ups), one indexed range
// each on the slim presence rows active in the last 48 hours, for writers only, with public identities only; a busy
// project's other Lanes never push an Item's own Lane out. The web places each Lane on its Item and says nothing for an
// Item it did not ask about. Bytes are measured on a dogfood-shaped fixture (30 active Lanes, 30 asked Items).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { meterReads } from './hosted-read-set.mjs';
import { moduleUrl } from './convex-module.mjs';
const workers = await import(moduleUrl('../convex/projectPlanWorkers.ts'));
const people = await import(moduleUrl('../convex/publicPeople.ts'));
const { askedIntents, workersByItem, workersOf, PLAN_WORK_INTENTS } = await import(
  moduleUrl('../web/src/app/plan/workers.ts')
);
const { successorIntentId } = await import(moduleUrl('../src/hosted-intent-chain.ts'));

const HOUR = 3_600_000;
const slugs = ['amber-fox', 'ocean-moth', 'tidy-manatee', 'ivory-raccoon', 'ocean-lark'];

async function world({ active = 30, old = 5, step = HOUR } = {}) {
  const s = recordsFixture(),
    auth = await s.setup();
  await s.ctx.db.insert('forgeAccounts', { owner: 'owner', handle: 'synthetic-owner' });
  await s.ctx.db.insert('accountHandles', { owner: 'owner', handle: 'synthetic-owner' });
  const now = Date.now();
  const lanes = [];
  // Dogfood-shaped rows: a 160-character goal, 10 saved paths of about 60 characters, a session with its device.
  const row = (n, at, intentId = randomUUID()) => ({
    projectId: auth.projectId,
    laneId: randomUUID(),
    intentId,
    actor: 'owner',
    agent: slugs[n % slugs.length],
    session: {
      sessionId: 'c'.repeat(64),
      startedAt: at - HOUR,
      app: 'synthetic-app',
      identityFrom: 'app-thread',
      device: { id: `device-${n}`, code: 'ABCD-1234', approvedAt: at - 10 * HOUR, owner: 'owner' },
    },
    goal: `Synthetic goal ${n} `.padEnd(160, 'x'),
    paths: Array.from({ length: 10 }, (_, i) =>
      `web/src/app/synthetic/area-${n}/module-${i}.tsx`.padEnd(60, 'y'),
    ),
    pathCount: 14,
    at,
  });
  const insert = async value => {
    await s.ctx.db.insert('projectHostedPresence', value);
    return value;
  };
  for (let n = 0; n < active; n++) lanes.push(await insert(row(n, now - (n + 1) * step)));
  // Quiet for over 48 hours, on the same Items: never read.
  for (let n = 0; n < old; n++) await insert(row(active + n, now - (49 + n) * HOUR, lanes[n].intentId));
  const as = subject => {
    s.ctx.auth = { getUserIdentity: async () => (subject ? { subject } : null) };
  };
  as('owner');
  const read = async intentIds =>
    JSON.parse(await workers.read._handler(s.ctx, { projectId: auth.projectId, intentIds }));
  /** What the page asks: each Item and its first two follow-up Intents. */
  const ask = ids => ids.flatMap(id => [id, successorIntentId(id), successorIntentId(successorIntentId(id))]);
  return { s, auth, lanes, as, read, ask, row, insert, now };
}

test('Plan workers: one call, one indexed range per asked Intent, newest first, about 1 KB a Lane', async () => {
  const w = await world();
  const meter = meterReads(w.s.ctx);
  let reply;
  const cost = await meter.cost(async () => {
    reply = await w.read(w.ask(w.lanes.map(lane => lane.intentId)));
  });
  meter.restore();
  assert.deepEqual(
    reply.lanes.map(lane => lane.intentId).sort(),
    w.lanes.map(lane => lane.intentId).sort(),
    'the 30 active Lanes; the 5 quiet for over 48 hours are not read',
  );
  assert.deepEqual(
    Object.keys(reply.lanes[0]).sort(),
    ['actor', 'at', 'intentId'],
    'no goal, paths or session',
  );
  // 30 presence rows, 60 empty follow-up ranges, and the project with its role check: measured, then held.
  assert.ok(cost.documents <= 94, JSON.stringify(cost));
  assert.ok(cost.bytes <= 42_000, `${cost.bytes} bytes at 30 active Lanes`);
  console.log(
    `plan-workers: ${cost.documents} documents, ${cost.bytes} bytes read, ${JSON.stringify(reply).length} bytes sent at 30 asked Items`,
  );
});

test("Plan workers: a busy project's newer Lanes never push an Item's own Lane out (review 3f84a176)", async () => {
  const w = await world({ active: 80, old: 0, step: HOUR / 4 });
  // The asked Item's only Lane is the oldest active one, 47 hours old, behind 80 newer Lanes on other work.
  const item = randomUUID();
  await w.insert(w.row(99, w.now - 47 * HOUR, item));
  const reply = await w.read(w.ask([item]));
  assert.deepEqual(
    reply.lanes.map(lane => lane.intentId),
    [item],
  );
  // A reopened Item's Lane is found by its first follow-up Intent.
  const reopened = randomUUID();
  await w.insert(w.row(98, w.now - HOUR, successorIntentId(reopened)));
  assert.deepEqual(
    (await w.read(w.ask([reopened]))).lanes.map(lane => lane.intentId),
    [successorIntentId(reopened)],
  );
  const twice = randomUUID();
  const second = successorIntentId(successorIntentId(twice));
  await w.insert(w.row(97, w.now - HOUR, second));
  assert.deepEqual(
    (await w.read(w.ask([twice]))).lanes.map(lane => lane.intentId),
    [second],
    'reopened twice',
  );
  // Planning keeps an id's case as given: an upper-case id is asked like any other, never refused.
  const upper = randomUUID().toUpperCase();
  await w.insert(w.row(96, w.now - HOUR, upper));
  assert.deepEqual(
    (await w.read([upper, item])).lanes.map(lane => lane.intentId).sort(),
    [item, upper].sort(),
  );
  // Bounded: at most PLAN_WORK_INTENTS full ids, at most 6 Lanes per Intent.
  assert.equal(workers.PLAN_WORK_INTENTS, PLAN_WORK_INTENTS, 'the page asks what the server allows');
  await assert.rejects(
    w.read(Array.from({ length: PLAN_WORK_INTENTS + 1 }, () => randomUUID())),
    /BAD_ARGUMENT|at most 150/,
  );
  await assert.rejects(w.read(['not-an-intent']), /BAD_ARGUMENT|at most 150/);
  for (let n = 0; n < 9; n++) await w.insert(w.row(n, w.now - n * 60_000, item));
  assert.equal((await w.read([item])).lanes.length, 6);
  assert.deepEqual(await w.read([]), { lanes: [] }, 'nothing asked: nothing read');
});

test('Plan workers: only writers see who works; actors leave as public handles only', async () => {
  const w = await world({ active: 2, old: 0 });
  const ids = w.ask(w.lanes.map(lane => lane.intentId));
  const mapped = JSON.parse(
    await people.publicPeople(w.s.ctx, { projectId: w.auth.projectId }, JSON.stringify(await w.read(ids))),
  );
  assert.deepEqual(mapped.lanes.map(lane => lane.actor).sort(), [
    'synthetic-owner/amber-fox',
    'synthetic-owner/ocean-moth',
  ]);
  w.as('stranger');
  // No write access: presence is withheld, and the page says nothing rather than "no one yet".
  assert.deepEqual(await w.read(ids), { lanes: [], withheld: true });
  w.as(null);
  await assert.rejects(w.read(ids), /PROJECT_UNAVAILABLE|Sign in/);
});

test('Plan workers on the page: asked Items by plan order, each Lane on its Item, public labels only', () => {
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const rows = [
    { id: uuid(1), kind: 'issue', status: 'in-progress', title: 'Started', position: 1 },
    { id: uuid(2), kind: 'issue', status: 'in-progress', title: 'Reopened', position: 2 },
    { id: uuid(3), kind: 'issue', status: 'open', title: 'Planned', position: 3 },
    { id: uuid(9), kind: 'initiative', status: 'open', title: 'Group', position: 0 },
  ];
  const asked = askedIntents(rows);
  assert.deepEqual(
    [...asked.keys()],
    [uuid(1), uuid(2)].flatMap(id => [id, successorIntentId(id), successorIntentId(successorIntentId(id))]),
  );
  const by = workersByItem(
    [
      { intentId: uuid(1), actor: 'synthetic-owner/amber-fox', at: 5 },
      { intentId: uuid(1), actor: 'synthetic-owner/ocean-moth', at: 9 },
      { intentId: uuid(1), actor: 'synthetic-owner/amber-fox', at: 1 },
      { intentId: successorIntentId(successorIntentId(uuid(2))), actor: 'peer-builder', at: 3 },
      // Unasked work, an unmapped account and a hidden actor never reach a row.
      { intentId: uuid(77), actor: 'synthetic-owner/ocean-lark', at: 8 },
      { intentId: uuid(1), actor: 'user_2AbCdEf', at: 7 },
      { intentId: uuid(1), at: 6 },
    ],
    rows,
    asked,
  );
  assert.deepEqual(Object.fromEntries(by), {
    [uuid(1)]: ['synthetic-owner/ocean-moth', 'synthetic-owner/amber-fox'],
    [uuid(2)]: ['peer-builder'],
    [uuid(3)]: [],
  });
  assert.deepEqual(workersOf(by, [uuid(2), uuid(1)]), [
    'peer-builder',
    'synthetic-owner/ocean-moth',
    'synthetic-owner/amber-fox',
  ]);
  // Past the cap an in-progress Item is not asked about, and the page says nothing for it rather than "no one yet".
  const many = Array.from({ length: 70 }, (_, n) => ({
    id: uuid(100 + n),
    kind: 'issue',
    status: 'in-progress',
    title: `Item ${n}`,
    position: n,
  }));
  const capped = askedIntents(many);
  assert.equal(capped.size, PLAN_WORK_INTENTS);
  const placed = workersByItem([], many, capped);
  assert.equal(placed.get(uuid(100))?.length, 0, 'asked and nobody: "no one yet"');
  assert.equal(placed.has(uuid(169)), false, 'not asked: nothing said');
});
