// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { WorkService } from '../dist/work.js';
import { serveRepository } from '../dist/http.js';
import { fixture, git, write, code } from './helpers.mjs';

function setup(t) {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Baseline']);
  const work = new WorkService(root),
    local = c => work.execute(c, work.status().revision).result;
  const dispatch = (c, revision = work.status().revision) => work.dispatch(c, revision);
  const intent = local({ action: 'intent', outcome: 'Playbook fixture' });
  const lane = local({ action: 'lane', intentId: intent.id, name: 'Candidate' });
  const view = local({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const define = (script, patch = {}) =>
    local({
      action: 'define-check',
      name: 'Check',
      executable: process.execPath,
      args: ['-e', script],
      ...patch,
    });
  const book = async checks =>
    (await dispatch({ action: 'define-playbook', name: 'Sequence', checkIds: checks.map(c => c.id) })).result;
  const command = (playbook, onFailure = 'stop') => ({
    action: 'run-playbook',
    operationId: randomUUID(),
    playbookId: playbook.id,
    viewId: view.id,
    expectedHead: view.head,
    expectedDefinition: playbook.definition,
    expectedEnvironment: work.status().environment.fingerprint,
    expectedChecks: playbook.checkIds.map(id => {
      const c = work.status().checks.find(c => c.id === id);
      return { id, definition: c.definition };
    }),
    onFailure,
  });
  const marker = join(root, '.git/order.txt');
  const append = value =>
    `require('node:fs').appendFileSync(${JSON.stringify(marker)},${JSON.stringify(value)}); console.log(require('node:fs').readFileSync('a.ts','utf8'));`;
  return { root, work, local, dispatch, lane, view, define, book, command, marker, append };
}
async function wait(work, id, done = r => !!r?.endedAt) {
  for (let i = 0; i < 400; i++) {
    const run = work.status().playbookRuns.find(r => r.id === id);
    if (done(run)) return run;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail('Playbook did not reach expected state');
}

test('ordered exact checks, duplicate selected steps, retries and private portable exports preserve dirty work', async t => {
  const { root, work, dispatch, lane, view, define, book, command, marker, append } = setup(t);
  write(work.store.path(lane.id), 'a.ts', 'unfinished source');
  const first = define(append('A')),
    second = define(append('B'));
  const playbook = await book([first, second, first]),
    input = command(playbook);
  await dispatch(input);
  await dispatch(input, 0);
  const run = await wait(work, input.operationId);
  assert.equal(run.status, 'passed');
  assert.equal(readFileSync(marker, 'utf8'), 'ABA');
  assert.equal(work.status().runs.length, 3);
  assert.deepEqual(run.inputs, view.inputs);
  assert.equal(run.head, view.head);
  assert.equal((await dispatch(input, 0)).result.id, run.id);
  assert.equal(readFileSync(marker, 'utf8'), 'ABA');
  await assert.rejects(dispatch({ ...input, onFailure: 'continue' }, 0), code('EVIDENCE_CHANGED'));
  const exported = (await dispatch({ action: 'export-playbook', kind: 'run', id: run.id }, 0)).result;
  assert.equal(exported.private, true);
  assert.equal(exported.steps.length, 3);
  assert.ok(exported.steps.every(s => s.outcome.status === 'passed' && s.outcome.playbookRunId === run.id));
  const out = (
    await dispatch({ action: 'read-check-output', operationId: run.steps[0].runId, stream: 'stdout' })
  ).result;
  assert.equal(out.text, 'export const a = 1;\n\n');
  const cli = JSON.parse(
    execFileSync(
      process.execPath,
      [
        resolve('dist/cli.js'),
        'work',
        root,
        JSON.stringify({ action: 'export-playbook', kind: 'definition', id: playbook.id }),
        '0',
      ],
      { encoding: 'utf8' },
    ),
  );
  assert.deepEqual(
    cli.result.checks.map(c => c.definition),
    [first.definition, second.definition, first.definition],
  );
  assert.equal(readFileSync(join(work.store.path(lane.id), 'a.ts'), 'utf8'), 'unfinished source');
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), view.base);
});

test('stop/continue choices affect only the sequence; changing a definition never substitutes a pending command', async t => {
  const { work, dispatch, define, book, command, marker, append } = setup(t);
  const failed = define('process.exit(7)'),
    passed = define(append('P')),
    playbook = await book([failed, passed]);
  const stopped = command(playbook);
  await dispatch(stopped);
  const stop = await wait(work, stopped.operationId);
  assert.equal(stop.status, 'failed');
  assert.equal(existsSync(marker), false);
  assert.equal(work.status().runs.length, 1);
  const continued = command(playbook, 'continue');
  await dispatch(continued);
  assert.equal((await wait(work, continued.operationId)).status, 'failed');
  assert.equal(readFileSync(marker, 'utf8'), 'P');
  const release = marker + '.release';
  const slow = define(
      `setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(release)}))process.exit(0)},20); setTimeout(()=>process.exit(99),10000)`,
    ),
    next = define(append('must not substitute'));
  t.after(() => {
    if (existsSync(dirname(release))) writeFileSync(release, 'release');
  });
  const selected = command(await book([slow, next]));
  await dispatch(selected);
  define(append('replacement'), { checkId: next.id });
  writeFileSync(release, 'release');
  const interrupted = await wait(work, selected.operationId);
  assert.equal(interrupted.status, 'interrupted');
  assert.match(interrupted.details, /definition.*changed/i);
  assert.equal(interrupted.applicability, 'historical');
  assert.equal(readFileSync(marker, 'utf8'), 'P');
  for (const patch of [
    { expectedDefinition: '0'.repeat(64) },
    { expectedEnvironment: '0'.repeat(64) },
    { expectedChecks: [] },
  ]) {
    await assert.rejects(
      dispatch({ ...command(playbook), ...patch }),
      code(patch.expectedChecks ? 'BAD_ARGUMENT' : 'EVIDENCE_CHANGED'),
    );
  }
  await assert.rejects(dispatch({ ...command(playbook), expectedHead: '0'.repeat(40) }), code('VIEW_STALE'));
});

test('HTTP cancellation stops a live step and later launches, protects exports and reserved step IDs', async t => {
  const { root, work, dispatch, define, book, command, marker, append } = setup(t);
  const playbook = await book([
    define('console.log("live"); setInterval(()=>{},1000)'),
    define(append('not launched')),
  ]);
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/api/work`,
    headers = { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' };
  const input = command(playbook);
  const started = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ command: input, revision: work.status().revision }),
  });
  assert.equal(started.status, 200);
  const run = (await started.json()).result;
  const reserved = run.steps[1];
  await assert.rejects(
    dispatch({
      action: 'run-check',
      operationId: reserved.runId,
      viewId: run.viewId,
      expectedHead: run.head,
      checkId: reserved.check.id,
      expectedDefinition: reserved.check.definition,
      expectedEnvironment: run.environment.fingerprint,
    }),
    code('EVIDENCE_CHANGED'),
  );
  const cancelled = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ command: { action: 'cancel-playbook', operationId: run.id }, revision: 0 }),
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await wait(work, run.id)).status, 'cancelled');
  assert.equal(existsSync(marker), false);
  assert.equal(work.status().runs.length, 1);
  const exportBody = JSON.stringify({
    command: { action: 'export-playbook', kind: 'run', id: run.id },
    revision: 0,
  });
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: exportBody }))
      .status,
    401,
  );
  const exported = await fetch(url, { method: 'POST', headers, body: exportBody });
  assert.equal(exported.status, 200);
  assert.equal((await exported.json()).result.steps[1].outcome, null);
  await dispatch(input, 0);
  assert.equal(work.status().runs.length, 1);
});

test(
  'lost registration replies reconcile without launching, and actual runner death never starts remaining steps',
  { timeout: 120_000 },
  async t => {
    let cleanup = () => {};
    t.after(() => cleanup());
    const { root, work, dispatch, define, book, command, marker, append } = setup(t);
    const selected = command(await book([define(append('not launched'))]));
    const save = work.store.save.bind(work.store);
    let fail = true;
    work.store.save = data => {
      save(data);
      if (fail && data.playbookRuns.length) {
        fail = false;
        throw new Error('Lost registration reply');
      }
    };
    await assert.rejects(dispatch(selected), /Lost registration reply/);
    work.store.save = save;
    assert.equal((await dispatch(selected, 0)).result.status, 'interrupted');
    assert.equal(work.status().runs.length, 0);
    assert.equal(existsSync(marker), false);
    const completion = command(
      await book([define('console.log("finished once")'), define(append('not after uncertain completion'))]),
    );
    let lostCompletion = false;
    const commit = work.store.commitRecords.bind(work.store);
    work.store.commitRecords = (transaction, revision) => {
      const runId = transaction.find('playbookRuns', completion.operationId)?.record.steps[0]?.runId;
      const run = runId ? transaction.find('runs', runId)?.record : undefined;
      if (!lostCompletion && run?.endedAt) {
        lostCompletion = true;
        throw new Error('Lost completion write');
      }
      return commit(transaction, revision);
    };
    await dispatch(completion);
    assert.equal((await wait(work, completion.operationId)).status, 'interrupted');
    work.store.commitRecords = commit;
    assert.equal(lostCompletion, true);
    assert.equal(work.status().runs.find(r => r.playbookRunId === completion.operationId).status, 'passed');
    await dispatch(completion, 0);
    assert.equal(work.status().runs.filter(r => r.playbookRunId === completion.operationId).length, 1);
    assert.equal(existsSync(marker), false);
    const input = command(
      await book([
        define('console.log("ready"); setInterval(()=>{},1000)'),
        define(append('not after death')),
      ]),
    );
    const child = spawn(
      process.execPath,
      [resolve('dist/cli.js'), 'work', root, JSON.stringify(input), String(work.status().revision)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', bytes => {
      stderr += bytes;
    });
    cleanup = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      try {
        const step = work.store
          .load()
          .runs.find(r => r.playbookRunId === input.operationId && r.runner.pid === child.pid);
        if (step?.childPid)
          process.kill(process.platform === 'win32' ? step.childPid : -step.childPid, 'SIGKILL');
      } catch {
        /* Only this test's original child/group is owned; it may already have exited. */
      }
      child.stdout.removeAllListeners('data');
    };
    // CLI readiness is an actual complete response, not a five-second machine-speed assumption.
    const launched = await new Promise((resolve, reject) => {
      child.stdout.on('data', bytes => {
        stdout += bytes;
        try {
          resolve(JSON.parse(stdout).result);
        } catch {
          /* The CLI emits pretty-printed JSON in multiple chunks. */
        }
      });
      child.once('error', reject);
      child.once('close', code =>
        reject(new Error(`Synthetic CLI exited before readiness (${code}): ${stderr}`)),
      );
    });
    assert.ok(launched);
    const closed = once(child, 'close');
    child.kill('SIGKILL');
    await closed;
    const step = work.store.load().runs.find(r => r.id === launched.steps[0].runId);
    // This child/group was started by this disposable test, never by a user Lane.
    if (step.childPid) {
      try {
        process.kill(process.platform === 'win32' ? step.childPid : -step.childPid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
    cleanup = () => {
      child.stdout.removeAllListeners('data');
    };
    const recovered = work.status().playbookRuns.find(r => r.id === input.operationId);
    assert.equal(recovered.status, 'interrupted');
    await dispatch(input, 0);
    assert.equal(work.status().runs.filter(r => r.playbookRunId === recovered.id).length, 1);
    assert.equal(existsSync(marker), false);
  },
);

function automationInput(work, playbook, intentId, patch = {}) {
  return {
    action: 'define-automation',
    automationId: randomUUID(),
    intentId,
    name: 'Optional clean-View checks',
    playbookId: playbook.id,
    expectedPlaybook: playbook.definition,
    expectedChecks: playbook.checkIds.map(id => {
      const c = work.status().checks.find(c => c.id === id);
      return { id, definition: c.definition };
    }),
    expectedEnvironment: work.status().environment.fingerprint,
    onFailure: 'stop',
    enabled: false,
    ...patch,
  };
}
test('opt-in clean-View automations share exact Playbook execution and original composition reconciliation', async t => {
  const { root, work, local, dispatch, lane, view, define, book, marker, append } = setup(t);
  const playbook = await book([define(append('A')), define(append('B'))]);
  const input = automationInput(work, playbook, lane.intentId),
    rule = local(input);
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/api/work`;
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: input, revision: 0 }),
      })
    ).status,
    401,
  );
  const compose = () => ({
    action: 'compose',
    operationId: randomUUID(),
    intentId: lane.intentId,
    inputs: [{ laneId: lane.id, head: lane.head }],
    dependencies: [],
  });
  local(compose());
  assert.equal(work.status().playbookRuns.length, 0);
  const enabled = local({
    action: 'automation-enabled',
    automationId: rule.id,
    expectedDefinition: rule.definition,
    enabled: true,
  });
  write(work.store.path(lane.id), 'a.ts', 'unfinished source');
  const selected = compose(),
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: selected, revision: work.status().revision }),
    });
  assert.equal(response.status, 200);
  const candidate = (await response.json()).result,
    run = work.status().playbookRuns[0];
  assert.equal((await wait(work, run.id)).status, 'passed');
  assert.equal(readFileSync(marker, 'utf8'), 'AB');
  assert.equal(run.viewId, candidate.id);
  assert.equal(run.automation.id, rule.id);
  assert.equal(run.automation.definition, enabled.definition);
  assert.deepEqual(run.inputs, candidate.inputs);
  assert.deepEqual(run.dependencies, candidate.dependencies);
  assert.equal(work.execute(selected, 0).result.id, candidate.id);
  assert.equal(work.status().playbookRuns.length, 1);
  assert.equal(readFileSync(marker, 'utf8'), 'AB');
  assert.throws(
    () =>
      work.execute({ ...selected, dependencies: [{ kind: 'view', viewId: view.id, head: view.head }] }, 0),
    code('WORK_OPERATION_CHANGED'),
  );
  const exported = (await dispatch({ action: 'export-playbook', kind: 'run', id: run.id }, 0)).result;
  assert.deepEqual(exported.record.automation, run.automation);
  assert.equal(exported.steps.length, 2);
  const manifest = (await dispatch({ action: 'export-playbook', kind: 'automation', id: rule.id }, 0)).result;
  assert.equal(manifest.private, true);
  assert.deepEqual(
    manifest.record.checks.map(c => c.definition),
    run.steps.map(s => s.check.definition),
  );
  const disabled = local({
    action: 'automation-enabled',
    automationId: rule.id,
    expectedDefinition: enabled.definition,
    enabled: false,
  });
  const again = local({
    action: 'automation-enabled',
    automationId: rule.id,
    expectedDefinition: disabled.definition,
    enabled: true,
  });
  assert.notEqual(again.definition, enabled.definition);
  assert.ok(again.version > enabled.version);
  assert.throws(
    () =>
      local({
        action: 'automation-enabled',
        automationId: rule.id,
        expectedDefinition: enabled.definition,
        enabled: false,
      }),
    code('EVIDENCE_CHANGED'),
  );
  local({
    action: 'automation-enabled',
    automationId: rule.id,
    expectedDefinition: again.definition,
    enabled: false,
  });
  local(compose());
  assert.equal(work.status().playbookRuns.length, 1);
  assert.equal(readFileSync(join(work.store.path(lane.id), 'a.ts'), 'utf8'), 'unfinished source');
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), view.base);
});
test('changed automatic definitions and runtime interrupt only the optional run; explicit refresh and failure choices remain available', async t => {
  const { work, local, dispatch, lane, define, book, marker, append } = setup(t);
  const check = define(append('original')),
    playbook = await book([check]);
  const input = automationInput(work, playbook, lane.intentId, { enabled: true }),
    rule = local(input);
  const compose = () =>
    local({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.id, head: lane.head }],
    });
  define(append('new'), { checkId: check.id });
  const candidate = compose();
  assert.equal(candidate.status, 'clean');
  let run = work.status().playbookRuns.at(-1);
  assert.equal(run.status, 'interrupted');
  assert.equal(work.status().runs.length, 0);
  assert.equal(existsSync(marker), false);
  assert.equal(run.steps[0].check.definition, check.definition);
  assert.match(run.details, /pinned.*changed/);
  const refreshed = local(
    automationInput(work, playbook, lane.intentId, {
      automationId: rule.id,
      expectedDefinition: rule.definition,
      enabled: true,
    }),
  );
  compose();
  run = work.status().playbookRuns.at(-1);
  assert.equal((await wait(work, run.id)).status, 'passed');
  assert.equal(readFileSync(marker, 'utf8'), 'new');
  const old = process.env.TZ;
  process.env.TZ = 'Forge/QA';
  try {
    compose();
    run = work.status().playbookRuns.at(-1);
    assert.equal(run.status, 'interrupted');
    assert.equal(readFileSync(marker, 'utf8'), 'new');
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
  await assert.rejects(
    dispatch({ ...input, automationId: rule.id, expectedDefinition: rule.definition }),
    code('EVIDENCE_CHANGED'),
  );
  local({
    action: 'automation-enabled',
    automationId: rule.id,
    expectedDefinition: refreshed.definition,
    enabled: false,
  });
  const failure = define('process.exit(4)'),
    after = define(append('after')),
    failedBook = await book([failure, after]);
  const continued = local(
    automationInput(work, failedBook, lane.intentId, { enabled: true, onFailure: 'continue' }),
  );
  compose();
  run = work.status().playbookRuns.at(-1);
  assert.equal(run.automation.id, continued.id);
  assert.equal((await wait(work, run.id)).status, 'failed');
  assert.equal(readFileSync(marker, 'utf8'), 'newafter');
});
test('lost automatic registration never executes on reconciliation and conflicting compositions trigger no run', async t => {
  const { work, local, lane, define, book, marker, append } = setup(t);
  local(
    automationInput(work, await book([define(append('not repeated'))]), lane.intentId, { enabled: true }),
  );
  const selected = {
    action: 'compose',
    operationId: randomUUID(),
    intentId: lane.intentId,
    inputs: [{ laneId: lane.id, head: lane.head }],
  };
  const save = work.store.save.bind(work.store);
  let fail = true;
  work.store.save = data => {
    save(data);
    if (fail && data.playbookRuns.length) {
      fail = false;
      throw new Error('Lost automatic registration reply');
    }
  };
  assert.throws(() => local(selected), /Lost automatic registration reply/);
  work.store.save = save;
  const original = work.status().views.at(-1);
  assert.equal(work.execute(selected, 0).result.id, original.id);
  assert.equal(work.status().playbookRuns[0].status, 'interrupted');
  assert.equal(work.status().runs.length, 0);
  assert.equal(existsSync(marker), false);
  const other = local({ action: 'lane', intentId: lane.intentId, name: 'Conflicting source' });
  const checkpoint = (l, value) => {
    const path = work.store.path(l.id);
    write(path, 'a.ts', value);
    git(path, ['add', 'a.ts']);
    return local({
      action: 'checkpoint',
      laneId: l.id,
      expectedHead: l.head,
      expectedTree: git(path, ['write-tree']).trim(),
      message: value,
    });
  };
  const first = checkpoint(lane, 'export const a = 2;\n'),
    second = checkpoint(other, 'export const a = 3;\n');
  const conflict = local({
    action: 'compose',
    operationId: randomUUID(),
    intentId: lane.intentId,
    inputs: [
      { laneId: first.id, head: first.head },
      { laneId: second.id, head: second.head },
    ],
  });
  assert.equal(conflict.status, 'conflict');
  assert.equal(work.status().playbookRuns.length, 1);
  assert.equal(existsSync(marker), false);
});

test('selected delivery events execute the original accepted/released source once through private HTTP and keep default clean-View rules independent', async t => {
  const { root, work, local, dispatch, lane, view, define, book, marker, append } = setup(t);
  const channelRule = local(
    automationInput(work, await book([define(append('C'))]), lane.intentId, {
      event: 'channel-accepted',
      enabled: true,
    }),
  );
  const releaseRule = local(
    automationInput(work, await book([define(append('R'))]), lane.intentId, {
      event: 'release-created',
      enabled: true,
    }),
  );
  const clean = local(
    automationInput(work, await book([define(append('V'))]), lane.intentId, { enabled: true }),
  );
  assert.equal(clean.event, 'clean-view');
  write(work.store.path(lane.id), 'a.ts', 'unfinished Lane');
  const accept = {
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: null,
  };
  const server = await serveRepository(root, 0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.port}/api/work`;
  const body = JSON.stringify({ command: accept, revision: work.status().revision });
  assert.equal(
    (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status,
    401,
  );
  assert.equal(work.status().playbookRuns.length, 0);
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.id, accept.operationId);
  let run = work.status().playbookRuns.at(-1);
  assert.equal((await wait(work, run.id)).status, 'passed');
  assert.equal(run.automation.id, channelRule.id);
  assert.equal(run.automation.event, 'channel-accepted');
  assert.equal(run.automation.eventId, accept.operationId);
  assert.equal(run.head, view.head);
  await dispatch(accept, 0);
  assert.equal(work.status().playbookRuns.length, 1);
  const release = {
    action: 'create-release',
    operationId: randomUUID(),
    acceptanceId: accept.operationId,
    expectedHead: view.head,
    name: 'Original source',
  };
  await dispatch(release);
  run = work.status().playbookRuns.at(-1);
  assert.equal((await wait(work, run.id)).status, 'passed');
  assert.equal(run.automation.id, releaseRule.id);
  assert.equal(run.automation.eventId, release.operationId);
  assert.equal(run.automation.event, 'release-created');
  const exported = (await dispatch({ action: 'export-playbook', kind: 'run', id: run.id }, 0)).result;
  assert.equal(exported.record.automation.eventId, release.operationId);
  assert.equal(exported.steps[0].outcome.status, 'passed');
  await dispatch(release, 0);
  assert.equal(work.status().playbookRuns.length, 2);
  assert.equal(readFileSync(marker, 'utf8'), 'CR');
  local({
    action: 'automation-enabled',
    automationId: releaseRule.id,
    expectedDefinition: releaseRule.definition,
    enabled: false,
  });
  await dispatch({ ...release, operationId: randomUUID(), name: 'Disabled event' });
  assert.equal(work.status().playbookRuns.length, 2);
  local({
    action: 'compose',
    operationId: randomUUID(),
    intentId: lane.intentId,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  run = work.status().playbookRuns.at(-1);
  assert.equal(run.automation.id, clean.id);
  assert.equal((await wait(work, run.id)).status, 'passed');
  assert.equal(readFileSync(marker, 'utf8'), 'CRV');
  assert.equal(readFileSync(join(work.store.path(lane.id), 'a.ts'), 'utf8'), 'unfinished Lane');
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), view.base);
});

test('delivery changes interrupt only the optional event; invalid/failed acceptance produces no run and edits never substitute commands', async t => {
  const { work, local, dispatch, lane, view, define, book, marker, append } = setup(t);
  const check = define(append('old')),
    playbook = await book([check]);
  const rule = local(
    automationInput(work, playbook, lane.intentId, { event: 'channel-accepted', enabled: true }),
  );
  const accept = {
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: null,
  };
  await assert.rejects(dispatch({ ...accept, expectedHead: '0'.repeat(40) }), code('VIEW_STALE'));
  assert.equal(work.status().playbookRuns.length, 0);
  define(append('replacement'), { checkId: check.id });
  await dispatch(accept);
  let run = work.status().playbookRuns.at(-1);
  assert.equal(run.status, 'interrupted');
  assert.equal(run.steps[0].check.definition, check.definition);
  assert.equal(existsSync(marker), false);
  assert.equal(work.status().channelMoves[0].status, 'accepted');
  assert.equal(work.status().channels[0].head, view.head);
  const refreshed = local(
    automationInput(work, playbook, lane.intentId, {
      automationId: rule.id,
      expectedDefinition: rule.definition,
      event: 'release-created',
      enabled: true,
    }),
  );
  const release = {
    action: 'create-release',
    operationId: randomUUID(),
    acceptanceId: accept.operationId,
    expectedHead: view.head,
    name: 'Runtime test',
  };
  const old = process.env.TZ;
  process.env.TZ = 'Forge/QA';
  try {
    await dispatch(release);
    run = work.status().playbookRuns.at(-1);
    assert.equal(run.status, 'interrupted');
    assert.equal(work.status().releases.length, 1);
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
  await dispatch(release, 0);
  assert.equal(work.status().playbookRuns.length, 2);
  assert.equal(existsSync(marker), false);
  await dispatch({ ...accept, operationId: randomUUID(), expectedPrevious: view.head });
  assert.equal(work.status().playbookRuns.length, 2, 'Changing the rule event stops the old trigger.');
  assert.equal(work.status().automations[0].event, refreshed.event);
  assert.equal(work.status().playbookRuns[0].automation.event, 'channel-accepted');
});

test('lost committed Channel/release event registration never relaunches on receipt retry, even after later acceptance and rule changes', async t => {
  const { work, local, dispatch, lane, view, define, book, marker, append } = setup(t);
  for (const event of ['channel-accepted', 'release-created'])
    local(
      automationInput(work, await book([define(append(event))]), lane.intentId, { event, enabled: true }),
    );
  const accept = {
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'main',
    viewId: view.id,
    expectedHead: view.head,
    expectedPrevious: null,
  };
  const save = work.store.save.bind(work.store);
  let failedEvent;
  work.store.save = data => {
    save(data);
    const event = data.playbookRuns.at(-1)?.automation.event;
    if (event && event !== failedEvent) {
      failedEvent = event;
      throw new Error('Lost committed event reply');
    }
  };
  await assert.rejects(dispatch(accept), /Lost committed event reply/);
  assert.equal((await dispatch(accept, 0)).result.status, 'accepted');
  const release = {
    action: 'create-release',
    operationId: randomUUID(),
    acceptanceId: accept.operationId,
    expectedHead: view.head,
    name: 'Lost reply',
  };
  await assert.rejects(dispatch(release), /Lost committed event reply/);
  work.store.save = save;
  assert.equal((await dispatch(release, 0)).result.id, release.operationId);
  assert.equal(work.status().playbookRuns.length, 2);
  assert.ok(work.status().playbookRuns.every(r => r.status === 'interrupted'));
  assert.equal(work.status().runs.length, 0);
  assert.equal(existsSync(marker), false);
  for (const rule of work.status().automations)
    local({
      action: 'automation-enabled',
      automationId: rule.id,
      expectedDefinition: rule.definition,
      enabled: false,
    });
  const later = await dispatch({ ...accept, operationId: randomUUID(), expectedPrevious: view.head });
  await dispatch(accept, 0);
  await dispatch(release, 0);
  assert.equal(work.status().channels[0].moveId, later.result.id);
  assert.equal(work.status().playbookRuns.length, 2);
});
