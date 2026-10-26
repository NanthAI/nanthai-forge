// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actionsFixture } from './hosted-actions-fixture.mjs';
import { HostedActionsProvider, cleanupHostedActions } from '../dist/hosted-actions-controller.js';
import { ActionsApiError } from '../dist/github-actions-api.js';
import { HostedActionsAccessError } from '../dist/hosted-actions-remote.js';
import { dispatchHostedCheck } from '../dist/hosted-check-controller.js';
import { code } from './hosted-checks-fixture.mjs';
function fake(s, { lostPush = false, lostDispatch = false, status = null } = {}) {
  const runs = [],
    refs = new Map(),
    counts = { builds: 0, publishes: 0, dispatches: 0, paid: 0, deletes: 0 };
  const remote = {
    api: {
      async request(endpoint, method, body) {
        if (method === 'POST') {
          counts.dispatches++;
          assert.equal(body.ref, `forge-check/${s.input.id}`);
          assert.equal(body.inputs.runId, s.input.id);
          assert.equal(body.inputs.plan, '[]');
          if (status !== null) throw new ActionsApiError(status);
          counts.paid++;
          runs.push({ id: 123, head_sha: s.exported.commit, display_title: body.ref });
          if (lostDispatch) throw new ActionsApiError(400);
          return;
        }
        return { commit: { sha: refs.get(s.input.id) } };
      },
      async pages() {
        return structuredClone(runs);
      },
    },
    async publish(m) {
      counts.publishes++;
      assert.equal(m.export.commit, s.exported.commit);
      assert(!refs.has(m.runId) || refs.get(m.runId) === m.export.commit);
      refs.set(m.runId, m.export.commit);
      if (lostPush && counts.publishes === 1) throw new Error('synthetic lost push reply');
    },
    async delete(m) {
      counts.deletes++;
      assert.equal(refs.get(m.runId), m.export.commit);
      refs.delete(m.runId);
    },
  };
  const provider = new HostedActionsProvider(
    s.store,
    remote,
    async () => {
      counts.builds++;
      return s.exported;
    },
    s.now,
  );
  const tick = () => provider.dispatch(s.input);
  return { remote, provider, tick, runs, refs, counts };
}
test('lost export control acknowledgement reuses the committed export and original pins', async () => {
  const s = await actionsFixture(),
    original = s.store.control;
  let lost = true;
  s.store.control = async c => {
    const r = await original(c);
    if (c.kind === 'export' && lost) {
      lost = false;
      throw new Error('lost');
    }
    return r;
  };
  const f = fake(s);
  await assert.rejects(f.tick(), /lost/);
  await f.tick();
  await f.tick();
  await f.tick();
  assert.equal(f.counts.builds, 1);
  assert.equal(f.counts.dispatches, 1);
  assert.equal(f.counts.paid, 1);
  assert.equal(s.mapping().head, s.input.request.expectedHead);
  assert.equal(s.mapping().export.commit, s.exported.commit);
  assert.equal(s.mapping().run, 123);
});
test('lost run-owned ref publication reply reconciles without rebuilding or changing commit', async () => {
  const s = await actionsFixture(),
    f = fake(s, { lostPush: true });
  await f.tick();
  await assert.rejects(f.tick(), /lost push/);
  await f.tick();
  await f.tick();
  await f.tick();
  assert.equal(f.counts.builds, 1);
  assert.equal(f.counts.publishes, 2);
  assert.equal(f.counts.paid, 1);
});
test('lost HTTP 400 dispatch reply adopts retained run, including reconnect and H10 mapping', async () => {
  const s = await actionsFixture(),
    f = fake(s, { lostDispatch: true });
  const owner = randomUUID(),
    store = { control: command => s.control(s.input.id, command) };
  // Release the fixture H10 owner lease to this controller.
  const row = [...s.tables.projectHostedCheckRuns.values()][0],
    value = JSON.parse(row.value);
  value.lease.until = 0;
  s.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify(value) });
  let run;
  for (let i = 0; i < 4; i++) run = await dispatchHostedCheck(store, f.provider, owner);
  assert.equal(run.status, 'running');
  assert.equal(run.executionId, '123');
  for (let i = 0; i < 3; i++) assert.equal((await f.provider.lookup(s.input)).executionId, '123');
  assert.equal(f.counts.builds, 1);
  assert.equal(f.counts.dispatches, 1);
  assert.equal(f.counts.paid, 1);
  assert.deepEqual(run.cost, { status: 'unknown' });
});
test('ambiguous 400 has a single recovery only after twelve lookups and a fresh empty branch query', async () => {
  const s = await actionsFixture(),
    f = fake(s, { status: 400 });
  await f.tick();
  await f.tick();
  await f.tick();
  for (let i = 0; i < 12; i++) {
    s.advance();
    await f.tick();
    assert.equal(f.counts.dispatches, 1);
  }
  s.advance();
  await f.tick();
  assert.equal(f.counts.dispatches, 2);
  assert(s.mapping().recoveryUsed);
  for (let i = 0; i < 16; i++) {
    s.advance();
    await f.tick();
  }
  assert.equal(f.counts.dispatches, 2);
  assert.equal(f.counts.paid, 0);
});
test('accepted acknowledgement never redelivers on eventual-consistency absence', async () => {
  const s = await actionsFixture(),
    f = fake(s);
  await f.tick();
  await f.tick();
  await f.tick();
  f.runs.length = 0;
  for (let i = 0; i < 15; i++) {
    s.advance();
    await f.tick();
  }
  assert.equal(f.counts.dispatches, 1);
  assert.equal(s.mapping().outcome, 'accepted');
});
test('nonmatching branch runs prevent recovery, and duplicate exact matches surface evidence change', async () => {
  const s = await actionsFixture(),
    f = fake(s, { status: 400 });
  await f.tick();
  await f.tick();
  await f.tick();
  f.runs.push({ id: 9, head_sha: '2'.repeat(40), display_title: 'foreign' });
  for (let i = 0; i < 15; i++) {
    s.advance();
    await f.tick();
  }
  assert.equal(f.counts.dispatches, 1);
  f.runs.push(...[1, 2].map(id => ({ id, head_sha: s.exported.commit, display_title: s.mapping().branch })));
  await assert.rejects(f.tick(), code('EVIDENCE_CHANGED'));
});
test('registration and access failures retain actionable metadata and do not dispatch', async () => {
  for (const reason of ['registration', 'access']) {
    const s = await actionsFixture(),
      f = fake(s);
    f.remote.publish = async () => {
      throw new HostedActionsAccessError(reason);
    };
    await f.tick();
    assert.equal((await f.tick()).status, 'rejected');
    assert.equal(s.mapping().error, reason);
    assert.equal(f.counts.dispatches, 0);
    assert.equal(f.counts.builds, 1);
  }
});
test('concurrent ticks hold one lease and cannot submit twice', async () => {
  const s = await actionsFixture(),
    f = fake(s);
  await Promise.all([f.tick(), f.tick()]);
  await Promise.all([f.tick(), f.tick()]);
  await Promise.all([f.tick(), f.tick()]);
  assert.equal(f.counts.builds, 1);
  assert.equal(f.counts.dispatches, 1);
});
test('run branch cleanup requires a committed terminal result and retains mapping after lost delete reply', async () => {
  const s = await actionsFixture(),
    f = fake(s);
  for (let i = 0; i < 4; i++) await f.tick();
  await assert.rejects(cleanupHostedActions(s.store, f.remote), code('WORK_STALE'));
  assert.equal(f.counts.deletes, 0);
  const adopted = await s.control(s.input.id, {
    kind: 'observe',
    owner: s.input.lease.owner,
    token: s.input.lease.token,
    result: { status: 'accepted', executionId: '123' },
  });
  await s.callback({ ...s.shard(adopted.run, 0), provider: 'github-actions' });
  await s.callback({ ...s.complete(adopted.run), provider: 'github-actions' });
  const remove = f.remote.delete;
  let lost = true;
  f.remote.delete = async m => {
    if (f.refs.has(m.runId)) await remove(m);
    if (lost) {
      lost = false;
      throw new Error('lost delete');
    }
  };
  await assert.rejects(cleanupHostedActions(s.store, f.remote), /lost delete/);
  await cleanupHostedActions(s.store, f.remote);
  await cleanupHostedActions(s.store, f.remote);
  assert(s.mapping().deleted);
  assert.equal(s.mapping().run, 123);
  assert(s.mapping().export);
  assert.equal(f.counts.deletes, 1);
});
test('stale leases, source pins, cancellation, and changed authority cannot publish or dispatch', async () => {
  const s = await actionsFixture(),
    f = fake(s);
  await f.tick();
  await f.tick();
  const claim = await s.store.control({ kind: 'claim', owner: randomUUID() });
  await assert.rejects(
    s.store.control({
      kind: 'published',
      owner: claim.mapping.lease.owner,
      token: claim.mapping.lease.token - 1,
    }),
    code('WORK_STALE'),
  );
  await s.store.control({
    kind: 'release',
    owner: claim.mapping.lease.owner,
    token: claim.mapping.lease.token,
  });
  await assert.rejects(
    f.provider.dispatch({ ...s.input, dispatchKey: 'f'.repeat(64) }),
    code('EVIDENCE_CHANGED'),
  );
  s.advance(200000);
  await s.cancel(s.input.id);
  await assert.rejects(f.tick(), code('WORK_STALE'));
  assert.equal(f.counts.dispatches, 0);
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(f.tick());
});

test('rejected single recovery never licenses another dispatch and incomplete lookups do not advance recovery', async () => {
  const s = await actionsFixture(),
    f = fake(s, { status: 400 });
  await f.tick();
  await f.tick();
  await f.tick();
  const pages = f.remote.api.pages;
  f.remote.api.pages = async () => {
    throw new ActionsApiError();
  };
  for (let i = 0; i < 3; i++) {
    s.advance();
    await assert.rejects(f.tick());
  }
  assert.equal(s.mapping().emptyLookups, 0);
  f.remote.api.pages = pages;
  for (let i = 0; i < 12; i++) {
    s.advance();
    await f.tick();
  }
  const request = f.remote.api.request;
  f.remote.api.request = async (endpoint, method, body) => {
    if (method === 'POST') {
      f.counts.dispatches++;
      throw new ActionsApiError(422);
    }
    return request(endpoint, method, body);
  };
  s.advance();
  await f.tick();
  for (let i = 0; i < 15; i++) {
    s.advance();
    await f.tick();
  }
  assert.equal(f.counts.dispatches, 2);
  assert.equal(s.mapping().outcome, 'ambiguous');
});
test('lost accepted-response control acknowledgement never degrades to ambiguous or redelivers', async () => {
  const s = await actionsFixture(),
    f = fake(s),
    control = s.store.control;
  let lost = true;
  s.store.control = async c => {
    const r = await control(c);
    if (c.kind === 'dispatch' && lost) {
      lost = false;
      throw new Error('lost accepted save');
    }
    return r;
  };
  await f.tick();
  await f.tick();
  await assert.rejects(f.tick(), /lost accepted save/);
  f.runs.length = 0;
  for (let i = 0; i < 15; i++) {
    s.advance();
    await f.tick();
  }
  assert.equal(s.mapping().outcome, 'accepted');
  assert.equal(f.counts.dispatches, 1);
});
test('current reader status exposes actionable errors and rejects foreign readers', async () => {
  const { moduleUrl } = await import('./convex-module.mjs');
  const api = await import(moduleUrl('../convex/projectHostedActions.ts'));
  const s = await actionsFixture(),
    f = fake(s);
  f.remote.publish = async () => {
    throw new HostedActionsAccessError('registration');
  };
  await f.tick();
  await f.tick();
  const args = { projectId: s.projectId, runId: s.input.id };
  const value = JSON.parse(await s.call('actionsStatus', api.status, args));
  assert.equal(value.error.code, 'GITHUB_APP_UNAVAILABLE');
  assert.match(value.error.message, /credential-use reference/);
  assert(!JSON.stringify(value).includes('synthetic-private-token'));
  await assert.rejects(s.call('actionsStatus', api.status, args, 'foreign'), code('PROJECT_UNAVAILABLE'));
});

test('replayed lease-scoped dispatch/lookup receipts do not increment attempts or absence evidence', async () => {
  const s = await actionsFixture(),
    f = fake(s, { status: 400 });
  await f.tick();
  await f.tick();
  const owner = randomUUID(),
    claim = await s.store.control({ kind: 'claim', owner });
  const token = claim.mapping.lease.token;
  const reserve = { kind: 'reserve', owner, token, recovery: false };
  assert((await s.store.control(reserve)).effect);
  assert.equal((await s.store.control(reserve)).effect, false);
  const dispatch = { kind: 'dispatch', owner, token, outcome: 'ambiguous', httpStatus: 400 };
  await s.store.control(dispatch);
  await s.store.control(dispatch);
  const lookup = { kind: 'lookup', owner, token, run: null, empty: true };
  await s.store.control(lookup);
  await s.store.control(lookup);
  assert.equal(s.mapping().emptyLookups, 1);
  await assert.rejects(s.store.control({ ...lookup, empty: false }), code('WORK_OPERATION_CHANGED'));
  await s.store.control({ kind: 'release', owner, token });
  const next = await s.store.control({ kind: 'claim', owner });
  const response = {
    kind: 'dispatch',
    owner,
    token: next.mapping.lease.token,
    outcome: 'rejected',
    httpStatus: 422,
  };
  await s.store.control(response);
  await s.store.control(response);
  assert.equal(s.mapping().rejections, 1);
});

test('H10 records definitive registration/access failure as runner-unavailable after pending export', async () => {
  const s = await actionsFixture(),
    f = fake(s);
  f.remote.publish = async () => {
    throw new HostedActionsAccessError('access');
  };
  const row = [...s.tables.projectHostedCheckRuns.values()][0],
    value = JSON.parse(row.value);
  value.lease.until = 0;
  s.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify(value) });
  const owner = randomUUID(),
    store = { control: command => s.control(s.input.id, command) };
  assert.equal((await dispatchHostedCheck(store, f.provider, owner)).status, 'unknown');
  assert.equal((await dispatchHostedCheck(store, f.provider, owner)).status, 'runner-unavailable');
  assert.equal(s.mapping().error, 'access');
  assert.equal(f.counts.dispatches, 0);
});
