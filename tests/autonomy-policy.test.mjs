import { automaticResult } from '../dist/work-detail-store.js';
// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import { mockProcessCoverage } from './cleanup-process-fixture.mjs';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readLaneSubmissions } from '../dist/landing-submission-read.js';
import { readLandingProgress } from '../dist/land-progress.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { WorkService } from '../dist/work.js';
import { WorkStore } from '../dist/work-store.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { currentChannelHead } from '../dist/agent-defaults.js';
import { editedPolicy, policyPreset, protectedMatches } from '../dist/autonomy-policy.js';
import { syncTestHooks } from '../dist/agent-sync.js';
import { serveRepository } from '../dist/http.js';
import { execFileSync } from 'node:child_process';
import { localAgent } from '../dist/work-autonomy.js';
import { agentClean } from '../dist/agent-clean.js';
import { allRecords } from '../dist/agent-lifecycle.js';
import { git } from './helpers.mjs';
async function project(t, native = true) {
  const root = mkdtempSync(join(tmpdir(), 'forge-autonomy-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.txt'), 'initial\n');
  writeFileSync(join(root, 'b.txt'), 'initial\n');
  if (native) initNative(root);
  else {
    git(root, ['init', '-q']);
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'initial']);
  }
  const agent = new AgentWorkflow(root),
    human = new WorkService(root),
    store = human.store;
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  const start = async name => (await agent.dispatch({ action: 'start', outcome: name })).result;
  const edit = (lane, file, text) => {
    writeFileSync(join(lane.path, file), text);
    if (!native) git(lane.path, ['add', file]);
  };
  const finish = async lane =>
    (await agent.dispatch({ action: 'finish', laneId: lane.laneId, message: 'Edit', accept: true })).result;
  const policy = async fields =>
    (await agent.dispatch({ action: 'set-policy', operationId: randomUUID(), ...fields })).result;
  return { root, agent, human, store, start, edit, finish, policy };
}
for (const native of [true, false])
  test(`${native ? 'native' : 'Git'} default supervised blocks agents at backend and permits human acceptance`, async t => {
    const p = await project(t, native),
      lane = await p.start('Review me');
    assert.equal((await p.agent.dispatch({ action: 'status' })).result.autonomyPolicy.preset, 'supervised');
    p.edit(lane, 'a.txt', 'reviewed\n');
    const result = await p.finish(lane);
    assert.equal(result.status, 'awaiting-review');
    assert.equal(result.terminal, false);
    assert.equal(result.complete, false);
    const submission = result.submissions[0];
    assert.equal(submission.state, 'pending');
    assert.equal(submission.pendingReason, 'waiting-for-review');
    assert.deepEqual(
      readLaneSubmissions(p.store, lane.laneId),
      result.submissions.map(item => ({
        ...item,
        phases: readLandingProgress(p.store, item.entryOperationId),
      })),
    );
    assert.equal(result.message, 'Waiting for review by a person; not in main yet');
    assert.equal(p.store.select('intents', lane.intentId).status, 'active');
    assert.equal(currentChannelHead(p.store, 'main'), null);
    const command = {
      action: 'accept-channel',
      operationId: randomUUID(),
      channel: 'main',
      viewId: result.view.viewId,
      expectedHead: result.view.head,
      expectedPrevious: null,
    };
    await assert.rejects(
      new WorkService(p.root, localAgent()).dispatch(
        { ...command, actor: { kind: 'person' } },
        p.store.revision(),
      ),
      e => e.code === 'REVIEW_REQUIRED',
    );
    assert.equal((await p.human.dispatch(command, p.store.revision())).result.status, 'accepted');
    const landedSubmission = readLaneSubmissions(p.store, lane.laneId)[0];
    assert.equal(landedSubmission.submissionId, submission.submissionId);
    assert.equal(landedSubmission.state, 'landed');
    assert.equal(landedSubmission.complete, true);
    assert.equal(p.store.select('lanes', lane.laneId).state, 'active');
  });
for (const native of [true, false])
  test(`${native ? 'native' : 'Git'} allowlisted actors, exact passing evidence, and protected deletions`, async t => {
    const p = await project(t, native);
    await p.policy({ preset: 'trusted', acceptance: { autoActors: ['another-agent'] } });
    const lane = await p.start('Allowed actor');
    p.edit(lane, 'a.txt', 'new\n');
    assert.equal((await p.finish(lane)).status, 'awaiting-review');
    await p.policy({ acceptance: { autoActors: [localAgent().id] } });
    const accepted = (await p.agent.dispatch({ action: 'accept', viewId: p.store.load().views.at(-1).id }))
      .result;
    assert.equal(accepted.status, 'accepted');
    assert.ok(accepted.automatic.runId);
    assert.match(accepted.automatic.undo, /compensating/);
    await p.policy({ preset: 'autonomous', acceptance: { protectedPaths: ['**/a.txt'] } });
    const guarded = await p.start('Protected deletion');
    rmSync(join(guarded.path, 'a.txt'));
    if (!native) git(guarded.path, ['add', '-u']);
    const waiting = await p.finish(guarded);
    assert.equal(waiting.status, 'awaiting-review');
    assert.match(waiting.reason, /protected paths: a.txt/);
    // A direct backend call with no passed run cannot auto-accept another exact View.
    const fresh = await p.start('No check');
    p.edit(fresh, 'b.txt', 'unchecked\n');
    const cp = (await p.agent.dispatch({ action: 'checkpoint', laneId: fresh.laneId, message: 'Unchecked' }))
      .result;
    const view = (
      await p.agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: fresh.intentId,
        inputs: [{ laneId: fresh.laneId, head: cp.head }],
      })
    ).result;
    await assert.rejects(
      new WorkService(p.root, localAgent()).dispatch(
        {
          action: 'accept-channel',
          operationId: randomUUID(),
          channel: 'main',
          viewId: view.viewId,
          expectedHead: view.head,
          expectedPrevious: accepted.head,
        },
        p.store.revision(),
      ),
      e => e.code === 'CHECK_REQUIRED',
    );
  });
test('policy edits become custom, compare current policy, and original-operation retry never reverts later edits', async t => {
  const p = await project(t),
    op = { action: 'set-policy', operationId: randomUUID(), preset: 'trusted' };
  const first = await p.agent.dispatch(op);
  await p.policy({ preset: 'custom' });
  await p.policy({ notify: { awaySummary: false } });
  assert.equal((await p.agent.dispatch({ action: 'policy' })).result.preset, 'custom');
  assert.deepEqual((await p.agent.dispatch(op)).result, first.result);
  assert.equal((await p.agent.dispatch({ action: 'policy' })).result.notify.awaySummary, false);
  await assert.rejects(
    p.policy({ expectedPolicy: policyPreset('supervised'), preset: 'autonomous' }),
    e => e.code === 'POLICY_CHANGED',
  );
  assert.deepEqual(
    protectedMatches(
      {
        ...policyPreset('trusted'),
        acceptance: { mode: 'auto-on-pass', protectedPaths: ['src/**/{a,b}.[jt]s'] },
      },
      ['src/a.ts', 'src/deep/b.js', 'src/c.ts'],
    ),
    ['src/a.ts', 'src/deep/b.js'],
  );
});
test('existing owner migrates lazily to custom without changing behavior or enabling cleanup', async t => {
  const p = await project(t);
  p.store.locked(() => {
    const data = p.store.load();
    delete data.autonomyPolicy;
    p.store.save(data);
  });
  const policy = (await p.agent.dispatch({ action: 'policy' })).result;
  assert.equal(policy.preset, 'custom');
  assert.equal(policy.acceptance.mode, 'auto-on-pass');
  assert.equal(policy.lifecycle.cleanRegenerableCopies, false);
});
test('ask stops before sync; auto-sync is recorded and undo-sync is retry-safe with dirty/newer guards', async t => {
  const p = await project(t);
  await p.policy({ preset: 'trusted', laneUpdates: 'ask' });
  const a = await p.start('A'),
    b = await p.start('B');
  p.edit(a, 'a.txt', 'A\n');
  await p.finish(a);
  p.edit(b, 'b.txt', 'B\n');
  const paused = await p.finish(b);
  assert.equal(paused.status, 'sync-required');
  assert.match(paused.message, /main moved; run sync/);
  assert.equal(readFileSync(join(b.path, 'a.txt'), 'utf8'), 'initial\n');
  await p.policy({ laneUpdates: 'auto' });
  const done = await p.finish(b);
  assert.equal(done.status, 'accepted');
  assert.equal(done.sync.message, 'Updated from main: 1 files');
  const checkpoint = p.store
    .select('lanes', b.laneId)
    .checkpoints.find(c => c.operation?.id === done.sync.operationId);
  assert.equal(checkpoint.automatic.summary, done.sync.message);
  const op = {
    action: 'undo-sync',
    operationId: randomUUID(),
    laneId: b.laneId,
    syncOperationId: done.sync.operationId,
  };
  p.edit(b, 'b.txt', 'newer uncaptured\n');
  await assert.rejects(p.agent.dispatch(op), e => e.code === 'LANE_DIRTY');
  const undo = (await p.agent.dispatch({ ...op, force: true })).result;
  assert.equal(undo.head, checkpoint.parent);
  assert.match(undo.warning, /retained checkpoints/);
  assert.equal(readFileSync(join(b.path, 'a.txt'), 'utf8'), 'initial\n');
  assert.equal(currentChannelHead(p.store, 'main'), done.acceptance.head);
  assert.deepEqual((await p.agent.dispatch({ ...op, force: true })).result, undo);
  const newer = p.store
    .select('lanes', b.laneId)
    .checkpoints.find(c => c.message === 'Preserve edits before forced undo-sync');
  const source = new NativeSource(p.root),
    file = source.state(newer.head).files.find(f => f.path === 'b.txt');
  assert.equal(source.object(file.blob).toString(), 'newer uncaptured\n');
  await assert.rejects(p.agent.dispatch({ ...op, operationId: randomUUID() }), e => e.code === 'LANE_STALE');
});
test('automatic acceptance never rewinds accepted main even for an older accepted View', async t => {
  const p = await project(t);
  await p.policy({ preset: 'trusted' });
  const a = await p.start('A');
  p.edit(a, 'a.txt', 'A\n');
  const first = await p.finish(a);
  const b = await p.start('B');
  p.edit(b, 'b.txt', 'B\n');
  const second = await p.finish(b);
  await assert.rejects(
    p.agent.dispatch({
      action: 'accept',
      viewId: first.view.viewId,
      expectedPrevious: second.acceptance.head,
    }),
    e => e.code === 'CHANNEL_DIVERGED',
  );
});
test('briefing states policy, protected paths, and review stop in full and copy text', async t => {
  const p = await project(t);
  await p.policy({ acceptance: { protectedPaths: ['src/**', 'secrets.json'] } });
  const lane = await p.start('Brief me'),
    brief = (await p.agent.dispatch({ action: 'brief', laneId: lane.laneId, situation: 'continue-lane' }))
      .result;
  assert.equal(brief.context.autonomyPolicy.acceptance.mode, 'review');
  for (const text of [brief.copyText, brief.full]) {
    assert.match(text, /Acceptance: review/);
    assert.match(text, /src\/\*\*/);
  }
  assert.match(brief.full, /awaiting-review/);
});
test('autonomous cleanup only touches eligible copies and records regeneration instructions', async t => {
  mockProcessCoverage(t);
  const p = await project(t);
  await p.policy({ preset: 'autonomous' });
  const lane = await p.start('Clean me');
  p.edit(lane, 'a.txt', 'A\n');
  mkdirSync(join(lane.path, 'node_modules'));
  writeFileSync(join(lane.path, 'node_modules', 'generated'), 'copy');
  const done = await p.finish(lane);
  assert.equal(done.status, 'accepted');
  assert.equal(existsSync(join(lane.path, 'node_modules')), false);
  assert.equal(existsSync(lane.path), false);
  const cleanup = done.acceptance.completed.cleanup.find(item => item.laneId === lane.laneId).cleanup,
    action = allRecords(p.store, 'automaticActions').find(
      item =>
        item.result &&
        (JSON.parse(automaticResult(p.store, item)).removed ?? [])
          .flatMap(group => group.items)
          .some(item => item.laneId === lane.laneId),
    );
  assert.ok(action, 'the Lane completion cleanup retains its automatic-action record');
  assert.deepEqual(action.action, cleanup.automatic);
  assert.match(action.action.undo, /reopen/);
  assert.match(action.action.undo, /npm ci --ignore-scripts/);
  assert.equal(done.acceptance.cleanup.totals.count, 0);
  assert.equal(p.store.select('automaticActions', done.acceptance.acceptanceId), undefined);
  await p.agent.dispatch({ action: 'reopen', laneId: lane.laneId });
  mkdirSync(join(lane.path, 'node_modules'));
  writeFileSync(join(lane.path, 'node_modules', 'generated'), 'copy');
  p.edit(lane, 'a.txt', 'uncaptured\n');
  await p.agent.dispatch({ action: 'complete', laneId: lane.laneId });
  const automatic = { id: randomUUID(), actor: localAgent().id },
    revision = p.store.revision(),
    pointer = readFileSync(join(p.store.directory, 'work.json')),
    records = readdirSync(join(p.store.directory, 'records'));
  const skipped = agentClean(p.store, { action: 'clean', apply: true, kinds: ['lane-deps'] }, automatic);
  assert.equal(skipped.result.totals.count, 0);
  assert.match(skipped.result.skipped.find(item => item.laneId === lane.laneId).reason, /[Uu]ncaptured/);
  assert.equal(p.store.select('automaticActions', automatic.id), undefined);
  assert.equal(p.store.revision(), revision);
  assert.deepEqual(readFileSync(join(p.store.directory, 'work.json')), pointer);
  assert.deepEqual(readdirSync(join(p.store.directory, 'records')), records);
  assert.ok(existsSync(join(lane.path, 'node_modules')));
  assert.equal(readFileSync(join(lane.path, 'a.txt'), 'utf8'), 'uncaptured\n');
});

test('HTTP server token accepts a supervised View and exposes policy; unauthenticated writes fail', async t => {
  const p = await project(t),
    lane = await p.start('HTTP review');
  p.edit(lane, 'a.txt', 'HTTP\n');
  const waiting = await p.finish(lane),
    server = await serveRepository(p.root, 0);
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.port}/api/work`;
  const command = {
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: waiting.view.viewId,
    expectedHead: waiting.view.head,
    expectedPrevious: null,
  };
  const post = headers =>
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ command, revision: p.store.revision() }),
    });
  assert.equal((await post({})).status, 401);
  const headers = { Authorization: `Bearer ${server.token}` };
  assert.equal((await (await fetch(endpoint, { headers })).json()).autonomyPolicy.preset, 'supervised');
  const accepted = await post(headers);
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).result.status, 'accepted');
  const policy = JSON.parse(
    execFileSync(process.execPath, ['dist/cli.js', 'policy', p.root], { encoding: 'utf8' }),
  );
  assert.equal(policy.result.preset, 'supervised');
});
test('conflicted automatic sync reports undo and undo-sync resumes an interrupted restoration', async t => {
  const p = await project(t);
  await p.policy({ preset: 'trusted' });
  const a = await p.start('A'),
    b = await p.start('B');
  p.edit(a, 'a.txt', 'A\n');
  p.edit(b, 'a.txt', 'B\n');
  await p.finish(a);
  const conflict = await p.finish(b);
  assert.equal(conflict.status, 'conflict');
  assert.match(conflict.sync.undo, /undo-sync/);
  const command = {
    action: 'undo-sync',
    operationId: randomUUID(),
    laneId: b.laneId,
    syncOperationId: conflict.sync.operationId,
  };
  syncTestHooks.afterWorkspace = () => {
    throw new Error('Lost undo reply');
  };
  t.after(() => {
    delete syncTestHooks.afterWorkspace;
  });
  await assert.rejects(p.agent.dispatch(command), /Lost undo reply/);
  assert.ok(p.store.select('lanes', b.laneId).pendingUndo);
  delete syncTestHooks.afterWorkspace;
  const undone = (await p.agent.dispatch(command)).result;
  assert.equal(readFileSync(join(b.path, 'a.txt'), 'utf8'), 'B\n');
  assert.equal(p.store.select('lanes', b.laneId).pendingMerge, undefined);
  assert.deepEqual((await p.agent.dispatch(command)).result, undone);
});
test('replaying acceptance never completes a Lane that was explicitly reopened later', async t => {
  const p = await project(t);
  await p.policy({ preset: 'trusted' });
  const lane = await p.start('Reopen'),
    done = await p.finish(lane);
  await p.agent.dispatch({ action: 'reopen', laneId: lane.laneId });
  await p.agent.dispatch({
    action: 'accept',
    operationId: done.acceptance.operationId,
    viewId: done.view.viewId,
    expectedPrevious: null,
  });
  assert.equal(p.store.select('lanes', lane.laneId).state, 'active');
});

test('Git ask, recorded auto-sync, guarded undo, and preserved ignored obstructions', async t => {
  const p = await project(t, false);
  await p.policy({ preset: 'trusted', laneUpdates: 'ask' });
  const a = await p.start('A'),
    b = await p.start('B');
  p.edit(a, 'a.txt', 'A\n');
  await p.finish(a);
  p.edit(b, 'b.txt', 'B\n');
  assert.equal((await p.finish(b)).status, 'sync-required');
  await p.policy({ laneUpdates: 'auto' });
  const accepted = await p.finish(b);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.sync.message, 'Updated from main: 1 files');
  const op = {
    action: 'undo-sync',
    operationId: randomUUID(),
    laneId: b.laneId,
    syncOperationId: accepted.sync.operationId,
  };
  writeFileSync(join(b.path, 'b.txt'), 'newer\n');
  await assert.rejects(p.agent.dispatch(op), e => e.code === 'LANE_DIRTY');
  const undone = (await p.agent.dispatch({ ...op, force: true })).result;
  assert.equal(readFileSync(join(b.path, 'a.txt'), 'utf8'), 'initial\n');
  assert.match(undone.warning, /retained|remain/);
  assert.equal(currentChannelHead(p.store, 'main'), accepted.acceptance.head);
  assert.deepEqual((await p.agent.dispatch({ ...op, force: true })).result, undone);
  assert.equal((await p.agent.dispatch({ action: 'sync', laneId: b.laneId })).result.status, 'merged');
});
test('Git conflicted auto-sync can be undone or resolved into a two-parent checkpoint', async t => {
  const p = await project(t, false);
  await p.policy({ preset: 'trusted' });
  const a = await p.start('A'),
    b = await p.start('B');
  p.edit(a, 'a.txt', 'A\n');
  p.edit(b, 'a.txt', 'B\n');
  await p.finish(a);
  const conflict = await p.finish(b);
  assert.equal(conflict.status, 'conflict');
  assert.match(readFileSync(join(b.path, 'a.txt'), 'utf8'), /<<<<<<</);
  const undo = (
    await p.agent.dispatch({
      action: 'undo-sync',
      laneId: b.laneId,
      syncOperationId: conflict.sync.operationId,
    })
  ).result;
  assert.equal(readFileSync(join(b.path, 'a.txt'), 'utf8'), 'B\n');
  assert.equal(undo.head, conflict.checkpoint.head);
  const again = (await p.agent.dispatch({ action: 'sync', laneId: b.laneId })).result;
  assert.equal(again.status, 'conflict');
  p.edit(b, 'a.txt', 'A and B\n');
  const accepted = await p.finish(b);
  assert.equal(accepted.status, 'accepted');
  assert.equal(git(p.root, ['show', `${accepted.acceptance.head}:a.txt`]).trim(), 'A and B');
});

test('Git auto-sync preserves an ignored directory with non-regenerable files', async t => {
  const p = await project(t, false);
  await p.policy({ preset: 'trusted' });
  const a = await p.start('A'),
    b = await p.start('B');
  p.edit(a, 'cache', 'accepted source\n');
  await p.finish(a);
  p.edit(b, '.gitignore', 'cache/\n');
  p.edit(b, 'b.txt', 'B\n');
  mkdirSync(join(b.path, 'cache'));
  writeFileSync(join(b.path, 'cache', '.env'), 'PRIVATE_SYNTHETIC_VALUE');
  await assert.rejects(p.finish(b), error => error.code === 'SYNC_PATH_BLOCKED');
  assert.equal(readFileSync(join(b.path, 'cache', '.env'), 'utf8'), 'PRIVATE_SYNTHETIC_VALUE');
  assert.equal(git(p.root, ['show', 'refs/forge/channels/main:cache']).trim(), 'accepted source');
});

test('owner refresh, runner and GitHub policy edits each mark custom and preserve the other settings', () => {
  const githubMirror = { repo: 'example/project', autoPush: true, laneRefs: false };
  const previous = {
    ...policyPreset('trusted'),
    checks: { runner: 'local' },
    ownerRootUpdates: true,
    githubMirror,
  };
  for (const fields of [
    { ownerRootUpdates: false },
    { checks: { runner: 'github-actions', repo: 'synthetic/checks' } },
    { githubMirror: { ...githubMirror, autoPush: false } },
  ]) {
    const edited = editedPolicy(previous, {
      action: 'set-policy',
      operationId: randomUUID(),
      ...fields,
    });
    assert.equal(edited.preset, 'custom');
    assert.equal(edited.ownerRootUpdates, fields.ownerRootUpdates ?? previous.ownerRootUpdates);
    // A runner edit also records the default manual laptop fallback.
    assert.deepEqual(
      edited.checks,
      fields.checks ? { fallback: 'manual', ...fields.checks } : previous.checks,
    );
    assert.deepEqual(edited.githubMirror, fields.githubMirror ?? previous.githubMirror);
  }
});
