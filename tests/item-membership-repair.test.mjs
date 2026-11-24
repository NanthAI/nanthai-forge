// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { successorIntentId } from '../dist/hosted-intent-chain.js';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const repair = await import(moduleUrl('../convex/projectItemLaneBackfill.ts'));
const { verifiedItemMembership } = await import(moduleUrl('../convex/projectItemMembershipVersion.ts'));

function deployment(t, url = 'https://benevolent-wildebeest-974.convex.cloud') {
  const before = process.env.CONVEX_CLOUD_URL;
  process.env.CONVEX_CLOUD_URL = url;
  t.after(() => {
    if (before === undefined) delete process.env.CONVEX_CLOUD_URL;
    else process.env.CONVEX_CLOUD_URL = before;
  });
}

test('repair resumes across a long markerless chain, projects its Lanes, and does not take another Item’s Intent', async t => {
  deployment(t);
  const s = recordsFixture(),
    { projectId } = await s.setup();
  const heads = s.tables.projectHostedRecordHeads;
  const input = (kind, key, parent = '', marker) =>
    s.ctx.db.insert('projectHostedRecordHeads', {
      projectId,
      kind,
      key,
      parent,
      version: 0,
      status: 'completed',
      recordId: 'fixture-record',
      ...(marker !== undefined ? { planningItemId: marker } : {}),
    });
  const root = randomUUID();
  // An Intent-born Item starts with a standalone marker and is proved by the same-ID Item head.
  await input('issue', root);
  const rootHead = await input('intent', root, '', '');
  const rootLane = await input('lane', randomUUID(), root, '');
  let key = root;
  const members = [];
  for (let i = 0; i < 70; i++) {
    key = successorIntentId(key);
    members.push(await input('intent', key), await input('lane', randomUUID(), key));
  }
  const neighbor = successorIntentId(key);
  await input('issue', neighbor);
  const neighborIntent = await input('intent', neighbor);
  const neighborLane = await input('lane', randomUUID(), neighbor);
  const run = after => s.call('repair', repair.run, { projectId, after });
  const first = await run(null);
  assert(first.next);
  assert.deepEqual(await run(null), { scanned: 0, patched: 0, next: first.next });
  let after = first.next;
  for (let pages = 0; after !== null && pages < 12; pages++) {
    const page = await run(after);
    assert.notEqual(page.next, after);
    assert(page.scanned <= 62);
    const cost = s.counts.at(-1);
    assert(cost.documents <= 192 && cost.ranges <= 132 && cost.writes <= 64);
    assert(cost.readBytes <= 8 * 2 ** 20 && cost.writeBytes <= 4 * 2 ** 20);
    after = page.next;
  }
  assert.equal(after, null);
  for (const id of [rootHead, rootLane, ...members]) assert.equal(heads.get(id).planningItemId, root);
  for (const id of [neighborIntent, neighborLane]) assert.equal(heads.get(id).planningItemId, neighbor);
  assert.equal((await s.ctx.db.get(projectId)).itemLaneMembership, verifiedItemMembership);
  assert.deepEqual(await run(first.next), { scanned: 0, patched: 0, next: null });
});

test('the deployment census reports incomplete projects on later pages; a finished repair counts as covered', async t => {
  deployment(t);
  const s = recordsFixture();
  for (let i = 0; i < 62; i++) {
    const { projectId } = await s.setup();
    await s.ctx.db.patch(projectId, { itemLaneMembership: verifiedItemMembership });
  }
  const { projectId } = await s.setup();
  await s.ctx.db.patch(projectId, { itemLaneMembership: true }); // pre-writer receipt is stale
  const census = after => s.call('census', repair.coverage, { after });
  const first = await census(null);
  assert(first.next);
  assert.equal(first.checked, 62);
  assert.equal(first.covered, 62);
  assert.deepEqual(first.incomplete, []);
  assert.deepEqual(await census(first.next), {
    checked: 1,
    covered: 0,
    next: null,
    incomplete: [{ projectId, after: null }],
  });
  let after = null;
  do {
    ({ next: after } = await s.call('repair', repair.run, { projectId, after }));
  } while (after !== null);
  assert.deepEqual(await census(first.next), { checked: 1, covered: 1, next: null, incomplete: [] });
});

async function projectWithoutGeneration(s) {
  const { projectId } = await s.setup();
  await s.ctx.db.patch(projectId, {
    work: { backupId: 'fixture-backup', operationId: randomUUID(), initialRevision: 0, revision: 0 },
  });
  return projectId;
}

test('a project without a Work generation is covered once both hosted head ranges are empty', async t => {
  deployment(t);
  const s = recordsFixture(),
    projectId = await projectWithoutGeneration(s);
  const census = () => s.call('census', repair.coverage, { after: null });
  const run = () => s.call('repair', repair.run, { projectId, after: null });
  assert.equal((await census()).covered, 0);
  const result = await run();
  assert.equal(result.next, null);
  assert.equal(result.scanned, 0);
  assert.equal(result.patched, 0);
  const { documents, ranges, writes } = s.counts.at(-1);
  // Includes the standard writer's possible first legacy project companion.
  assert(documents <= 5 && ranges <= 5 && writes <= 2);
  assert.deepEqual(await census(), { checked: 1, covered: 1, next: null, incomplete: [] });
  assert.deepEqual(await run(), { scanned: 0, patched: 0, next: null });
  assert.equal(s.counts.at(-1).writes, 0);
});

for (const kind of ['intent', 'lane']) {
  test(`membership repair refuses a missing Work index when a hosted ${kind} head exists`, async t => {
    deployment(t);
    const s = recordsFixture(),
      projectId = await projectWithoutGeneration(s);
    await s.ctx.db.insert('projectHostedRecordHeads', {
      projectId,
      kind,
      key: randomUUID(),
      parent: '',
      version: 0,
      status: 'completed',
      recordId: 'fixture-record',
    });
    await assert.rejects(
      s.call('repair', repair.run, { projectId, after: null }),
      error => error.code === 'PROJECT_WORK_INDEX_MISSING',
    );
    assert.equal(s.counts.at(-1).writes, 0);
    assert.deepEqual(await s.call('census', repair.coverage, { after: null }), {
      checked: 1,
      covered: 0,
      next: null,
      incomplete: [{ projectId, after: null }],
    });
  });
}

test('membership repair and its census refuse non-dev deployments without writing', async t => {
  deployment(t, 'https://fixture-prod.convex.cloud');
  const s = recordsFixture(),
    { projectId } = await s.setup();
  for (const [action, input] of [
    [repair.run, { projectId, after: null }],
    [repair.coverage, { after: null }],
  ])
    await assert.rejects(s.call('non-dev', action, input), error => error.code === 'PROJECT_UNAVAILABLE');
  assert.equal((await s.ctx.db.get(projectId)).itemLaneMembership, undefined);
});
