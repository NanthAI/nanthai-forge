// SPDX-License-Identifier: Apache-2.0
// `land --withdraw` through the real hosted agent transport (Issue 78a97771): one mutation, a lost
// reply replays the same withdraw, and a later identical withdraw targets the Lane's next landing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { revertFixture, synthetic } from './hosted-revert-fixture.mjs';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { readTurnLedger, recordTurnWork } from '../dist/agent-turn-work.js';
const modules = Object.fromEntries(
  await Promise.all(
    ['projectHostedAgent', 'projectHostedLandingWithdraw', 'projectHostedLanding'].map(async name => [
      name,
      await import(moduleUrl(`../convex/${name}.ts`)),
    ]),
  ),
);
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
async function setup(t, { features = true } = {}) {
  const f = await revertFixture(t),
    directory = mkdtempSync(join(tmpdir(), 'forge-agent-withdraw-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const calls = [];
  let lost = null;
  const invoke = async (ref, args) => {
    const name = getFunctionName(ref),
      [module, member] = name.split(':');
    assert(modules[module]?.[member], `Only synthetic registered API handlers: ${name}`);
    calls.push(name);
    let result = await f.tx(`agent:${name}`, modules[module][member], args);
    if (!features && name === 'projectHostedAgent:capabilities') {
      const reply = JSON.parse(result);
      result = JSON.stringify({ ...reply, features: reply.features.filter(x => x !== 'landing-withdraw') });
    }
    if (name === lost) {
      lost = null;
      throw new Error('Synthetic reply lost after transaction');
    }
    return result;
  };
  const exchange = { projectId: f.projectId, client: { query: invoke, mutation: invoke } };
  const address = { url: 'https://fixture.invalid', projectId: f.projectId };
  return {
    f,
    calls,
    transport: () => new HostedAgentTransport(join(directory, 'client'), address, exchange),
    lose: name => {
      lost = name;
    },
  };
}
const landing = async f => {
  const state = await f.enqueue(f.request());
  await f.drain();
  return state;
};

test('withdraw replays a lost reply, keeps the Lane and a later identical withdraw ends the next landing', async t => {
  const s = await setup(t),
    first = await landing(s.f),
    lane = await s.f.readLane(s.f.lane.laneId),
    command = { laneId: s.f.lane.laneId };
  s.lose('projectHostedLandingWithdraw:withdraw');
  await assert.rejects(s.transport().dispatch('withdraw', command), { code: 'HOSTED_ACTION_FAILED' });
  const replayed = await s.transport().dispatch('withdraw', command);
  assert.equal(replayed.result.withdrawn, true);
  assert.equal(replayed.result.submissionId, first.id);
  assert.equal(replayed.result.landing.error.code, 'LANDING_CANCELLED');
  assert.equal(replayed.result.landingOperationId, first.operationId);
  assert.deepEqual(replayed.result.confirm.next.operationIds, [first.operationId]);
  assert.deepEqual(await s.f.readLane(s.f.lane.laneId), lane, 'the Lane stays');
  const withdrawCalls = s.calls.filter(name => name === 'projectHostedLandingWithdraw:withdraw');
  assert.equal(withdrawCalls.length, 2, 'one mutation per attempt, the second a replay of the first');
  assert(s.calls.every(name => name.startsWith('projectHostedAgent:') || withdrawCalls.includes(name)));
  // The builder re-lands the same Lane; a second identical withdraw ends that new landing.
  const second = await landing(s.f);
  const next = await s.transport().dispatch('withdraw', command);
  assert.notEqual(next.operationId, replayed.operationId, 'new work, not a replay');
  assert.equal(next.result.submissionId, second.id);
  assert.equal(next.result.landing.error.code, 'LANDING_CANCELLED');
  assert.equal((await s.f.current(first.id)).submission.error.code, 'LANDING_CANCELLED', 'evidence kept');
});

test('a server without landing-withdraw is refused before any mutation, naming x cancel', async t => {
  const s = await setup(t, { features: false });
  await landing(s.f);
  await assert.rejects(
    s.transport().dispatch('withdraw', { laneId: s.f.lane.laneId }),
    error => error.code === 'HOSTED_FEATURE_UNAVAILABLE' && /x .* cancel/.test(error.message),
  );
  assert(!s.calls.includes('projectHostedLandingWithdraw:withdraw'));
});

test('withdraw by submissionId cancels that landing in one call, whatever Lane holds it (friction a0faf3a9)', async t => {
  const s = await setup(t),
    first = await landing(s.f);
  const before = s.calls.length;
  const withdrawn = await s.transport().dispatch('withdraw', { submissionId: first.id });
  assert.equal(withdrawn.result.withdrawn, true);
  assert.equal(withdrawn.result.submissionId, first.id);
  assert.equal(withdrawn.result.laneId, null);
  assert.equal(withdrawn.result.landing.error.code, 'LANDING_CANCELLED');
  assert.deepEqual(withdrawn.result.confirm.next.operationIds, [first.operationId]);
  const mutations = s.calls.slice(before).filter(name => !name.startsWith('projectHostedAgent:'));
  assert.deepEqual(mutations, ['projectHostedLanding:cancel'], 'one existing mutation, no Lane lookup');
  await assert.rejects(
    s.transport().dispatch('withdraw', { submissionId: first.id, laneId: s.f.lane.laneId }),
    /not both/,
  );
});

for (const verb of ['withdraw', 'cancel'])
  test(`SM-C M1: ${verb} settles the turn ledger entry of the landing it ended`, async t => {
    const s = await setup(t),
      first = await landing(s.f);
    const keys = ['XDG_STATE_HOME', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID'];
    const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    const state = mkdtempSync(join(tmpdir(), 'forge-withdraw-ledger-'));
    process.env.XDG_STATE_HOME = state;
    process.env.CLAUDE_CODE_SESSION_ID = `synthetic-session-${first.id}`;
    delete process.env.CODEX_THREAD_ID;
    t.after(() => {
      for (const [key, value] of Object.entries(before))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      rmSync(state, { recursive: true, force: true });
    });
    const session = process.env.CLAUDE_CODE_SESSION_ID;
    // A live waiter and an unrelated landing: only the ended landing leaves the ledger.
    recordTurnWork({
      id: first.operationId,
      kind: 'landing',
      root: state,
      input: { operationIds: [first.operationId] },
      pid: null,
    });
    const other = crypto.randomUUID();
    recordTurnWork({ id: other, kind: 'landing', root: state, input: { operationIds: [other] }, pid: null });
    assert.equal(readTurnLedger(session).work.length, 2);
    const reply = await s.transport().dispatch(verb, { submissionId: first.id });
    assert.ok(reply.result);
    assert.deepEqual(
      readTurnLedger(session).work.map(work => work.id),
      [other],
      'the ended landing is settled; the other stays',
    );
  });
