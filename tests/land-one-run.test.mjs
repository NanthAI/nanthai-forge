// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 168e4ed8: one landing is one land run. Cheap refusals come first and together, before any
// preflight or compose; a land that stopped on a transient failure resumes instead of restarting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { submitHostedLand } from '../dist/hosted-land-cli.js';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { readPreflightReceipt } from '../dist/agent-preflight.js';
import { resumableFinish } from '../dist/hosted-agent-finish-identity.js';
import { ForgeError } from '../dist/errors.js';
import { LANDING_MESSAGE_BYTES } from '../dist/landing-message.js';

const requestOf = call => (call.args.request ? JSON.parse(call.args.request) : call.args);

const files = {
  'package.json': '{"type":"module","forge":{"checkRecipe":"forge-standard-v1"}}',
  'scripts/forge-check.mjs': '',
  'tests/docs.test.mjs':
    "import test from 'node:test'; import fs from 'node:fs'; test('document remains readable', () => fs.readFileSync(new URL('../README.md', import.meta.url)));\n",
};
/** A Lane whose land runs a required inline preflight (one test file), on a synthetic server. */
async function requiredLand(t) {
  const s = agentFixture(t, {
    base: { ...files, 'README.md': 'Before\n' },
    lane: { ...files, 'README.md': 'After\n' },
  });
  s.caps.agentDefaults = effectiveAgentDefaults({ preflight: 'require' });
  s.caps.features = ['land-gates'];
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  // The server refuses a compose whose Lane pins moved, as it does after the preflight today.
  const mutate = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectHostedCompose:prepare') {
      const expected = JSON.parse(args.request).inputs?.[0]?.expected;
      if (expected && expected.version !== s.lane.version)
        throw new ForgeError('WORK_STALE', 'Lane pins moved');
    }
    const text = await mutate(ref, args);
    if (getFunctionName(ref) !== 'projectHostedLanding:enqueue') return text;
    const state = JSON.parse(text);
    state.phase = 'landed';
    state.observation = { state: 'landed', pendingReason: null, cause: null };
    state.acceptance = { receiptId: randomUUID(), head: s.lane.head };
    return JSON.stringify(state);
  };
  return s;
}
const quiet = t => t.mock.method(process.stderr, 'write', () => true);
const composed = (s, from) => s.calls.slice(from).some(call => /Compose|Landing/.test(call.name));

test('Item 168e4ed8: stale Lane pins refuse a clean land before its preflight runs', async t => {
  const s = await requiredLand(t);
  quiet(t);
  // Another folder's save moved the server Lane after this checkout was bound.
  s.lane.version++;
  const from = s.calls.length;
  await assert.rejects(
    submitHostedLand(s.root, { operationId: randomUUID(), message: 'Stale pins' }, s.address, s.transport()),
    error => {
      assert.equal(error.code, 'WORK_STALE');
      assert.match(error.message, /Lane pins are stale.*version/);
      assert.match(error.recovery.command, / save /);
      return true;
    },
  );
  assert.equal(readPreflightReceipt(s.root, s.lane.laneId), null, 'no preflight ran');
  assert(!composed(s, from), 'no compose or landing call');
});

test('Item 168e4ed8: a dirty Lane and stale pins are reported together in one pass, before any preflight', async t => {
  const s = await requiredLand(t);
  quiet(t);
  s.lane.version++;
  const transport = s.transport();
  // An edit lands in the folder after the land's save check, before its gates.
  const notice = transport.protectedNotice.bind(transport);
  transport.protectedNotice = async (...args) => {
    writeFileSync(join(s.root, 'README.md'), 'Edited during land\n');
    return notice(...args);
  };
  const from = s.calls.length;
  await assert.rejects(
    submitHostedLand(s.root, { operationId: randomUUID(), message: 'Two refusals' }, s.address, transport),
    error => {
      assert.equal(error.code, 'LANE_DIRTY');
      assert.deepEqual(
        error.recovery.refusals.map(refusal => refusal.code),
        ['LANE_DIRTY', 'WORK_STALE'],
      );
      assert.match(error.message, /2 checks failed/);
      return true;
    },
  );
  assert.equal(readPreflightReceipt(s.root, s.lane.laneId), null, 'no preflight ran');
  assert(!composed(s, from));
});

test('Item 168e4ed8: an over-long landing message refuses before any call or preflight', async t => {
  const s = await requiredLand(t);
  const from = s.calls.length;
  await assert.rejects(
    submitHostedLand(
      s.root,
      { operationId: randomUUID(), message: 'x'.repeat(LANDING_MESSAGE_BYTES + 1) },
      s.address,
      s.transport(),
    ),
    error => error.code === 'LANDING_MESSAGE_TOO_LARGE',
  );
  assert.deepEqual(s.calls.slice(from), [], 'no hosted call');
  assert.equal(readPreflightReceipt(s.root, s.lane.laneId), null);
});

test('Item 168e4ed8: a land under a fresh operationId resumes one that stopped on a transient failure, with no repeated work', async t => {
  const s = await requiredLand(t);
  quiet(t);
  let failing = true;
  const mutate = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) => {
    if (failing && getFunctionName(ref) === 'projectHostedComposeJobs:submit')
      throw new Error('Synthetic server error: internal');
    return mutate(ref, args);
  };
  const first = randomUUID();
  await assert.rejects(
    submitHostedLand(s.root, { operationId: first, message: 'Resume me' }, s.address, s.transport()),
    error => error.code === 'HOSTED_ACTION_FAILED',
  );
  const ran = readPreflightReceipt(s.root, s.lane.laneId);
  assert(ran, 'the first run preflighted');
  const prepared = s.calls.filter(call => call.name === 'projectHostedCompose:prepare');
  failing = false;
  const from = s.calls.length;
  const second = randomUUID();
  const resumed = await submitHostedLand(
    s.root,
    { operationId: second, message: 'Resume me' },
    s.address,
    s.transport(),
  );
  assert.equal(resumed.operationId, first, 'the retained operation continues');
  assert.equal(resumed.result.submission.phase, 'landed');
  assert.equal(readPreflightReceipt(s.root, s.lane.laneId).at, ran.at, 'the preflight did not run again');
  const again = s.calls.slice(from).filter(call => call.name === 'projectHostedCompose:prepare');
  assert(
    again.every(call => requestOf(call).operationId === requestOf(prepared[0]).operationId),
    'compose reconciles its retained operation, never a new one',
  );
  // The fresh id keeps naming the operation it resumed: its own retry never starts a second landing.
  const retried = await submitHostedLand(
    s.root,
    { operationId: second, message: 'Resume me' },
    s.address,
    s.transport(),
  );
  assert.equal(retried.operationId, first);
  assert.equal(
    s.calls
      .filter(call => call.name === 'projectHostedLanding:enqueue' || call.name.endsWith('Desired:submit'))
      .map(call => requestOf(call).operationId)
      .filter(id => id !== first).length,
    0,
    'one landing operation only',
  );
});

test('Item 168e4ed8: a resumed land that then stops on a lasting failure is never resumed again', async t => {
  const s = await requiredLand(t);
  quiet(t);
  let failure = 'Synthetic server error: internal';
  const mutate = s.exchange.client.mutation;
  s.exchange.client.mutation = async (ref, args) => {
    if (failure && getFunctionName(ref) === 'projectHostedComposeJobs:submit') throw new Error(failure);
    return mutate(ref, args);
  };
  const first = randomUUID();
  await assert.rejects(
    submitHostedLand(s.root, { operationId: first, message: 'Lasting stop' }, s.address, s.transport()),
    error => error.code === 'HOSTED_ACTION_FAILED',
  );
  // The resumed run stops on a server limit: no longer transient.
  failure = 'Synthetic: too many bytes read in a single function execution';
  const second = randomUUID();
  await assert.rejects(
    submitHostedLand(s.root, { operationId: second, message: 'Lasting stop' }, s.address, s.transport()),
    error => error.code === 'HOSTED_ACTION_FAILED',
  );
  failure = undefined;
  const third = randomUUID();
  const fresh = await submitHostedLand(
    s.root,
    { operationId: third, message: 'Lasting stop' },
    s.address,
    s.transport(),
  );
  assert.equal(fresh.operationId, third, 'a fresh operation, not the stopped one');
});

test('Item 168e4ed8: only a finish that stopped before submitting on a transient failure or the preflight budget resumes', () => {
  assert.equal(resumableFinish({ 'finish-refused': 'PREFLIGHT_BUDGET_EXCEEDED' }), true);
  assert.equal(resumableFinish({ 'finish-transient': 'server-exception' }), true);
  assert.equal(resumableFinish({ 'finish-refused': 'PREFLIGHT_REQUIRED' }), false);
  assert.equal(resumableFinish({ 'finish-transient': 'connection', 'desired-landing': {} }), false);
  assert.equal(resumableFinish({}), false);
});
