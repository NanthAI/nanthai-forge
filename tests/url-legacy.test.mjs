// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Old id-only addresses (Item d61f36fe): one access-checked read answers where a project, decision or review view
// lives now, and an id never reveals the handle of a project the caller cannot read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';

const legacy = await import(moduleUrl('../convex/urlLegacy.ts'));
const identity = await import(moduleUrl('../convex/urlIdentity.ts'));
const { HOSTED_WORK_INDEX_FORMAT } = await import(moduleUrl('../src/work-hosted-summary.ts'));

async function fixture() {
  const s = state([]);
  s.tables.hostedProjects.set('p1', {
    _id: 'p1',
    _creationTime: 1,
    owner: 'owner',
    name: 'Forge',
    key: 'key1',
    currentBackup: null,
    revision: 0,
  });
  s.tables.projectWorkGenerations.set('g1', {
    _id: 'g1',
    projectId: 'p1',
    backupId: 'b1',
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    metadata: JSON.stringify({ schema: 24 }),
  });
  await identity.ensureAccount(s.ctx, 'owner', { username: 'Dino' });
  await identity.ensureProjectSlug(s.ctx, s.tables.hostedProjects.get('p1'));
  // The work pointer is set after the slug write, which validates the whole document.
  s.tables.hostedProjects.get('p1').work = { generationId: 'g1', backupId: 'b1' };
  s.tables.projectHostedDecisions ??= new Map();
  const decision = (key, target) =>
    s.tables.projectHostedDecisions.set(key, {
      _id: key,
      projectId: 'p1',
      id: key,
      target,
      value: '{}',
      request: '',
      actor: 'a',
    });
  decision('d-project', 'project');
  decision('d-intent', 'intent:item-1');
  const view = (key, value) =>
    s.tables.projectWorkRecords.set(key, {
      _id: key,
      generationId: 'g1',
      collection: 'views',
      key,
      parent: '',
      position: 0,
      value: JSON.stringify(value),
    });
  view('v-lane', { inputs: [{ laneId: 'lane-1' }, { laneId: 'lane-2' }], intentId: 'item-2' });
  view('v-resolved', { inputs: [], resolution: { laneId: 'lane-3' }, intentId: 'item-2' });
  view('v-item', { inputs: [], intentId: 'item-2' });
  view('v-bare', { inputs: [] });
  return s;
}
const ask = (s, input) => legacy.resolve._handler(s.ctx, input);

test('a project id opens its current handle and slug, with no Lane or Item', async () => {
  const s = await fixture();
  assert.deepEqual(await ask(s, { projectId: 'p1' }), { handle: 'dino', slug: 'forge', to: null });
  // The path form of an old address names handle and slug, which may be old ones.
  assert.deepEqual(await ask(s, { handle: 'dino', slug: 'forge~p1' }), {
    handle: 'dino',
    slug: 'forge',
    to: null,
  });
});

test('a decision opens the Item of its Intent; a project decision and an unknown id open the project', async () => {
  const s = await fixture();
  const find = id => ({ projectId: 'p1', find: { kind: 'decision', id } });
  assert.deepEqual((await ask(s, find('d-intent'))).to, { place: 'plan', id: 'item-1' });
  assert.equal((await ask(s, find('d-project'))).to, null);
  assert.deepEqual(await ask(s, find('d-missing')), { handle: 'dino', slug: 'forge', to: null });
});

test('a review view opens the Lane it composed, else the Item of its Intent', async () => {
  const s = await fixture();
  const find = id => ({ projectId: 'p1', find: { kind: 'review', id } });
  assert.deepEqual((await ask(s, find('v-lane'))).to, { place: 'lanes', id: 'lane-1' });
  assert.deepEqual((await ask(s, find('v-resolved'))).to, { place: 'lanes', id: 'lane-3' });
  assert.deepEqual((await ask(s, find('v-item'))).to, { place: 'plan', id: 'item-2' });
  assert.equal((await ask(s, find('v-bare'))).to, null);
  assert.equal((await ask(s, find('v-missing'))).to, null);
});

test('a project the caller cannot read answers null, for every kind of id, and never names its handle', async () => {
  const s = await fixture();
  for (const caller of ['stranger', undefined])
    for (const input of [
      { projectId: 'p1' },
      { projectId: 'p1', find: { kind: 'decision', id: 'd-intent' } },
      { projectId: 'p1', find: { kind: 'review', id: 'v-lane' } },
      { handle: 'dino', slug: 'forge', find: { kind: 'decision', id: 'd-intent' } },
      { projectId: 'nope' },
    ]) {
      s.caller(caller);
      assert.equal(await ask(s, input), null);
    }
});

test('a decision or review id on a public project is not answered to anyone without a role', async () => {
  const s = await fixture();
  s.tables.hostedProjects.get('p1').visibility = 'public';
  for (const caller of ['stranger', undefined]) {
    s.caller(caller);
    const answer = await ask(s, { projectId: 'p1', find: { kind: 'decision', id: 'd-intent' } });
    // The project itself may be public, so its address answers; the Work ids behind the decision do not.
    if (answer) assert.equal(answer.to, null);
    const review = await ask(s, { projectId: 'p1', find: { kind: 'review', id: 'v-lane' } });
    if (review) assert.equal(review.to, null);
  }
  s.caller('owner');
  assert.deepEqual((await ask(s, { projectId: 'p1', find: { kind: 'decision', id: 'd-intent' } })).to, {
    place: 'plan',
    id: 'item-1',
  });
});

test('a view that is not valid JSON opens nothing', () => {
  assert.equal(legacy.reviewTarget('not json'), null);
  assert.equal(legacy.reviewTarget('{"inputs":[{"laneId":7}]}'), null);
  assert.equal(legacy.decisionTarget('project'), null);
});
