// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  symlinkSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { runPreflight } from '../dist/agent-preflight.js';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { hostedAgentAddress } from '../dist/hosted-agent-cli.js';
import { hostedAgentActions } from '../dist/hosted-agent-contract.js';
import { hostedAgentRoot } from '../dist/hosted-agent-journal.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { recordLane } from '../dist/lane-registry.js';
import { laneCheckoutRoot } from '../dist/hosted-lane-location.js';
const errorCode = expected => error => error.code === expected;

test('fresh open uses only its two checkout authorization reads and replay rechecks Lane access', async t => {
  const s = agentFixture(t),
    operationId = randomUUID();
  await s.transport().dispatch('open', { laneId: s.lane.laneId, operationId });
  assert.equal(s.calls.filter(call => call.name === 'projectHostedLanes:select').length, 2);
  await s.transport().dispatch('open', { laneId: s.lane.laneId, operationId });
  assert.equal(s.calls.filter(call => call.name === 'projectHostedLanes:select').length, 3);
  // Capabilities still succeed; the selected Lane itself can no longer be read.
  const query = s.exchange.client.query;
  s.exchange.client.query = (reference, args) => {
    if (args.laneId === s.lane.laneId) throw new Error('Lane access revoked');
    return query(reference, args);
  };
  await assert.rejects(
    s.transport().dispatch('open', { laneId: s.lane.laneId, operationId }),
    errorCode('HOSTED_ACTION_FAILED'),
  );
});

test('open rechecks Lane access before adopting a nested checkout', async t => {
  const s = agentFixture(t),
    previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(s.root, '..', 'registry');
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const nested = join(`${s.root}.forge-client`, 'lanes', s.lane.laneId),
    target = join(s.root, '..', 'adopted');
  mkdirSync(join(nested, '..'), { recursive: true });
  renameSync(s.root, nested);
  recordLane({ laneId: s.lane.laneId, root: nested, ...s.address });
  const query = s.exchange.client.query;
  s.exchange.client.query = (reference, args) => {
    if (args.laneId === s.lane.laneId) throw new Error('Lane access revoked');
    return query(reference, args);
  };
  await assert.rejects(
    new HostedAgentTransport(target, s.address, s.exchange).dispatch('open', { laneId: s.lane.laneId }),
    errorCode('HOSTED_ACTION_FAILED'),
  );
  assert(existsSync(nested), 'an unauthorized open must not move the retained checkout');
  assert.equal(existsSync(target), false);
});
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
      finish: {
        laneId: s.lane.laneId,
        message: 'Supplied subject\n\nCo-Authored-By: Synthetic Sol <noreply@openai.com>',
      },
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
    // A save answered from its settled receipt says it replayed (Issue ca49dc6c); all else is the same.
    if (action === 'save') {
      const { replayed, ...rest } = again.result;
      assert.equal(replayed, true);
      assert.deepEqual(first.result, rest);
    } else assert.deepEqual(first.result, again.result);
    if (api !== 'download') {
      const before = firstCalls.filter(call => call.name === api).at(-1);
      const after = s.calls.filter(call => call.name === api).at(-1);
      assert.deepEqual(before.args, after.args);
    }
    assert(!existsSync(join(s.root, '.forge', 'native')));
    assert(!existsSync(join(s.root, '.forge', 'work.json')));
    if (action === 'finish') {
      assert.equal(first.result.submission.request.agent, true);
      assert.equal(first.result.submission.request.message, command.message);
    }
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
    command = {
      laneId: s.lane.laneId,
      message: 'Pending subject\n\nCo-Authored-By: Synthetic Sol <noreply@openai.com>',
    };
  s.pending(true);
  const first = await s.transport().dispatch('finish', command);
  assert.equal(first.result.phase, 'finish');
  assert.equal(first.result.submission.phase, 'composing');
  assert.equal(first.result.submission.preparing, true);
  const desired = s.calls.find(c => c.name === 'projectHostedLandingDesired:submit');
  assert.equal(JSON.parse(desired.args.request).message, command.message);
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
      'projectHostedLandingDesired:submit', // Reconcile the original outcome before probing source work.
      'projectHostedCompose:progress',
    ],
  );
  assert.deepEqual(next.result.submission, first.result.submission);
  assert.equal(next.result.submission.request.finish.composeOperationId, first.result.composeOperationId);
  // A long queue outlives any poller: the receipt names the one wake-driven command that resumes it.
  for (const receipt of [first, next])
    assert.equal(
      receipt.result.waitCommand.replace(/^nforge agent '[^']*\/client'/, 'nforge agent ROOT'),
      `nforge agent ROOT wait '{"operationIds":["${first.operationId}"],"until":"acceptance"}'`,
    );
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

const composePrepares = s =>
  s.calls
    .filter(call => call.name === 'projectHostedCompose:prepare')
    .map(call => JSON.parse(call.args.request))
    .map(request => ({ operationId: request.operationId, head: request.expectedMain.head }));

test('incident replay b8c0a4f6: a land --save refused CHANNEL_CHANGED recomposes on the moved main under the same operation', async t => {
  const s = agentFixture(t),
    operationId = randomUUID(),
    before = s.main.head;
  s.pinMain(true);
  // Main moves between the compose request's main read and its prepare: the incident's first refusal.
  s.moveMainBefore('projectHostedCompose:prepare');
  const command = { operationId, laneId: s.lane.laneId };
  const landed = await s.transport().dispatch('finish', command);
  assert.equal(landed.operationId, operationId);
  assert.equal(landed.result.phase, 'finish');
  assert.equal(landed.result.submission.request.expectedMain.head, s.main.head, 'lands on the new main');
  const prepares = composePrepares(s);
  assert.deepEqual(
    prepares.map(p => p.head),
    [before, s.main.head],
    'the stale request once (refused, nothing began), then the current main',
  );
  assert.equal(prepares[1].operationId, prepares[0].operationId, 'the same compose operation');
  assert.equal(landed.result.composeOperationId, prepares[0].operationId);
});

test('incident replay b8c0a4f6: main moving on every try drops the stale request, and the first replay lands', async t => {
  const s = agentFixture(t),
    operationId = randomUUID();
  s.pinMain(true);
  s.moveMainBefore('projectHostedCompose:prepare', 3);
  const command = { operationId, laneId: s.lane.laneId };
  await assert.rejects(s.transport().dispatch('finish', command), error => {
    assert.equal(error.code, 'CHANNEL_CHANGED');
    assert.match(error.message, /a replay of this same operation builds on the new main/);
    return true;
  });
  assert.equal(composePrepares(s).length, 3, 'bounded: three tries per call');
  // The incident replayed this identical request 8 times; each got the same refusal. Now the
  // retained stale request is gone, so the first replay composes on the current main and lands.
  const replay = await s.transport().dispatch('finish', command);
  assert.equal(replay.operationId, operationId);
  assert.equal(replay.result.submission.request.expectedMain.head, s.main.head);
  const prepares = composePrepares(s);
  assert.equal(prepares.length, 4);
  assert.equal(new Set(prepares.map(p => p.operationId)).size, 1, 'one compose operation throughout');
});

test('a landing enqueue refused because main moved after compose composes again on the new main', async t => {
  const s = agentFixture(t),
    operationId = randomUUID();
  s.pinMain(true);
  s.moveMainBefore('projectHostedLanding:enqueue');
  const landed = await s.transport().dispatch('finish', { operationId, laneId: s.lane.laneId });
  assert.equal(landed.result.phase, 'finish');
  assert.equal(landed.result.submission.request.expectedMain.head, s.main.head);
  const prepares = composePrepares(s);
  assert.equal(prepares.length, 2, 'composed twice');
  assert.notEqual(
    prepares[1].operationId,
    prepares[0].operationId,
    'the first compose is terminal: a new one',
  );
  assert.equal(prepares[1].head, s.main.head);
  assert.equal(landed.result.composeOperationId, prepares[1].operationId);
  assert.equal(s.calls.filter(call => call.name === 'projectHostedLanding:enqueue').length, 2);
});

test('a healthy land --save makes no extra calls for the main-pin recovery', async t => {
  const plain = agentFixture(t),
    pinned = agentFixture(t);
  pinned.pinMain(true);
  await plain.transport().dispatch('finish', { laneId: plain.lane.laneId });
  await pinned.transport().dispatch('finish', { laneId: pinned.lane.laneId });
  assert.deepEqual(
    pinned.calls.map(call => call.name),
    plain.calls.map(call => call.name),
  );
});

test('a start refused because main moved rebuilds on the new main under the same operation', async t => {
  const s = agentFixture(t),
    operationId = randomUUID();
  s.pinMain(true);
  s.moveMainBefore('projectHostedStart:start');
  await s.transport().dispatch('start', { operationId, outcome: 'Moved main' });
  const starts = s.calls.filter(call => call.name === 'projectHostedStart:start').map(call => call.args);
  assert.equal(starts.length, 2);
  assert.deepEqual(
    starts.map(start => [start.operationId, start.expectedMain.head]),
    [
      [operationId, starts[0].expectedMain.head],
      [operationId, s.main.head],
    ],
  );
  assert.notEqual(starts[0].expectedMain.head, s.main.head);
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

test('save from the project folder names the open Lane checkout (friction fa11c1bc, d05335ff, cb3ce3e4)', async t => {
  const s = agentFixture(t),
    previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(s.root, '..', 'registry');
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  recordLane({ laneId: s.lane.laneId, root: s.root, ...s.address });
  const folder = join(s.root, '..', 'project-folder');
  mkdirSync(folder, { recursive: true });
  const other = new HostedAgentTransport(folder, s.address, s.exchange);
  await assert.rejects(other.dispatch('save', { laneId: s.lane.laneId }), error => {
    assert.equal(error.code, 'HOSTED_CHECKOUT_REQUIRED');
    assert.equal(error.recovery.root, s.root);
    assert(error.message.includes(s.root));
    return true;
  });
  // A Lane this machine has not opened keeps the plain message and names no path.
  await assert.rejects(other.dispatch('save', { laneId: randomUUID() }), error => {
    assert.equal(error.code, 'HOSTED_CHECKOUT_REQUIRED');
    assert.equal(error.recovery, undefined);
    return true;
  });
});

// Issue 681ee3d4 (weaker-model trial: 7 of 20 task runs): a laneId given from the project folder runs in
// that Lane's own checkout instead of refusing; reads keep ROOT, and an unknown Lane still refuses.
test('a laneId from the project folder runs in the Lane folder this machine has open', async t => {
  const s = agentFixture(t),
    previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(s.root, '..', 'registry');
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  recordLane({ laneId: s.lane.laneId, root: s.root, ...s.address });
  const folder = join(s.root, '..', 'project-folder');
  mkdirSync(folder, { recursive: true });
  for (const action of ['save', 'sync', 'preflight', 'ack', 'finish'])
    assert.equal(laneCheckoutRoot(folder, action, s.lane.laneId, s.address), s.root, action);
  assert.equal(laneCheckoutRoot(folder, 'status', s.lane.laneId, s.address), null, 'reads keep ROOT');
  assert.equal(laneCheckoutRoot(s.root, 'save', s.lane.laneId, s.address), null, 'already there');
  assert.equal(laneCheckoutRoot(folder, 'save', randomUUID(), s.address), null, 'not open here');
  const elsewhere = { ...s.address, projectId: 'other-project' };
  assert.equal(laneCheckoutRoot(folder, 'save', s.lane.laneId, elsewhere), null, 'another project');
  // From that folder the Lane check passes (the project folder refuses, as the test above shows).
  const here = laneCheckoutRoot(folder, 'save', s.lane.laneId, s.address);
  const outcome = await new HostedAgentTransport(here, s.address, s.exchange)
    .dispatch('save', { laneId: s.lane.laneId })
    .catch(error => error);
  assert.notEqual(outcome?.code, 'HOSTED_CHECKOUT_REQUIRED');
});

test('sync from the project folder refuses before any server call and names the Lane checkout (friction d467b644)', async t => {
  const s = agentFixture(t),
    previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(s.root, '..', 'registry');
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  });
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  recordLane({ laneId: s.lane.laneId, root: s.root, ...s.address });
  const folder = join(s.root, '..', 'project-folder');
  mkdirSync(folder, { recursive: true });
  const other = new HostedAgentTransport(folder, s.address, s.exchange);
  const before = s.calls.filter(call => /Sync/.test(call.name)).length;
  await assert.rejects(other.dispatch('sync', { laneId: s.lane.laneId }), error => {
    assert.equal(error.code, 'HOSTED_CHECKOUT_REQUIRED');
    assert.equal(error.recovery.root, s.root);
    assert(error.message.includes(s.root));
    return true;
  });
  assert.equal(
    s.calls.filter(call => /Sync/.test(call.name)).length,
    before,
    'the server Lane is not advanced',
  );
});

test('an over-long landing message is refused before any server call (friction d8d357c2)', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  writeFileSync(join(s.root, 'draft.txt'), 'Unsaved draft');
  const before = s.calls.length;
  // 1,300 bytes, as in the dogfood case; multi-byte text counts in UTF-8 bytes.
  for (const message of ['m'.repeat(1300), 'é'.repeat(600)])
    await assert.rejects(s.transport().dispatch('finish', { laneId: s.lane.laneId, message }), error => {
      assert.equal(error.code, 'LANDING_MESSAGE_TOO_LARGE');
      assert.match(error.message, /1024 UTF-8 bytes; this one has at least \d+/);
      return true;
    });
  assert.equal(s.calls.length, before, 'no capability read, save or compose');
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

test('hosted finish preserves a passing preflight for an equivalent source tree under another saved head', async t => {
  const s = agentFixture(t);
  s.caps.agentDefaults = effectiveAgentDefaults();
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const marker = readHostedLaneCheckout(s.root);
  // A previous State of this empty source differs only in its metadata/head.
  const receipt = runPreflight(
    s.root,
    s.lane.laneId,
    'f'.repeat(64),
    {
      status: 'planned',
      scope: 'none',
      reason: 'empty source',
      tests: [],
      estimateMinutes: 0,
      command: null,
    },
    marker.tree,
  );
  assert.notEqual(receipt.head, marker.selection.head);
  const result = await s.transport().dispatch('finish', { laneId: s.lane.laneId });
  assert.equal(result.result.defaults.preflight.status, 'passed');
});

test('landing-message negotiation reuses discovery and retains legacy request shapes on older deployments', async t => {
  const s = agentFixture(t);
  delete s.caps.landingMessageVersion;
  const command = {
    laneId: s.lane.laneId,
    message: 'Legacy-compatible subject\n\nCo-Authored-By: Synthetic Sol <noreply@openai.com>',
  };
  const first = await s.transport().dispatch('finish', command);
  assert.equal(s.calls.filter(c => c.name === 'projectHostedAgent:capabilities').length, 1);
  const queued = s.calls.find(c => c.name === 'projectHostedLanding:enqueue');
  assert.equal('message' in JSON.parse(queued.args.request), false);
  const original = s.requests.get(first.result.composeOperationId);
  assert.equal(
    original.message,
    command.message,
    'legacy finish still carries the message through its original composition',
  );
});
