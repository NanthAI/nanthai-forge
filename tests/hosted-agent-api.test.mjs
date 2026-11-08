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
  'projectHostedComposeSelection',
  'projectHostedComposeJobs',
  'projectHostedSync',
  'projectHostedSyncJobs',
  'projectHostedLanding',
  'projectHostedLandingDesired',
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
const laneHistory = await import(moduleUrl('../convex/projectHostedLaneHistory.ts'));
const revertNotice = await import(moduleUrl('../convex/projectHostedRevertNotice.ts'));
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
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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
  assert.equal(first.result.phase, 'finish');
  assert.equal(first.result.submission.preparing, true);
  const composeOperationId = first.result.composeOperationId;
  // The scheduled controller owns source completion after this requester disconnects.
  await s.f.drain();
  s.lose('projectHostedLandingDesired:submit');
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

test('incident replay 8dbccdfb: a CLI revert lands as compensating and tells the reverted Lane and Intent', async t => {
  // Sweep B 2026-11-07: `revert` then `land` of the reverse Lane landed (ae664d46), but the CLI sent no
  // revertOf, so the original Lane got no board note, needsFix stayed empty and lane-history still
  // said the landing was current.
  const s = await setup(t),
    receipt = await s.f.landOriginal(),
    original = s.f.lane.laneId;
  const command = {
    target: { kind: 'receipt', receiptId: receipt.id },
    message: 'Revert the replayed change',
  };
  const progress = await s.transport().dispatch('revert', command);
  const state = JSON.parse(
    [...s.f.tables.projectHostedSyncs.values()].find(row => row.operationId === progress.operationId).value,
  );
  await s.f.publishRevert(await s.f.workRevert(state.request));
  const reverse = (await s.transport().dispatch('revert', command)).result.outcome.result.lane;
  const land = { laneId: reverse.laneId, check: { checkId: s.f.rawChecks.checkId } };
  const first = await s.transport().dispatch('finish', land);
  assert.equal(first.result.phase, 'finish');
  await s.f.drain();
  await s.f.passChecks();
  await s.f.drain();
  const rows = [...s.f.tables.projectHostedLandingRequests.values()];
  const row = rows.find(r => r.revertOf === receipt.id);
  assert(row, 'the CLI landing records the receipt it reverts');
  assert.equal(row.phase, 'landed');
  const revertReceipt = JSON.parse(row.value).acceptance.receiptId;
  // The reverted Lane hears it on its next action: one board note naming the reopen command.
  const notes = [...s.f.tables.projectBoardMessages.values()].filter(m => m.targetKey === `lane:${original}`);
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, new RegExp(`start --reopen '\\{"laneId":"${original}"\\}'`));
  assert.equal(notes[0].fromLaneId, reverse.laneId);
  // Lane status and lane-history say reverted, not current.
  const history = JSON.parse(
    await s.f.tx('laneHistory', laneHistory.read, { projectId: s.f.projectId, laneId: original }),
  );
  assert.equal(history.landing.receiptId, receipt.id);
  assert.equal(history.landing.current, false);
  assert.equal(history.landing.revertedBy.receiptId, revertReceipt);
  // Now and CLI status carry a reverted needsFix on the original Intent, with the same reopen command.
  const project = s.f.tables.hostedProjects.get(s.f.projectId);
  const notices = Object.entries(project.needsFix ?? {}).map(([id, v]) => ({ id, ...JSON.parse(v) }));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].state, 'reverted');
  assert.equal(notices[0].receiptId, receipt.id);
  assert.equal(notices[0].revertReceiptId, revertReceipt);
  assert.equal(notices[0].undo, `nforge agent ROOT start --reopen '{"laneId":"${original}"}'`);
  // Replaying the notice writes nothing new.
  const before = s.f.tables.projectBoardMessages.size;
  await s.f.tx('revertNoticeReplay', revertNotice.accepted, {
    projectId: s.f.projectId,
    receiptId: revertReceipt,
    revertOf: receipt.id,
    actor: 'owner',
  });
  assert.equal(s.f.tables.projectBoardMessages.size, before);
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
  // Split save (save-settle-background, fea47345 C): the save returns once it is submitted and the
  // server settles it (its job never runs in this fixture); the next command reads the outcome.
  const replaying = s.transport();
  replaying.waitUntil = Date.now();
  const saved = await replaying.dispatch('save', command);
  assert.equal(saved.result.status, 'settling');
  assert.equal(saved.result.operationId, saved.operationId);
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
