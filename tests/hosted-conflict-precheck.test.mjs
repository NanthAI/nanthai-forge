// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalRoot } from '../dist/root-paths.js';
import { hostedAgentRoot } from '../dist/hosted-agent-journal.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { finishRetryHint } from '../dist/hosted-agent-finish-identity.js';
import { hostedAgentAddress } from '../dist/hosted-agent-cli.js';
import { landSummary } from '../dist/hosted-land-summary.js';
import { getFunctionName } from 'convex/server';
import { registerHostedAgentWorkflow } from '../dist/mcp-hosted-agent.js';

for (const asynchronous of [false, true])
  test(`conflict recovery preserves check-only intent and check pins (async=${asynchronous})`, async t => {
    const s = await resolutionFixture(t, { overlap: true }),
      f = s.f;
    f.moveMain({ overlap: true });
    const main = f.currentMain();
    const original = s.exchange.client.mutation;
    if (asynchronous)
      s.exchange.client.mutation = async (ref, args) => {
        if (getFunctionName(ref) === 'projectHostedSyncJobs:submit') s.eagerSource(false);
        return original(ref, args);
      };
    const command = {
      laneId: f.lane.laneId,
      accept: false,
      check: { checkId: f.rawChecks.checkId },
      message: 'Check the combined resolution',
      keepOpen: true,
      priority: 'normal',
      overlapAnswer: 'accept-order',
    };
    const first = await s.transport().dispatch('finish', command);
    let recovery = first.result.recovery;
    if (asynchronous) {
      assert.equal(recovery.next.action, 'sync');
      s.eagerSource(true);
      s.exchange.client.mutation = original;
      const { action, ...next } = recovery.next;
      recovery = (await s.transport().dispatch(action, next)).result;
    }
    const conflict = recovery.conflict;
    writeFileSync(join(conflict.root, 'a.txt'), 'checked resolution\nb\nc\n');
    const { action, ...resolve } = conflict.next;
    const fixed = await s.transport(conflict.root).dispatch(action, resolve);
    const { action: finishAction, ...finish } = fixed.result.next;
    for (const key of ['accept', 'message', 'check', 'keepOpen', 'priority', 'overlapAnswer'])
      assert.deepEqual(finish[key], command[key], key);
    assert.notEqual(finish.operationId, first.operationId);
    const before = s.calls.length;
    const checked = await s.transport(conflict.root).dispatch(finishAction, finish);
    assert.equal(checked.result.phase, 'check');
    assert.equal(checked.result.run.status, 'queued');
    await f.passChecks();
    await f.drain();
    const row = [...f.tables.projectHostedCheckRuns.values()].find(
      row => row.runId === checked.result.run.id,
    );
    assert.equal(JSON.parse(row.value).status, 'passed');
    assert.deepEqual(f.currentMain(), main, 'check-only recovery never accepts main');
    assert.equal(
      s.calls
        .slice(before)
        .filter(c =>
          /projectHostedLanding(?:Desired)?:enqueue|projectHostedLandingDesired:submit/.test(c.name),
        ).length,
      0,
    );
  });

for (const cell of ['n10-r1', 'n5-r1'])
  test(`B1.5d t27456 ${cell}: rejected re-land, resolve from subdirectory, followed continuation lands`, async t => {
    const s = await resolutionFixture(t, { overlap: true }),
      f = s.f;
    f.moveMain({ overlap: true });
    await s.transport().dispatch('open', { laneId: f.lane.laneId });
    const result = await s.transport().dispatch('finish', { laneId: f.lane.laneId });
    const conflict = result.result.recovery.conflict;
    assert.match(conflict.instruction, /Edit a.txt .*then run:/);
    assert.equal(result.result.retryCommand, undefined, 'no competing retry finish');
    assert.equal(result.result.next, undefined, 'recovery owns the single continuation');
    assert.match(landSummary(result).join('\n'), /Edit a.txt/);
    const before = s.calls.length;
    for (const action of ['finish', 'save', 'resolve', 'sync', 'compose']) {
      await assert.rejects(
        s.transport(conflict.root).dispatch(action, { laneId: conflict.laneId }),
        error => {
          assert.equal(error.code, 'CONFLICT_MARKERS');
          assert.deepEqual(error.recovery.paths, ['a.txt']);
          assert.equal(error.recovery.next.action, 'resolve');
          assert.equal(error.recovery.next.operationId, conflict.next.operationId);
          assert.match(error.recovery.instruction, /then run: nforge agent/);
          return true;
        },
      );
    }
    assert.equal(s.calls.length, before, 'marker refusal makes zero Convex calls, composes or checks');
    writeFileSync(join(conflict.root, 'a.txt'), 'both\nb\nc\n');
    await assert.rejects(s.transport(conflict.root).dispatch('finish', { laneId: conflict.laneId }), {
      code: 'RESOLUTION_REQUIRED',
    });
    const subdir = join(conflict.root, 'nested', 'deep');
    mkdirSync(subdir, { recursive: true });
    assert.deepEqual(hostedAgentAddress(subdir, {}), s.address, 'CLI discovers address from ancestor Lane');
    const { action, ...resolve } = conflict.next;
    const fixed = await s.transport(subdir).dispatch(action, resolve);
    assert.equal(fixed.result.source.outcome.result.status, 'resolved');
    const { action: nextAction, ...finish } = fixed.result.next;
    const submitted = await s.transport(subdir).dispatch(nextAction, finish);
    await f.drain();
    await f.passChecks();
    await f.drain();
    assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
    assert.equal(f.text(f.currentMain().head, 'a.txt'), 'both\nb\nc\n');
  });

test('resolve interrupted while saving returns its exact command and following it reaches acceptance', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const conflict = (await s.transport().dispatch('finish', { laneId: f.lane.laneId })).result.recovery
    .conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'resume after save\nb\nc\n');
  s.eagerSource(false);
  const abort = new AbortController();
  abort.abort();
  const { action, ...resolve } = conflict.next;
  const pending = await s.transport(conflict.root).dispatch(action, resolve, abort.signal);
  assert.equal(pending.result.phase, 'save');
  assert.equal(pending.result.next.action, 'resolve');
  assert.equal(pending.result.next.laneId, conflict.laneId);
  assert.equal(pending.result.next.operationId, resolve.operationId);
  assert.match(pending.result.command, / resolve /);
  s.eagerSource(true);
  const tools = new Map();
  t.after(
    registerHostedAgentWorkflow(
      {
        registerTool(name, config, call) {
          tools.set(name, { config, call });
        },
      },
      s.transport(conflict.root),
    ),
  );
  const tool = tools.get('forge_task');
  const next = tool.config.inputSchema.command.parse(pending.result.next);
  const response = await tool.call({ command: next }, { signal: new AbortController().signal });
  assert.equal(response.isError, undefined, response.content[0].text);
  const fixed = JSON.parse(response.content[0].text);
  const { action: finishAction, ...finish } = fixed.result.next;
  const submitted = await s.transport(conflict.root).dispatch(finishAction, finish);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
});

test('save and finish reject newly introduced hunks before compose; separator-only Markdown remains valid', async t => {
  const s = await resolutionFixture(t),
    f = s.f;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  writeFileSync(join(s.root, 'a.txt'), '<<<<<<< lane\nleft\n=======\nright\n>>>>>>> main\n');
  const before = s.calls.filter(c => /Compose|Checks/.test(c.name)).length;
  let next;
  for (const action of ['save', 'finish']) {
    const command = {
      laneId: f.lane.laneId,
      operationId: randomUUID(),
      message: 'Keep this subject\n\nCo-authored-by: Fixture <fixture@example.invalid>',
    };
    await assert.rejects(s.transport().dispatch(action, command), error => {
      assert.equal(error.code, 'CONFLICT_MARKERS');
      assert.equal(error.recovery.next.action, action);
      assert.equal(error.recovery.next.message, command.message);
      assert.equal(error.recovery.next.operationId, command.operationId);
      assert.equal(error.recovery.next.laneId, command.laneId);
      next = error.recovery.next;
      return true;
    });
  }
  assert.equal(s.calls.filter(c => /Compose|Checks/.test(c.name)).length, before);
  writeFileSync(join(s.root, 'a.txt'), 'Heading\n=======\nordinary text\n');
  const { action, ...parameters } = next;
  const submitted = await s.transport().dispatch(action, parameters);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
  assert.equal(f.text(f.currentMain().head, 'a.txt'), 'Heading\n=======\nordinary text\n');
});

test('conflict normalization retains one recovery and no replay/retry advice', () => {
  const recovery = { conflict: { next: { action: 'resolve' }, command: 'exact resolve' } };
  for (const value of [
    { phase: 'conflict', recovery },
    { submission: { phase: 'terminal-failed', error: { code: 'COMPOSITION_CONFLICT' } }, recovery },
  ]) {
    const result = finishRetryHint('/fixture', {}, value);
    assert.equal(result.retryCommand, undefined);
    assert.deepEqual(result.recovery, recovery);
  }
});

test('B1.5d n3-r3 t23938: stall alarm remains pending; terminal stall has one successful retry', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const original = await s.transport().dispatch('finish', { laneId: s.lane.laneId });
  const state = s.operations.get(original.operationId);
  state.phase = 'checking';
  state.observation = {
    state: 'pending',
    pendingReason: 'checking',
    cause: null,
    stall: {
      code: 'LANDING_STALLED',
      step: 'checking',
      missingOwner: 'check runner / landing controller',
      lastProgressAt: '2026-11-04T09:48:03.993Z',
      alarmAt: '2026-11-04T10:03:03.993Z',
      message: 'Synthetic retained alarm',
    },
  };
  const pending = await s.transport().dispatch('finish', { laneId: s.lane.laneId });
  assert.equal(pending.result.submission.observation.state, 'pending');
  assert.equal(pending.result.retryCommand, undefined, 'an alarm is not a terminal failure');
  assert.equal(pending.result.next.action, 'wait');
  assert.deepEqual(pending.result.next.operationIds, [original.operationId]);
  assert.match(pending.result.command, / wait /);
  state.phase = 'terminal-failed';
  state.observation = { state: 'terminal-failed', cause: 'infra', pendingReason: null };
  state.error = { code: 'LANDING_STALLED', message: 'Synthetic controller failure' };
  const failed = await s.transport().dispatch('finish', { laneId: s.lane.laneId });
  const { action, ...command } = failed.result.next;
  assert.equal(action, 'finish');
  const retried = await s.transport().dispatch(action, command);
  assert.notEqual(retried.operationId, original.operationId);
  const accepted = s.operations.get(retried.operationId);
  accepted.phase = 'landed';
  accepted.observation = { state: 'landed', pendingReason: null, cause: null };
  const settled = await s.transport().dispatch(action, { ...command, operationId: retried.operationId });
  assert.equal(settled.result.submission.phase, 'landed');
});

test('B1.5d n3-r3 t19456: wrong editing root names one exact resolve location without help hunting', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  // The machine Lane registry is how a foreign folder finds the Lane's real checkout.
  const state = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(dirname(s.root), 'state');
  t.after(() => {
    if (state === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = state;
  });
  f.moveMain({ overlap: true });
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  const first = await s.transport().dispatch('finish', { laneId: f.lane.laneId });
  const conflict = first.result.recovery.conflict;
  // The conflict resolves in the agent's own folder, so the usual root is the right one;
  // a different folder still names the one exact place to run resolve.
  assert.equal(conflict.root, canonicalRoot(s.root));
  writeFileSync(join(conflict.root, 'a.txt'), 'chosen after conflict\nb\nc\n');
  const elsewhere = join(dirname(s.root), 'elsewhere');
  mkdirSync(elsewhere);
  let recovery;
  await assert.rejects(s.transport(elsewhere).dispatch('resolve', { laneId: conflict.laneId }), error => {
    assert.equal(error.code, 'HOSTED_CHECKOUT_REQUIRED');
    recovery = error.recovery;
    assert.equal(recovery.root, conflict.root);
    assert.equal(recovery.next.action, 'resolve');
    assert.match(error.message, /Run resolve in/);
    return true;
  });
  const { action, ...parameters } = recovery.next;
  const fixed = await s.transport(recovery.root).dispatch(action, parameters);
  const { action: finishAction, ...finish } = fixed.result.next;
  const submitted = await s.transport(recovery.root).dispatch(finishAction, finish);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
});

test('ancestor lookup never crosses a nested native or Git project', async t => {
  const s = await resolutionFixture(t);
  await s.transport().dispatch('open', { laneId: s.f.lane.laneId });
  for (const marker of ['.git', '.forge/native.json']) {
    const nested = join(s.root, marker === '.git' ? 'git-project' : 'native-project');
    mkdirSync(join(nested, '.forge'), { recursive: true });
    writeFileSync(join(nested, marker), 'synthetic boundary');
    assert.equal(hostedAgentRoot(nested), canonicalRoot(nested));
    assert.equal(hostedAgentAddress(nested, {}), null);
  }
});

test('a lost completed resolve reply retains its exact recovery identity instead of offering an impossible new resolve', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  const conflict = (await s.transport().dispatch('finish', { laneId: f.lane.laneId })).result.recovery
    .conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'resolved once\nb\nc\n');
  const operationId = randomUUID();
  s.lose('projectHostedSyncJobs:submit');
  await assert.rejects(
    s.transport(conflict.root).dispatch('resolve', { message: 'Keep both edits', operationId }),
    error => {
      assert.equal(error.code, 'HOSTED_ACTION_FAILED');
      assert.deepEqual(error.recovery.next, { action: 'resolve', message: 'Keep both edits', operationId });
      assert.match(error.recovery.command, /Keep both edits/);
      return true;
    },
  );
  assert.equal((await f.readLane(conflict.laneId)).resolution.status, 'resolved', 'source already completed');
  const originalReplay = await s.transport().dispatch('finish', { laneId: f.lane.laneId });
  assert.equal(originalReplay.result.recovery.conflict.next.operationId, operationId);
  const recovery = originalReplay.result.recovery.conflict;
  assert.equal(recovery.next.message, 'Keep both edits');
  assert.equal(recovery.next.laneId, undefined, 'retain the original inferred Lane selection');
  const { action, ...parameters } = recovery.next;
  const fixed = await s.transport(recovery.root).dispatch(action, parameters);
  const { action: finishAction, ...finish } = fixed.result.next;
  const submitted = await s.transport(recovery.root).dispatch(finishAction, finish);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
});

// Lead case 3 (2026-11-05, incident 2e264cd6): a landing read of a terminal conflict said
// "wait" on an operation that had already ended. It now names the sync recovery, as wait does,
// for one landing-status read on the conflict path only.
test('finite conflict status names the sync recovery, never a wait on the ended operation', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const first = await s.transport().dispatch('finish', { laneId: s.lane.laneId });
  const state = s.operations.get(first.operationId);
  state.phase = 'terminal-failed';
  state.observation = { state: 'terminal-failed', cause: 'conflict', pendingReason: null };
  state.error = { code: 'COMPOSITION_CONFLICT', message: 'Synthetic rejected attempt' };
  for (const action of ['status', 'landing']) {
    const before = s.calls.length;
    const result = await s.transport().dispatch(action, { operationId: first.operationId });
    assert.equal(result.result.next, undefined, `${action}: no wait on a terminal conflict`);
    assert.equal(result.result.waitCommand, undefined);
    const recovery = result.result.recovery.conflict;
    assert.equal(recovery.next.action, 'sync');
    assert.equal(recovery.next.candidateId, state.request.candidateId);
    assert.match(recovery.command, / sync /);
    assert.equal(s.calls.length - before, 3, 'capabilities, canonical status and one landing status read');
  }
});
