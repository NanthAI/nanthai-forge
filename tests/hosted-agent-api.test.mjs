// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { revertFixture, synthetic } from './hosted-revert-fixture.mjs';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { HostedAgentJournal, hostedAgentDirectory, hostedAgentRoot } from '../dist/hosted-agent-journal.js';
import { readTurnLedger } from '../dist/agent-turn-work.js';
import { digest } from '../dist/hash.js';
import { policyPreset } from '../dist/autonomy-policy.js';
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
  'projectHostedFinishObserve',
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
  const invoke = async (ref, args, actor = 'owner') => {
    const name = getFunctionName(ref),
      [module, member] = name.split(':');
    assert(modules[module]?.[member], `Only synthetic registered API handlers: ${name}`);
    calls.push({ name, args: structuredClone(args) });
    let result;
    try {
      result = await f.tx(`agent:${name}`, modules[module][member], args, actor);
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
    client: {
      query: (ref, args) => invoke(ref, args),
      mutation: (ref, args) => invoke(ref, args),
    },
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
    address,
    calls,
    transport: () => new HostedAgentTransport(root, address, exchange),
    readTransport: (subscribe, actor) =>
      new HostedAgentTransport(
        root,
        address,
        {
          ...exchange,
          client: {
            query: (ref, args) => invoke(ref, args, actor),
            mutation: ref => assert.fail(`Wait must not call mutation ${getFunctionName(ref)}`),
          },
        },
        subscribe,
      ),
    invoke,
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

test('the land receipt retains policy mode, effective mode and pause advice from its existing check-settings read', async t => {
  const s = await setup(t);
  const policy = policyPreset('trusted');
  s.f.patch('hostedProjects', s.f.projectId, {
    autonomyPolicy: { ...policy, acceptance: { ...policy.acceptance, landingMode: 'fast' } },
  });
  const receipt = await s.transport().dispatch('finish', {
    laneId: s.f.lane.laneId,
    check: { checkId: s.f.rawChecks.checkId },
  });
  assert.match(receipt.result.landingAdvice, /^Landing mode: fast; effective: strict\./);
  assert.match(receipt.result.landingAdvice, /no green audit yet/);
  assert.match(receipt.result.landingAdvice, /Land with the second check/);
  assert.equal(s.calls.filter(call => call.name === 'projectHostedCheckDefinitions:current').length, 1);
  assert.equal(
    s.calls.some(call => call.name === 'projectHostedMainAudit:status'),
    false,
  );
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

async function printedRevertWait(t, s) {
  const receipt = await s.f.landOriginal();
  const stderr = process.stderr.write;
  const previousExit = process.exitCode;
  t.after(() => (process.exitCode = previousExit));
  let output = '';
  process.stderr.write = line => ((output += line), true);
  let revert;
  try {
    revert = await hostedAgentCli(
      s.root,
      'revert',
      { target: { kind: 'receipt', receiptId: receipt.id }, message: 'Compensate actual delta' },
      s.address,
      s.transport(),
    );
  } finally {
    process.stderr.write = stderr;
  }
  assert.equal(revert.result.status, 'submitted');
  const printed = /^revert: .*; resume with: nforge agent '([^']+)' wait '([^']+)'$/m.exec(output);
  assert(printed, output);
  assert.equal(printed[1], hostedAgentRoot(s.root));
  const input = JSON.parse(printed[2]);
  assert.deepEqual(input, { operationIds: [revert.operationId] });
  return { input, operationId: revert.operationId };
}

test('friction f0a90837: the printed revert wait follows its original submitted operation without replaying it', async t => {
  const s = await setup(t);
  const { input, operationId } = await printedRevertWait(t, s);
  const read = (parameters, transport = s.readTransport()) =>
    hostedAgentCli(s.root, 'wait', parameters, s.address, transport);
  // An old continuation can outlive its local journal. The same folder can still see the exact revert.
  const journal = join(hostedAgentDirectory(s.root), `${operationId}.json`);
  renameSync(journal, `${journal}.fixture-backup`);
  const withoutJournal = await read({ ...input, timeoutSeconds: 0 });
  assert.equal(withoutJournal.result.status, 'IN_PROGRESS');
  assert.equal(withoutJournal.result.phase, 'revert');
  renameSync(`${journal}.fixture-backup`, journal);

  const pending = await read({ ...input, timeoutSeconds: 0 });
  assert.equal(process.exitCode, 3);
  assert.equal(pending.result.status, 'IN_PROGRESS');
  assert.equal(pending.result.phase, 'revert');
  assert.deepEqual(pending.result.operationIds, [operationId]);

  const state = JSON.parse(
    [...s.f.tables.projectHostedSyncs.values()].find(row => row.operationId === operationId).value,
  );
  const output = await s.f.workRevert(state.request);
  const snapshotBytes = [];
  let subscriptions = 0;
  let closed = false;
  const before = s.calls.length;
  const observed = await read(
    input,
    s.readTransport(() => ({
      onUpdate(ref, args, update, error) {
        assert.equal(getFunctionName(ref), 'projectHostedSync:progress');
        assert.equal(args.operationId, operationId);
        subscriptions++;
        (async () => {
          const snapshot = await s.invoke(ref, args);
          assert.equal(JSON.parse(snapshot).terminal, null);
          snapshotBytes.push(Buffer.byteLength(snapshot));
          update(snapshot);
          await s.f.publishRevert(output);
          const terminal = await s.invoke(ref, args);
          snapshotBytes.push(Buffer.byteLength(terminal));
          update(terminal);
        })().catch(error);
        return () => {};
      },
      async close() {
        closed = true;
      },
    })),
  );
  assert.equal(subscriptions, 1);
  assert(closed);
  assert.deepEqual(
    s.calls.slice(before).map(call => call.name),
    ['projectHostedSync:progress', 'projectHostedSync:progress'],
  );
  assert.equal(process.exitCode, 0);
  assert.equal(observed.operationId, operationId);
  assert.equal(observed.result.status, 'terminal');
  assert.equal(observed.result.outcome.status, 'completed');
  assert.equal(observed.result.outcome.result.operationId, operationId);
  assert.deepEqual(await read({ ...input, timeoutSeconds: 0 }), observed);
  const reads = s.f.counts.filter(count => count.name === 'agent:projectHostedSync:progress');
  assert(reads.length >= 4 && reads.every(count => count.writes === 0 && count.readBytes < 64 * 1024));
  assert(snapshotBytes.every(bytes => bytes < 64 * 1024));
  t.diagnostic(
    `Revert progress snapshots: ${snapshotBytes.join(', ')} reply bytes; maximum ${Math.max(...reads.map(count => count.readBytes))} DB bytes; zero writes`,
  );
});

test('revert wait keeps unknown ids and current authority refusals distinct from pending work', async t => {
  const s = await setup(t);
  const { input, operationId } = await printedRevertWait(t, s);
  const read = (selection, actor) =>
    hostedAgentCli(
      s.root,
      'wait',
      { ...selection, timeoutSeconds: 0 },
      s.address,
      s.readTransport(undefined, actor),
    );
  await assert.rejects(read({ operationIds: [randomUUID()] }), {
    code: 'NOT_FOUND',
    message: /This wait looked in the project of/,
  });
  await assert.rejects(read(input, 'unrelated'), { code: 'PROJECT_UNAVAILABLE' });
  s.f.patch('hostedProjects', s.f.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  const authorityRefusal = error => {
    assert.equal(error.code, 'SOURCE_AUTHORITY_CHANGED');
    assert.equal(error.recovery.next.action, 'revert');
    assert.notEqual(error.recovery.next.operationId, operationId);
    assert.equal(error.recovery.next.message, 'Compensate actual delta');
    return true;
  };
  await assert.rejects(read(input), authorityRefusal);

  const session = randomUUID();
  const originalSession = process.env.FORGE_AGENT_SESSION;
  process.env.FORGE_AGENT_SESSION = session;
  t.after(() => {
    if (originalSession === undefined) delete process.env.FORGE_AGENT_SESSION;
    else process.env.FORGE_AGENT_SESSION = originalSession;
  });
  const journal = join(hostedAgentDirectory(s.root), `${operationId}.json`);
  renameSync(journal, `${journal}.fixture-backup`);
  await assert.rejects(read(input), authorityRefusal);
  assert.deepEqual(readTurnLedger(session).work, [], 'the turn hook cannot resume an old-epoch revert');
});

test('a revert journal without a registered server operation returns the original replay command', async t => {
  const s = await setup(t);
  const operationId = randomUUID();
  const command = { target: { kind: 'receipt', receiptId: randomUUID() }, message: 'Original revert' };
  new HostedAgentJournal(s.root, s.address, 'owner', 'revert', command, operationId);
  await assert.rejects(
    hostedAgentCli(
      s.root,
      'wait',
      { operationIds: [operationId], timeoutSeconds: 0 },
      s.address,
      s.readTransport(),
    ),
    error => {
      assert.equal(error.code, 'NOT_FOUND');
      assert.deepEqual(error.recovery.next, { action: 'revert', ...command, operationId });
      return true;
    },
  );
  assert.deepEqual(
    s.calls.map(call => call.name),
    ['projectHostedSync:progress'],
  );
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
  // The lost reply is replayed inside the same command with the same request (Item 3f76a3df). Split
  // save (save-settle-background, fea47345 C): the save returns once it is submitted and the server
  // settles it (its job never runs in this fixture); the next command reads the outcome.
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

test('a lifecycle change without an operationId is new work each time; the same operationId replays (friction 48366bb2)', async t => {
  const s = await setup(t),
    laneId = s.f.lane.laneId,
    state = async () => (await s.f.readLane(laneId)).state;
  await s.transport().dispatch('complete', { laneId });
  const first = await s.transport().dispatch('reopen', { laneId });
  assert.equal(first.result.lane.state, 'active');
  // The Lane is completed again; an identical reopen with no operationId must reopen it again, not
  // answer from the first reopen's receipt and leave the Lane completed.
  await s.transport().dispatch('complete', { laneId });
  assert.equal(await state(), 'completed');
  const second = await s.transport().dispatch('reopen', { laneId });
  assert.notEqual(second.operationId, first.operationId);
  assert.equal(second.result.lane.state, 'active');
  assert.equal(await state(), 'active');
  // The identical complete is new work too.
  assert.equal((await s.transport().dispatch('complete', { laneId })).result.lane.state, 'completed');
  // A retry that names its operationId still replays the same operation (idempotent by id).
  const named = '6f1d9c5e-2b1a-4c1e-9d7a-3a5b8c9d0e11';
  const reopened = await s.transport().dispatch('reopen', { laneId, operationId: named });
  const replay = await s.transport().dispatch('reopen', { laneId, operationId: named });
  assert.equal(replay.operationId, named);
  assert.deepEqual(replay.result, reopened.result);
  assert.equal(await state(), 'active', 'the replay does not flip the Lane again');
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
