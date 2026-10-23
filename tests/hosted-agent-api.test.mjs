// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { revertFixture, synthetic } from './hosted-revert-fixture.mjs';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { digest } from '../dist/hash.js';
const names = [
  'projectHostedAgent',
  'projectHostedChannels',
  'projectHostedLanes',
  'projectObjectDownloads',
  'projectHostedCompose',
  'projectHostedComposeJobs',
  'projectHostedSync',
  'projectHostedSyncJobs',
  'projectHostedLanding',
  'projectHostedFinish',
  'projectHostedCheckDefinitions',
  'projectHostedChecks',
  'projectHostedLifecycle',
  'projectHostedStart',
  'projectHostedSaves',
  'projectHostedSaveJobs',
];
const modules = Object.fromEntries(
  await Promise.all(names.map(async name => [name, await import(moduleUrl(`../convex/${name}.ts`))])),
);
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
async function setup(t) {
  const f = await revertFixture(t),
    directory = mkdtempSync(join(tmpdir(), 'forge-agent-api-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'client'),
    address = { url: 'https://fixture.invalid', projectId: f.projectId },
    calls = [];
  let lost = null;
  const invoke = async (ref, args) => {
    const name = getFunctionName(ref),
      [module, member] = name.split(':');
    assert(modules[module]?.[member], `Only synthetic registered API handlers: ${name}`);
    calls.push({ name, args: structuredClone(args) });
    let result;
    try {
      result = await f.tx(`agent:${name}`, modules[module][member], args);
    } catch (error) {
      t.diagnostic(`Synthetic handler ${name}: ${error.message}`);
      throw error;
    }
    if (name === lost) {
      lost = null;
      throw new Error('Synthetic reply lost after transaction');
    }
    return result;
  };
  const exchange = {
    projectId: f.projectId,
    client: { query: invoke, mutation: invoke },
    upload: async (pin, value) => {
      assert.equal(digest(value), pin.sha256);
      f.c.put(value);
      return {};
    },
    uploadFile: async (pin, _directory, file) => {
      const bytes = readFileSync(join(_directory, file));
      assert.equal(digest(bytes), pin.sha256);
      f.c.put(bytes);
      return {};
    },
    missing: async pins => pins.filter(pin => !f.c.objects.has(pin.sha256)).map(pin => pin.sha256),
    objects: async ids => ids.map(sha256 => ({ sha256, size: f.c.objects.get(sha256).length })),
    downloadToFile: async (pin, path) => writeFileSync(path, f.c.objects.get(pin.sha256)),
    downloadBatch: async pins => pins.map(pin => f.c.objects.get(pin.sha256)),
    prepareDownloads: async () => {},
  };
  return {
    f,
    root,
    calls,
    transport: () => new HostedAgentTransport(root, address, exchange),
    lose: name => {
      lost = name;
    },
  };
}

test('transport stages real composition pages, resumes original source work and enqueues real agent finish with exact check pins', async t => {
  const s = await setup(t),
    command = { laneId: s.f.lane.laneId, check: { checkId: s.f.rawChecks.checkId } };
  const first = await s.transport().dispatch('finish', command);
  assert.equal(first.result.phase, 'compose');
  const composeOperationId = first.result.composeOperationId;
  const output = await s.f.c.work({ request: { operationId: composeOperationId } });
  await s.f.c.publish(output);
  s.lose('projectHostedLanding:enqueue');
  await assert.rejects(
    s.transport().dispatch('finish', command),
    error => error.code === 'HOSTED_ACTION_FAILED',
  );
  const final = await s.transport().dispatch('finish', command);
  assert.equal(final.operationId, first.operationId);
  assert.equal(final.result.phase, 'finish');
  const submission = final.result.submission;
  assert.equal(submission.request.agent, true);
  assert.equal(submission.request.check.checkId, s.f.rawChecks.checkId);
  assert.equal(submission.request.finish.composeOperationId, composeOperationId);
  const attempt = [...s.f.tables.projectHostedLandingAttempts.values()].find(
    row => row.attemptId === submission.firstAttemptId,
  );
  assert.equal(JSON.parse(attempt.value).actor.kind, 'agent');
  assert.equal(s.f.tables.projectHostedLandingRequests.size, 1);
  const before = s.f.pending().length;
  const observed = await s.transport().dispatch('observe', { submissionId: submission.id });
  assert.equal(observed.result.submission.id, submission.id);
  assert.equal(s.f.pending().length, before);
});

test('revert uses the exact acceptance receipt, retains sync UUID after lost submit and returns a composable Lane', async t => {
  const s = await setup(t),
    receipt = await s.f.landOriginal();
  const command = { target: { kind: 'receipt', receiptId: receipt.id }, message: 'Compensate actual delta' };
  s.lose('projectHostedSyncJobs:submit');
  await assert.rejects(
    s.transport().dispatch('revert', command),
    error => error.code === 'HOSTED_ACTION_FAILED',
  );
  const progress = await s.transport().dispatch('revert', command);
  const state = JSON.parse(
    [...s.f.tables.projectHostedSyncs.values()].find(row => row.operationId === progress.operationId).value,
  );
  assert.equal(state.request.target.receiptId, receipt.id);
  const output = await s.f.workRevert(state.request);
  await s.f.publishRevert(output);
  const result = await s.transport().dispatch('revert', command);
  assert.equal(result.result.outcome.status, 'completed');
  const lane = result.result.outcome.result.lane;
  const composed = await s.transport().dispatch('compose', { laneId: lane.laneId });
  assert.equal(composed.result.status, 'submitted');
});

test('real source save uses opened marker, direct bytes and same request after lost response', async t => {
  const s = await setup(t);
  await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
  const command = { message: 'Synthetic delta' };
  writeFileSync(join(s.root, 'added.txt'), 'new bytes\n');
  s.lose('projectHostedSaves:prepare');
  await assert.rejects(
    s.transport().dispatch('save', command),
    error => error.code === 'HOSTED_ACTION_FAILED',
  );
  const saved = await s.transport().dispatch('save', command);
  assert.equal(saved.result.status, 'submitted');
  const requests = s.calls
    .filter(call => call.name === 'projectHostedSaves:prepare')
    .map(call => call.args.request);
  assert.equal(requests[0], requests[1]);
  assert.equal(readFileSync(join(s.root, 'added.txt'), 'utf8'), 'new bytes\n');
});

test('remote Lane abandonment/reopening uses canonical lifecycle API without a checkout', async t => {
  const s = await setup(t),
    laneId = s.f.lane.laneId;
  const abandoned = await s.transport().dispatch('abandon', { laneId, reason: 'Superseded synthetic work' });
  assert.equal(abandoned.result.status, 'applied');
  assert.equal(abandoned.result.lane.state, 'abandoned');
  const reopened = await s.transport().dispatch('reopen', { laneId });
  assert.equal(reopened.result.lane.state, 'active');
  assert.equal(reopened.result.lane.head, abandoned.result.lane.head);
});

test('landing cancellation reconciles a lost reply through the real API without changing Lane or check lifecycle', async t => {
  const s = await setup(t),
    request = s.f.request(),
    submission = await s.f.enqueue(request),
    before = await s.f.readLane(s.f.lane.laneId);
  s.lose('projectHostedLanding:cancel');
  const command = { submissionId: submission.id };
  await assert.rejects(s.transport().dispatch('cancel', command), { code: 'HOSTED_ACTION_FAILED' });
  const result = await s.transport().dispatch('cancel', command);
  assert.equal(result.result.error.code, 'LANDING_CANCELLED');
  assert.deepEqual(await s.transport().dispatch('cancel', command), result);
  assert.deepEqual(await s.f.readLane(s.f.lane.laneId), before);
  assert(
    s.calls
      .filter(c => c.name !== 'projectHostedAgent:capabilities')
      .every(c => c.name === 'projectHostedLanding:cancel'),
  );
  await s.f.drain();
  await s.f.passChecks();
  await s.f.drain();
  assert.equal(s.f.tables.projectHostedAcceptances.size, 0);
});
