// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { hostedAgentAddress } from '../dist/hosted-agent-cli.js';
import { hostedAgentActions } from '../dist/hosted-agent-contract.js';
import { hostedAgentRoot } from '../dist/hosted-agent-journal.js';
const errorCode = expected => error => error.code === expected;
for (const [action, api] of [
  ['start', 'projectHostedStart:start'],
  ['open', 'download'],
  ['save', 'projectHostedSaves:prepare'],
  ['compose', 'projectHostedComposeJobs:submit'],
  ['sync', 'projectHostedSyncJobs:submit'],
  ['check', 'projectHostedChecks:enqueue'],
  ['finish', 'projectHostedLanding:enqueue'],
  ['cancel', 'projectHostedLanding:cancel'],
  ['revert', 'projectHostedSyncJobs:submit'],
  ['abandon', 'projectHostedLifecycle:transition'],
])
  test(`${action}: unknown response retains UUID, pins and original result without an owner/listener`, async t => {
    const s = agentFixture(t);
    if (['save', 'abandon'].includes(action)) await s.transport().dispatch('open', { laneId: s.lane.laneId });
    const command = {
      start: { outcome: 'Synthetic hosted agent' },
      open: { laneId: s.lane.laneId },
      save: { message: 'Clean save' },
      compose: { laneId: s.lane.laneId },
      sync: { laneId: s.lane.laneId, apply: false },
      check: { candidateId: s.candidate.id, checkId: randomUUID() },
      finish: { laneId: s.lane.laneId },
      cancel: { submissionId: randomUUID() },
      revert: { target: { kind: 'receipt', receiptId: randomUUID() } },
      abandon: { reason: 'Superseded' },
    }[action];
    s.lose(api);
    await assert.rejects(s.transport().dispatch(action, command), errorCode('HOSTED_ACTION_FAILED'));
    const firstCalls = structuredClone(s.calls);
    const first = await s.transport().dispatch(action, command);
    const again = await s.transport().dispatch(action, command);
    assert.equal(first.operationId, again.operationId);
    assert.deepEqual(first.result, again.result);
    if (api !== 'download') {
      const before = firstCalls.filter(call => call.name === api).at(-1);
      const after = s.calls.filter(call => call.name === api).at(-1);
      assert.deepEqual(before.args, after.args);
    }
    assert(!existsSync(join(s.root, '.forge', 'native')));
    assert(!existsSync(join(s.root, '.forge', 'work.json')));
    if (action === 'finish') assert.equal(first.result.submission.request.agent, true);
  });

test('capability discovery and status observations perform finite reads and never wake a worker', async t => {
  const s = agentFixture(t);
  assert.deepEqual((await s.transport().dispatch('capabilities', {})).result.actions, hostedAgentActions);
  for (const command of [
    { laneId: s.lane.laneId },
    { submissionId: randomUUID(), version: 2 },
    { runId: randomUUID() },
    ...['save', 'compose', 'sync', 'revert', 'lifecycle'].map(kind => ({ kind, operationId: randomUUID() })),
  ]) {
    const previous = s.calls.length;
    await s.transport().dispatch('status', command);
    assert.equal(s.calls.length - previous, 2);
  }
  assert(s.calls.every(call => !/submit|enqueue|resume|dispatch|transition/.test(call.name)));
  assert(!existsSync(`${s.root}.forge-client`));
});

test('pending source and finish steps return promptly and retain all child operations across reconnect', async t => {
  const s = agentFixture(t),
    command = { laneId: s.lane.laneId };
  s.pending(true);
  const first = await s.transport().dispatch('finish', command);
  assert.equal(first.result.phase, 'finish');
  assert.equal(first.result.submission.phase, 'composing');
  assert.equal(first.result.submission.preparing, true);
  const count = s.calls.length;
  assert(!s.calls.some(call => call.name === 'projectHostedLanding:enqueue'));
  s.pending(false);
  const next = await s.transport().dispatch('finish', command);
  assert.equal(next.operationId, first.operationId);
  assert.equal(next.result.composeOperationId, first.result.composeOperationId);
  assert.equal(next.result.phase, 'finish');
  assert.deepEqual(
    s.calls.slice(count).map(call => call.name),
    [
      'projectHostedAgent:capabilities',
      'projectHostedCompose:progress', // One selected read detects a failed source child.
      'projectHostedLandingDesired:submit',
    ],
  );
  assert.deepEqual(next.result.submission, first.result.submission);
  assert.equal(next.result.submission.request.finish.composeOperationId, first.result.composeOperationId);
});

test('changed explicit operation payload fails, while later main and Lane movement cannot replace retained pins', async t => {
  const s = agentFixture(t),
    operationId = randomUUID();
  s.lose('projectHostedStart:start');
  await assert.rejects(s.transport().dispatch('start', { operationId, outcome: 'Original' }));
  const original = s.calls.find(call => call.name === 'projectHostedStart:start').args;
  s.main.head = 'f'.repeat(64);
  s.main.receipt.id = randomUUID();
  await s.transport().dispatch('start', { operationId, outcome: 'Original' });
  assert.deepEqual(s.calls.filter(call => call.name === 'projectHostedStart:start').at(-1).args, original);
  await assert.rejects(
    s.transport().dispatch('start', { operationId, outcome: 'Changed' }),
    errorCode('WORK_OPERATION_CHANGED'),
  );
});

test('unsupported and malformed hosted commands never fall through to a native owner or echo private input', async t => {
  const s = agentFixture(t);
  for (const action of ['accept', 'private-action', 'wait'])
    await assert.rejects(s.transport().dispatch(action, {}), errorCode('HOSTED_ACTION_UNSUPPORTED'));
  await assert.rejects(
    s.transport().dispatch('start', { outcome: 'Secret', token: 'private-value' }),
    error => error.code === 'BAD_ARGUMENT' && !error.message.includes('private-value'),
  );
  assert.equal(s.calls.length, 0);
  s.caps.actions = ['capabilities'];
  await assert.rejects(
    s.transport().dispatch('start', { outcome: 'Denied' }),
    errorCode('HOSTED_ACTION_UNSUPPORTED'),
  );
  assert(!existsSync(s.root));
});

test('cached checkout retries recheck access, preserve dirty files and reject a different account', async t => {
  const s = agentFixture(t),
    command = { laneId: s.lane.laneId };
  const first = await s.transport().dispatch('open', command);
  writeFileSync(join(s.root, 'draft.txt'), 'Newer draft');
  await s.transport().dispatch('open', command);
  assert.equal(readFileSync(join(s.root, 'draft.txt'), 'utf8'), 'Newer draft');
  s.allow(false);
  await assert.rejects(s.transport().dispatch('open', command), errorCode('PROJECT_UNAVAILABLE'));
  s.allow(true);
  s.caps.actor = 'different-account';
  await assert.rejects(
    s.transport().dispatch('open', { ...command, operationId: first.operationId }),
    errorCode('WORK_OPERATION_CHANGED'),
  );
});

test('addressing uses explicit project or checkout marker and rejects incomplete/mismatched entry points', async t => {
  const s = agentFixture(t);
  assert.equal(hostedAgentAddress(s.root, {}), null);
  assert.deepEqual(hostedAgentAddress(s.root, s.address), s.address);
  assert.throws(() => hostedAgentAddress(s.root, { projectId: 'project' }), errorCode('BAD_ARGUMENT'));
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  assert.deepEqual(hostedAgentAddress(s.root, {}), s.address);
  assert.throws(
    () => hostedAgentAddress(s.root, { ...s.address, projectId: 'foreign' }),
    errorCode('WORK_OPERATION_CHANGED'),
  );
});

test('journal does not follow a symlinked cache directory', async t => {
  const s = agentFixture(t);
  const other = join(s.root, '..', 'other');
  mkdirSync(other);
  symlinkSync(other, `${s.root}.forge-client`);
  await assert.rejects(s.transport().dispatch('start', { outcome: 'Synthetic' }), errorCode('UNSAFE_PATH'));
  assert.deepEqual(readdirSync(other), []);
});

test('journal is private recovery data and contains no authentication material', async t => {
  const s = agentFixture(t);
  const result = await s.transport().dispatch('start', { outcome: 'Synthetic' });
  const path = join(`${hostedAgentRoot(s.root)}.forge-client`, 'agent', `${result.operationId}.json`);
  const text = readFileSync(path, 'utf8');
  assert.match(text, /start-request/);
  assert(!/FORGE_AUTH_TOKEN|Bearer|credential|token/.test(text));
});

for (const api of ['projectHostedCompose:prepare', 'projectHostedCompose:stage', 'upload'])
  test(`compose recovery after ${api} keeps exact staged selection and metadata`, async t => {
    const s = agentFixture(t),
      command = { laneId: s.lane.laneId };
    s.lose(api);
    await assert.rejects(s.transport().dispatch('compose', command), errorCode('HOSTED_ACTION_FAILED'));
    const original = s.calls.find(call => call.name === 'projectHostedCompose:prepare').args.request;
    s.lane.version++;
    s.lane.sourceVersion++;
    s.main.receipt.id = randomUUID();
    const result = await s.transport().dispatch('compose', command);
    assert.equal(result.result.outcome.status, 'completed');
    assert(
      s.calls
        .filter(call => call.name === 'projectHostedCompose:prepare')
        .every(call => call.args.request === original),
    );
    const request = JSON.parse(original);
    assert.equal(result.operationId, request.operationId);
  });

test('finish rejects attempts to obtain person authority and pins configured check across unknown enqueue', async t => {
  const s = agentFixture(t),
    checkId = randomUUID();
  await assert.rejects(
    s.transport().dispatch('finish', { laneId: s.lane.laneId, agent: false }),
    errorCode('BAD_ARGUMENT'),
  );
  s.lose('projectHostedLanding:enqueue');
  const command = { laneId: s.lane.laneId, check: { checkId } };
  await assert.rejects(s.transport().dispatch('finish', command));
  const original = s.calls.find(call => call.name === 'projectHostedLanding:enqueue').args.request;
  const result = await s.transport().dispatch('finish', command);
  assert.equal(
    s.calls.filter(call => call.name === 'projectHostedLanding:enqueue').at(-1).args.request,
    original,
  );
  assert.equal(result.result.submission.request.agent, true);
  assert.equal(result.result.submission.request.check.checkId, checkId);
});

test('unavailable capability entry point fails explicitly without creating a local owner or journal', async t => {
  const s = agentFixture(t);
  s.exchange.client.query = async () => {
    throw new Error('Missing synthetic entry point');
  };
  await assert.rejects(
    s.transport().dispatch('start', { outcome: 'Synthetic' }),
    error =>
      error.code === 'HOSTED_AGENT_UNAVAILABLE' &&
      /no native owner or local listener fallback/.test(error.message),
  );
  assert(!existsSync(`${s.root}.forge-client`));
});

test('save-first without local source fails clearly instead of silently abandoning unsaved work', async t => {
  const s = agentFixture(t);
  await assert.rejects(
    s.transport().dispatch('abandon', { laneId: s.lane.laneId, reason: 'Synthetic', saveFirst: true }),
    errorCode('HOSTED_CHECKOUT_REQUIRED'),
  );
  assert(!s.calls.some(call => call.name === 'projectHostedLifecycle:transition'));
});

test('finish with explicit saved inputs preserves local drafts without starting a save', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  writeFileSync(join(s.root, 'draft.txt'), 'Unselected local draft');
  const result = await s.transport().dispatch('finish', { inputs: [{ laneId: s.lane.laneId }] });
  assert.equal(result.result.phase, 'finish');
  assert(!s.calls.some(call => call.name === 'projectHostedSaves:prepare'));
  assert.equal(readFileSync(join(s.root, 'draft.txt'), 'utf8'), 'Unselected local draft');
});

test('tests and confirm-tests use the shared hosted action with retained operation pins', async t => {
  const s = agentFixture(t),
    requests = [];
  s.exchange.client.action = async (_ref, input) => {
    const command = JSON.parse(input.request);
    requests.push(command);
    return JSON.stringify({ contract: null, contractVersion: 0, action: command.action });
  };
  const operationId = randomUUID(),
    candidateId = s.candidate.id;
  const command = {
    operationId,
    candidateId,
    runId: randomUUID(),
    expectedHead: s.candidate.result.head,
    expectedVersion: 0,
    tests: [],
  };
  const proposal = await s.transport().dispatch('tests', { candidateId });
  assert.equal(proposal.result.action, 'tests');
  const first = await s.transport().dispatch('confirm-tests', command);
  assert.equal(first.result.action, 'confirm-tests');
  assert.deepEqual(await s.transport().dispatch('confirm-tests', command), first);
  assert.equal(requests[1].operationId, operationId);
  assert.deepEqual(requests[1], requests[2]);
  assert.ok(!existsSync(join(s.root, '.forge', 'native.json')));
});

test('urgent desired finish retains priority while composition is pending', async t => {
  const s = agentFixture(t);
  s.pending(true);
  await s.transport().dispatch('finish', { laneId: s.lane.laneId, priority: 'urgent' });
  const request = JSON.parse(s.calls.find(c => c.name === 'projectHostedLandingDesired:submit').args.request);
  assert.equal(request.priority, 'urgent');
});

test('new priority reads negotiate an old server once; authorization failures never retry', async t => {
  const s = agentFixture(t),
    exchange = s.exchange;
  let rejected = 0;
  const original = exchange.client.query;
  exchange.client.query = async (ref, args) => {
    if (args.priorityInfo !== undefined) {
      rejected++;
      throw new Error(
        'ArgumentValidationError: Object contains extra field `priorityInfo` that is not in the validator.',
      );
    }
    return original(ref, args);
  };
  const transport = s.transport();
  await transport.query('projectHostedLanding:status', { submissionId: randomUUID() });
  await transport.query('projectHostedLanding:status', { submissionId: randomUUID() });
  assert.equal(rejected, 1);
  exchange.client.query = original;
  s.allow(false);
  const fresh = s.transport();
  const before = s.calls.length;
  await assert.rejects(
    fresh.query('projectHostedLanding:status', { submissionId: randomUUID() }),
    errorCode('PROJECT_UNAVAILABLE'),
  );
  assert.equal(s.calls.length, before + 1);
});
