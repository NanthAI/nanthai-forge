// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { WorkService } from '../dist/work.js';
import { initNative } from '../dist/native-work.js';
import { checkEnvironment, recoverRuns, adoptModalRun } from '../dist/work-run.js';
import { checkRoute, balanceShards, modalMonthCost } from '../dist/check-backend.js';
import { policyPreset, editedPolicy, effectivePolicy } from '../dist/autonomy-policy.js';
import { launchModalRun } from '../dist/work-modal-run.js';
import { ForgeError } from '../dist/errors.js';
import { CheckQueue } from '../dist/check-queue.js';
import { modalClient } from '../dist/modal-client.js';

function fixture(t, files = {}) {
  // Mock clients must not wait behind real checks in the owner's Modal pool.
  if (process.env.FORGE_MODAL_SMOKE !== '1') {
    const acquire = CheckQueue.prototype.tryAcquire;
    t.mock.method(CheckQueue.prototype, 'tryAcquire', function () {
      return this.path.includes('/modal-check-queue/') ? true : acquire.call(this);
    });
  }
  const root = mkdtempSync(join(tmpdir(), 'forge-modal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'fixture.txt'), 'synthetic source\n');
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  initNative(root);
  const work = new WorkService(root);
  const act = command => work.execute(command, work.store.load().revision).result;
  const intent = act({ action: 'intent', outcome: 'Synthetic Modal check' });
  const lane = act({ action: 'lane', intentId: intent.id, name: 'Candidate' });
  const view = act({
    action: 'compose',
    intentId: intent.id,
    inputs: [{ laneId: lane.id, head: lane.head }],
  });
  const check = act({
    action: 'define-check',
    name: 'Tiny synthetic check',
    executable: process.execPath,
    args: ['-e', 'console.log("synthetic smoke passed")'],
  });
  const run = {
    id: randomUUID(),
    viewId: view.id,
    head: view.head,
    base: view.base,
    inputs: view.inputs,
    dependencies: [],
    check,
    environment: checkEnvironment(),
    status: 'queued',
    startedAt: new Date().toISOString(),
    runner: { pid: process.pid, host: hostname() },
    details: 'Synthetic fixture',
    backend: { requested: 'modal', actual: 'modal' },
  };
  work.store.locked(() => {
    const tx = work.store.records();
    tx.append('runs', run);
    work.store.commitRecords(tx);
  });
  const path = join(work.store.directory, `check-${run.id}`);
  return { work, run, path };
}
function result(plan, patch = {}) {
  return {
    kind: 'result',
    pin: plan.pin,
    head: plan.head,
    definition: plan.definition,
    exitCode: 0,
    estimatedCostUsd: 0.001,
    ...patch,
  };
}
const read = path => JSON.parse(readFileSync(path, 'utf8'));

test('policy selects Modal and preserves local defaults and declared secret inputs', () => {
  const policy = editedPolicy(policyPreset('trusted'), {
    action: 'set-policy',
    operationId: randomUUID(),
    checks: { runner: 'modal' },
  });
  assert.equal(policy.checks.runner, 'modal');
  assert.equal(policy.checks.fallback, 'manual');
  for (const preset of ['supervised', 'trusted', 'autonomous']) {
    const unconfigured = policyPreset(preset);
    assert.equal(unconfigured.checks, undefined);
    assert.equal(effectivePolicy({ autonomyPolicy: unconfigured }).checks, undefined);
    assert.equal(editedPolicy(unconfigured, { notify: { awaySummary: false } }).checks, undefined);
  }
  assert.equal(effectivePolicy({}).checks, undefined);
  assert.equal(
    effectivePolicy({ autonomyPolicy: { ...policy, checks: { runner: 'modal' } } }).checks.fallback,
    'manual',
  );
  const local = editedPolicy(policy, { checks: { fallback: 'local' } });
  assert.deepEqual(local.checks, { runner: 'modal', fallback: 'local' });
  assert.deepEqual(editedPolicy(local, { checks: { runner: 'local' } }).checks, {
    runner: 'local',
    fallback: 'local',
  });
  assert.equal(checkRoute('modal', {}, true).actual, 'modal');
  for (const patch of [{ env: ['PRIVATE_VALUE'] }, { credentials: ['TOKEN'] }]) {
    const route = checkRoute('modal', patch, true);
    assert.equal(route.actual, 'local');
    assert.match(route.fallback, /owner machine/);
  }
  assert.equal(checkRoute('local', {}, true).actual, 'local');
  assert.equal(checkRoute('modal', {}, false).actual, 'local');
});

test('whole-file balancing is stable, complete, duration-aware and scales to sixteen', () => {
  const files = Array.from({ length: 32 }, (_, i) => `tests/${i}.test.mjs`);
  const durations = Object.fromEntries(files.map((file, i) => [file, i < 4 ? 100 : 1]));
  const groups = balanceShards(files, durations);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups.flat().sort(), [...files].sort());
  assert.ok(groups.every(group => group.filter(file => durations[file] === 100).length === 1));
  assert.deepEqual(groups, balanceShards([...files].reverse(), durations));
  assert.equal(balanceShards(files, durations, true).length, 16);
  assert.deepEqual(balanceShards([], {}, true), []);
});

test('mock client streams numbered progress, binds outcome/cost and persists duration observations', async t => {
  const { work, run, path } = fixture(t);
  const handled = await launchModalRun(work.store, run, async (file, emit) => {
    const plan = read(file);
    assert.equal(plan.head, run.head);
    assert.equal(plan.definition, run.check.definition);
    assert.equal(read(join(path, 'modal-state.json')).kind, 'forge-source-state');
    assert.ok(existsSync(join(process.env.FORGE_CHECK_QUEUE_DIR, 'modal-check-queue')));
    emit({ kind: 'progress', message: 'started fixture' });
    emit({ kind: 'execution', executionId: 'sb-synthetic', image: 'im-synthetic' });
    emit({ kind: 'log', executionId: 'sb-synthetic', stream: 'stdout', line: 0, text: 'synthetic output\n' });
    emit(result(plan));
  });
  assert.equal(handled, true);
  const receipt = read(join(path, 'result.json'));
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.backend.estimatedCostUsd, 0.001);
  assert.deepEqual(receipt.backend.executionIds, ['sb-synthetic']);
  const log = readFileSync(join(path, 'stdout.log'), 'utf8');
  assert.match(log, /\[modal 1\].*Pinned/);
  assert.match(log, /\[modal 2\] started fixture/);
  assert.match(log, /synthetic output/);
  assert.equal(modalMonthCost([{ ...run, backend: receipt.backend }]).estimatedCostUsd, 0.001);
  assert.equal(
    modalMonthCost([{ ...run, startedAt: '2000-01-01', backend: receipt.backend }]).recordedRuns,
    0,
  );
});

for (const category of ['auth', 'network', 'billing'])
  test(`confirmed ${category} failure uses explicitly enabled local fallback`, async t => {
    const { work, run, path } = fixture(t);
    await work.dispatch(
      { action: 'set-policy', operationId: randomUUID(), checks: { fallback: 'local' } },
      work.store.revision(),
    );
    assert.equal(
      await launchModalRun(work.store, run, async (_, emit) =>
        emit({ kind: 'error', category, safeFallback: true }),
      ),
      false,
    );
    assert.equal(existsSync(join(path, 'result.json')), false);
    assert.equal(run.backend.actual, 'local');
    assert.match(run.backend.fallback, new RegExp(category));
    assert.equal(work.store.select('runs', run.id).backend.actual, 'local');
    assert.match(readFileSync(join(path, 'stdout.log'), 'utf8'), /local fallback/);
  });

test('test failures and ambiguous transport outcomes never trigger local retries', async t => {
  for (const event of [
    {
      kind: 'error',
      category: 'network',
      safeFallback: false,
      details: 'Modal network failure during collection; executions: sb-fixture',
    },
    { exitCode: 7, details: 'Shard 0: exit 7' },
    { exitCode: 137, details: 'Shard 0: out of memory (137)' },
  ]) {
    const { work, run, path } = fixture(t);
    assert.equal(
      await launchModalRun(work.store, run, async (file, emit) =>
        emit(event.kind ? event : result(read(file), event)),
      ),
      true,
    );
    const receipt = read(join(path, 'result.json'));
    assert.equal(receipt.status, event.kind ? 'interrupted' : 'failed');
    assert.equal(receipt.exitCode, event.kind ? null : event.exitCode);
    assert.ok(receipt.details.includes(event.details));
    assert.equal(run.backend.actual, 'modal');
  }
});

test('mismatched source, definition or selection/runtime pin cannot publish passing evidence', async t => {
  for (const patch of [{ head: '0'.repeat(64) }, { definition: '0'.repeat(64) }, { pin: '0'.repeat(64) }]) {
    const { work, run, path } = fixture(t);
    await launchModalRun(work.store, run, async (file, emit) => emit(result(read(file), patch)));
    assert.equal(read(join(path, 'result.json')).status, 'interrupted');
    assert.equal(work.store.select('runs', run.id).status, 'interrupted');
  }
});

test('restart reuses retained plan and execution IDs; replayed logs are deduplicated', async t => {
  const { work, run, path } = fixture(t);
  let original;
  await launchModalRun(work.store, run, async (file, emit) => {
    original = read(file);
    emit({ kind: 'execution', executionId: 'sb-existing', image: 'im-existing' });
    emit({ kind: 'log', executionId: 'sb-existing', stream: 'stdout', line: 0, text: 'once\n' });
    throw new Error('simulated controller exit');
  });
  run.status = 'running';
  await launchModalRun(work.store, run, async (file, emit) => {
    assert.deepEqual(read(file), original);
    assert.deepEqual(run.backend.executionIds, ['sb-existing']);
    emit({ kind: 'execution', executionId: 'sb-existing', image: 'im-existing' });
    emit({ kind: 'log', executionId: 'sb-existing', stream: 'stdout', line: 0, text: 'once\n' });
    emit(result(original));
  });
  assert.equal(read(join(path, 'result.json')).status, 'passed');
  assert.equal(readFileSync(join(path, 'stdout.log'), 'utf8').split('once\n').length - 1, 1);
  run.status = 'running';
  assert.equal(recoverRuns(work.store, { runs: [run] }), true);
  assert.equal(run.status, 'passed');
});

test('remote admission does not consume local check slots', async t => {
  const { CheckQueue, queueEntries } = await import('../dist/check-queue.js');
  const { work, run } = fixture(t);
  const dir = mkdtempSync(join(tmpdir(), 'forge-local-slots-'));
  const before = process.env.FORGE_CHECK_QUEUE_DIR;
  process.env.FORGE_CHECK_QUEUE_DIR = dir;
  const local = new CheckQueue(dir, { limit: 1 });
  t.after(() => {
    local.release();
    if (before === undefined) delete process.env.FORGE_CHECK_QUEUE_DIR;
    else process.env.FORGE_CHECK_QUEUE_DIR = before;
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(local.tryAcquire(), true);
  await launchModalRun(work.store, run, async (file, emit) => {
    assert.ok(
      queueEntries(join(process.env.FORGE_CHECK_QUEUE_DIR, 'modal-check-queue')).some(
        entry => entry.ticket?.runId === run.id,
      ),
    );
    assert.equal(queueEntries(dir).length, 1);
    emit(result(read(file)));
  });
  assert.equal(local.tryAcquire(), true);
});

test(
  'one real tiny Modal smoke (explicit opt-in)',
  { skip: process.env.FORGE_MODAL_SMOKE !== '1' },
  async t => {
    const { work, run, path } = fixture(t);
    assert.equal(await launchModalRun(work.store, run, modalClient), true);
    const receipt = read(join(path, 'result.json'));
    assert.equal(receipt.status, 'passed');
    assert.ok(receipt.backend.estimatedCostUsd < 0.05);
    assert.match(readFileSync(join(path, 'stdout.log'), 'utf8'), /synthetic smoke passed/);
    console.log(`Modal smoke allocation estimate: $${receipt.backend.estimatedCostUsd.toFixed(6)}`);
  },
);

test('cancellation during a remote check reaches the control file and records cancelled', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { work, run, path } = fixture(t);
  await launchModalRun(work.store, run, async (file, emit) => {
    work.store.locked(() => {
      const tx = work.store.records(),
        selected = tx.find('runs', run.id);
      selected.record.cancelRequested = true;
      tx.replace('runs', selected.position, selected.record);
      work.store.commitRecords(tx);
    });
    // Fake interval drives the owner cancellation monitor, without a timing-dependent wait.
    t.mock.timers.tick(250);
    assert.equal(readFileSync(join(path, 'modal-cancel'), 'utf8'), 'cancel');
    emit(result(read(file), { exitCode: 1 }));
  });
  assert.equal(read(join(path, 'result.json')).status, 'cancelled');
});

test('remote artifacts stream selected bytes and reject digest/selection changes', async t => {
  for (const corrupt of [false, true]) {
    const { work, run, path } = fixture(t);
    run.check.artifactPaths = ['output.bin'];
    const bytes = Buffer.from('synthetic artifact');
    await launchModalRun(work.store, run, async (file, emit) => {
      emit({
        kind: 'artifactChunk',
        index: 0,
        sourcePath: 'output.bin',
        offset: 0,
        base64: bytes.toString('base64'),
      });
      emit({
        kind: 'artifactEnd',
        index: 0,
        sourcePath: 'output.bin',
        size: bytes.length,
        sha256: corrupt ? '0'.repeat(64) : createHash('sha256').update(bytes).digest('hex'),
      });
      emit(result(read(file)));
    });
    if (corrupt) assert.equal(read(join(path, 'result.json')).status, 'interrupted');
    else {
      const receipt = read(join(path, 'result.json'));
      assert.equal(receipt.artifacts[0].status, 'retained');
      assert.deepEqual(readFileSync(join(path, 'artifacts', 'artifact-0.bin')), bytes);
    }
  }
});

test('recorded whole-file durations feed subsequent balancing', async t => {
  const { work, run, path } = fixture(t, { 'tests/alpha.test.mjs': '// synthetic test source' });
  run.check.args = ['scripts/forge-check.mjs'];
  await launchModalRun(work.store, run, async (file, emit) => {
    const plan = read(file);
    assert.deepEqual(plan.selection.tests, ['tests/alpha.test.mjs']);
    emit({ kind: 'timing', file: 'tests/alpha.test.mjs', seconds: 1.25 });
    emit({ kind: 'timing', file: 'tests/unselected.test.mjs', seconds: 100 });
    emit(result(plan));
  });
  assert.equal(read(join(path, 'result.json')).status, 'passed');
  assert.deepEqual(read(join(work.store.directory, 'modal-durations.json')), {
    'tests/alpha.test.mjs': 1.25,
  });
});

test('restart ownership is claimed atomically; concurrent observers start one adopter', async t => {
  const { work, run } = fixture(t);
  work.store.locked(() => {
    const tx = work.store.records(),
      selected = tx.find('runs', run.id);
    selected.record.runner.pid = 2147483647;
    tx.replace('runs', selected.position, selected.record);
    work.store.commitRecords(tx);
  });
  let starts = 0;
  const start = async (_store, selected) => {
    starts++;
    assert.equal(selected.runner.pid, process.pid);
  };
  await Promise.all([adoptModalRun(work.store, run.id, start), adoptModalRun(work.store, run.id, start)]);
  assert.equal(starts, 1);
});

test('controller errors retain safe message details and execution IDs without retrying', async t => {
  const { work, run, path } = fixture(t);
  const secret = 'synthetic-modal-token-value';
  const previousSecret = process.env.MODAL_TOKEN_SECRET;
  process.env.MODAL_TOKEN_SECRET = secret;
  t.after(() => {
    if (previousSecret === undefined) delete process.env.MODAL_TOKEN_SECRET;
    else process.env.MODAL_TOKEN_SECRET = previousSecret;
  });
  let calls = 0;
  const packagePath = new URL('../scripts/script-impact.mjs', import.meta.url).pathname;
  const error = new Error(
    `Cannot find module '${packagePath}' imported from '${new URL('../scripts/test-impact.mjs', import.meta.url).href}'; token=${secret}; password="synthetic password"; /private/owner/config; C:\\private\\config; https://user:pass@example.invalid/private`,
  );
  error.stack = 'PRIVATE STACK MUST NEVER APPEAR';
  assert.equal(
    await launchModalRun(work.store, run, async (_, emit) => {
      calls++;
      emit({ kind: 'execution', executionId: 'sb-retained-error', image: 'im-error' });
      throw error;
    }),
    true,
  );
  assert.equal(calls, 1);
  const saved = work.store.select('runs', run.id);
  const receipt = read(join(path, 'result.json'));
  assert.equal(saved.status, 'interrupted');
  assert.equal(receipt.status, 'interrupted');
  assert.equal(receipt.details, saved.details);
  assert.equal(receipt.backend.actual, 'modal');
  assert.deepEqual(receipt.backend.executionIds, ['sb-retained-error']);
  for (const text of [receipt.details, readFileSync(join(path, 'stdout.log'), 'utf8')]) {
    assert.match(text, /Cannot find module 'scripts\/script-impact.mjs'/);
    assert.match(text, /scripts\/test-impact.mjs/);
    for (const privateText of [
      secret,
      'synthetic password',
      '/private/owner',
      'C:',
      'user:pass',
      'PRIVATE STACK',
      new URL('..', import.meta.url).pathname,
    ])
      assert.ok(!text.includes(privateText), privateText);
  }
});

for (const category of ['auth', 'network', 'billing'])
  test(`default manual ${category} failure is terminal infrastructure evidence, not test failure`, async t => {
    const { work, run, path } = fixture(t);
    assert.equal(
      await launchModalRun(work.store, run, async (_, emit) =>
        emit({ kind: 'error', category, safeFallback: true }),
      ),
      true,
    );
    const receipt = read(join(path, 'result.json'));
    const expected = category === 'billing' ? 'runner-budget-exhausted' : 'runner-unavailable';
    assert.equal(receipt.status, expected);
    assert.equal(receipt.backend.actual, 'modal');
    assert.equal(receipt.exitCode, null);
    assert.match(receipt.details, /Retry with a new run\/finish operation/);
    assert.match(receipt.details, /set-policy/);
    assert.equal(recoverRuns(work.store, { runs: [run] }), true);
    assert.equal(run.status, expected);
    const { recoverPlaybooks } = await import('../dist/work-playbook.js');
    const sequence = {
      status: 'running',
      steps: [{ runId: run.id }],
      runner: run.runner,
      onFailure: 'continue',
    };
    assert.equal(recoverPlaybooks({ runs: [run], playbookRuns: [sequence] }), true);
    assert.equal(sequence.status, expected);
    // An unlimited observer must return immediately for the durable terminal receipt.
    const { waitForAgentRun } = await import('../dist/agent-run-observer.js');
    await waitForAgentRun(work.store, run.id);
    assert.equal(work.store.select('runs', run.id).status, expected);
    assert.equal(existsSync(join(path, 'workspace')), false);
  });

for (const provenance of ['native', 'git', 'parent', 'dependency', 'pr'])
  test(`local fallback never executes ${provenance} contributor candidates`, async t => {
    const { work, run, path } = fixture(t);
    await work.dispatch(
      { action: 'set-policy', operationId: randomUUID(), checks: { fallback: 'local' } },
      work.store.revision(),
    );
    work.store.locked(() => {
      const tx = work.store.records();
      const selected = tx.find('lanes', run.inputs[0].laneId);
      if (provenance === 'git')
        selected.record.contribution = {
          request: run.head,
          head: run.head,
          base: run.base,
          ref: 'refs/heads/contribution',
          size: 1,
          sha256: run.head,
          at: new Date().toISOString(),
          provenance: 'unverified-git-bundle',
        };
      else if (provenance === 'parent') {
        const parent = { ...selected.record, id: randomUUID(), nativeContributionId: randomUUID() };
        tx.append('lanes', parent);
        selected.record.parent = { laneId: parent.id, head: parent.head };
      } else if (provenance === 'dependency') {
        const otherLane = { ...selected.record, id: randomUUID(), nativeContributionId: randomUUID() };
        tx.append('lanes', otherLane);
        const originalView = work.store.select('views', run.viewId);
        const view = {
          ...originalView,
          id: randomUUID(),
          inputs: [{ laneId: otherLane.id, head: otherLane.head }],
        };
        tx.append('views', view);
        run.dependencies = [{ kind: 'view', viewId: view.id, head: view.head }];
      } else if (provenance === 'pr') {
        run.dependencies = [
          { kind: 'pr', intentId: selected.record.intentId, observation: 0, head: run.head },
        ];
      } else selected.record.nativeContributionId = randomUUID();
      tx.replace('lanes', selected.position, selected.record);
      work.store.commitRecords(tx);
    });
    assert.equal(
      await launchModalRun(work.store, run, async (_, emit) =>
        emit({ kind: 'error', category: 'network', safeFallback: true }),
      ),
      true,
    );
    assert.equal(read(join(path, 'result.json')).status, 'runner-unavailable');
    assert.equal(run.backend.actual, 'modal');
    assert.equal(existsSync(join(path, 'workspace')), false);
  });

for (const category of ['network', 'billing'])
  test(`finish reports retryable ${category} infrastructure outcome and preserves replay`, async t => {
    const { agentFinish } = await import('../dist/agent-finish.js');
    const { waitForAgentRun } = await import('../dist/agent-run-observer.js');
    const { work, run } = fixture(t);
    const lane = work.store.select('lanes', run.inputs[0].laneId);
    const view = work.store.select('views', run.viewId);
    const command = {
      action: 'finish',
      operationId: randomUUID(),
      laneId: lane.id,
      message: 'Synthetic finish',
      dependencies: [],
      checkId: run.check.id,
      expectedDefinition: run.check.definition,
    };
    let calls = 0;
    const phases = {
      checkpoint: async () => ({ result: { head: lane.head } }),
      sync: async () => {
        throw Error('Unexpected sync');
      },
      review: async () => {
        throw Error('Unexpected review');
      },
      phase: async request => {
        if (request.action === 'compose') return { revision: work.store.revision(), result: view };
        assert.equal(request.action, 'run-check');
        run.id = request.operationId;
        work.store.locked(() => {
          const tx = work.store.records();
          tx.append('runs', run);
          work.store.commitRecords(tx);
        });
        await launchModalRun(work.store, run, async (_, emit) => {
          calls++;
          emit({ kind: 'error', category, safeFallback: true });
        });
        return { revision: work.store.revision(), result: run };
      },
      wait: id => waitForAgentRun(work.store, id),
    };
    const response = await agentFinish(work, command, phases);
    assert.equal(
      response.result.status,
      category === 'billing' ? 'runner-budget-exhausted' : 'runner-unavailable',
    );
    assert.equal(response.result.retryable, true);
    assert.equal(response.result.terminal, true);
    assert.equal(response.result.complete, false);
    assert.match(response.result.message, /set-policy/);
    assert.equal(response.result.run.failureSummary, undefined);
    assert.deepEqual((await agentFinish(work, command, phases)).result, response.result);
    assert.equal(calls, 1);
  });

for (const fallback of ['manual', 'local'])
  test(`source credential routing respects ${fallback} fallback policy`, async t => {
    const { work, run, path } = fixture(t);
    // Native capture excludes credentials; imported retained States can still contain them.
    const { NativeSource } = await import('../dist/native-source.js');
    const source = new NativeSource(work.store.root);
    run.head = source.writeState(
      [
        ...source.state(run.head).files,
        { path: '.npmrc', mode: 'file', blob: source.put(Buffer.from('# synthetic local configuration')) },
      ],
      [run.head],
      'Synthetic imported configuration',
      new Date().toISOString(),
    );
    await work.dispatch(
      { action: 'set-policy', operationId: randomUUID(), checks: { fallback } },
      work.store.revision(),
    );
    assert.equal(
      await launchModalRun(work.store, run, async () => {
        throw Error('Source must not upload');
      }),
      fallback !== 'local',
    );
    if (fallback === 'manual') assert.equal(read(join(path, 'result.json')).status, 'runner-unavailable');
    else assert.equal(run.backend.actual, 'local');
  });

for (const phase of ['admission', 'interval'])
  test(`cancellation ${phase} poll retries SOURCE_CHANGED on the next tick`, async t => {
    const { work, run, path } = fixture(t);
    const select = work.store.select.bind(work.store);
    let raced = false,
      observations = 0;
    const race = () => {
      t.mock.method(work.store, 'select', (...args) => {
        observations++;
        if (!raced) {
          raced = true;
          throw new ForgeError('SOURCE_CHANGED', 'Synthetic concurrent record replacement');
        }
        return select(...args);
      });
    };
    if (phase === 'admission') {
      const acquire = CheckQueue.prototype.tryAcquire;
      let attempts = 0;
      t.mock.method(CheckQueue.prototype, 'tryAcquire', function () {
        if (++attempts === 1) return false;
        return acquire.call(this);
      });
      race();
    } else t.mock.timers.enable({ apis: ['setInterval'] });
    let calls = 0;
    await launchModalRun(work.store, run, async (file, emit) => {
      calls++;
      if (phase === 'interval') {
        race();
        t.mock.timers.tick(250);
        assert.equal(raced, true);
        assert.equal(existsSync(join(path, 'modal-cancel')), false);
        t.mock.timers.tick(250);
        assert.equal(observations, 2);
      }
      emit(result(read(file)));
    });
    assert.equal(raced, true);
    assert.equal(calls, 1);
    assert.equal(read(join(path, 'result.json')).status, 'passed');
  });

for (const phase of ['admission', 'interval'])
  test(`non-transient cancellation ${phase} error records an interrupted run`, async t => {
    const { work, run, path } = fixture(t);
    const fail = () =>
      t.mock.method(work.store, 'select', () => {
        throw new ForgeError('INVALID_WORK_STORE', 'Synthetic invalid run record');
      });
    if (phase === 'admission') {
      t.mock.method(CheckQueue.prototype, 'tryAcquire', () => false);
      fail();
    } else t.mock.timers.enable({ apis: ['setInterval'] });
    let calls = 0,
      lateEvent,
      started;
    const ready = new Promise(resolve => {
      started = resolve;
    });
    const launched = launchModalRun(work.store, run, async (file, emit) => {
      lateEvent = () => emit(result(read(file)));
      calls++;
      fail();
      started();
      // The controller must reject even when the remote client has not settled.
      await new Promise(() => {});
    });
    if (phase === 'interval') {
      await ready;
      // Drive the timer outside the client's async error boundary.
      assert.doesNotThrow(() => t.mock.timers.tick(250));
    }
    await launched;
    lateEvent?.();
    assert.equal(calls, phase === 'admission' ? 0 : 1);
    const receipt = read(join(path, 'result.json'));
    assert.equal(receipt.status, 'interrupted');
    assert.match(receipt.details, /Synthetic invalid run record/);
    assert.equal(run.backend.actual, 'modal');
  });

test('interleaved Modal shards retain attributable logs, error bodies and agent log tails', async t => {
  const { AgentWorkflow } = await import('../dist/agent-workflow.js');
  const { runReceiptWithFailure } = await import('../dist/agent-run-failure.js');
  const { work, run, path } = fixture(t, {
    'tests/alpha.test.mjs': '// synthetic test',
    'tests/beta.test.mjs': '// synthetic test',
  });
  run.check.args = ['scripts/forge-check.mjs'];
  let staticIndex;
  await launchModalRun(work.store, run, async (file, emit) => {
    const plan = read(file);
    staticIndex = plan.groups.length;
    for (const [executionId, index] of [
      ['sb-fail', 0],
      ['sb-pass', staticIndex],
    ])
      emit({ kind: 'execution', executionId, index, attempt: 0, image: 'im-test' });
    const log = (executionId, line, text, stream = 'stdout') =>
      emit({ kind: 'log', executionId, line, text, stream });
    log('sb-fail', 0, 'not ok 1 - synthetic failure\n');
    log('sb-pass', 0, 'ok 1 - unrelated passing test\n');
    log('sb-fail', 1, '  ---\n  error: synthetic expected value\n');
    log('sb-pass', 1, 'UNRELATED DIAGNOSTIC\n', 'stderr');
    log('sb-fail', 0, 'not ok 1 - synthetic failure\n'); // Replay is deduplicated in both logs.
    log(
      'sb-fail',
      2,
      '  code: ERR_ASSERTION\n  ...\nnot ok 2 - second failure\n  ---\n  error: second body\n  ...\n',
    );
    emit(
      result(plan, {
        exitCode: 1,
        executions: [
          { executionId: 'sb-fail', index: 0, attempt: 0, exitCode: 1 },
          { executionId: 'sb-pass', index: staticIndex, attempt: 0, exitCode: 0 },
        ],
      }),
    );
  });
  const receipt = read(join(path, 'result.json'));
  assert.equal(receipt.status, 'failed');
  assert.match(receipt.failureSummary, /Shard 0, attempt 1, exit 1: check-.*\/shards\/0.log/);
  assert.match(receipt.failureSummary, /synthetic failure\n  ---\n  error: synthetic expected value/);
  assert.match(receipt.failureSummary, /second failure\n  ---\n  error: second body/);
  assert.doesNotMatch(receipt.failureSummary, /unrelated|UNRELATED/);
  const failingLog = readFileSync(join(path, 'shards', '0.log'), 'utf8');
  assert.equal(failingLog.split('not ok 1').length - 1, 1);
  assert.doesNotMatch(failingLog, /UNRELATED/);
  assert.match(readFileSync(join(path, 'shards', 'static.log'), 'utf8'), /UNRELATED DIAGNOSTIC/);
  assert.match(
    readFileSync(join(path, 'stdout.log'), 'utf8'),
    /synthetic failure[\s\S]*unrelated passing test/,
  );
  assert.equal(recoverRuns(work.store, { runs: [run] }), true);
  assert.equal(runReceiptWithFailure(work.store, run).failureSummary, receipt.failureSummary);
  const agent = new AgentWorkflow(work.store.root);
  const tail = (await agent.dispatch({ action: 'log', operationId: run.id, shard: 0, tail: 25 })).result;
  assert.equal(tail.text, Buffer.from(failingLog).subarray(-25).toString());
  assert.equal(tail.shard, 0);
  assert.equal(tail.more, false);
  const staticLog = (await agent.dispatch({ action: 'log', operationId: run.id, shard: 'static' })).result;
  assert.match(staticLog.text, /UNRELATED DIAGNOSTIC/);
  await assert.rejects(
    agent.dispatch({ action: 'log', operationId: run.id, shard: '../stdout' }),
    error => error.code === 'BAD_ARGUMENT',
  );
  await assert.rejects(
    agent.dispatch({ action: 'log', operationId: run.id, shard: 999 }),
    error => error.code === 'NOT_FOUND',
  );
});

test('static shard retries and controller adoption keep attempt logs separate and summarize latest outcome', async t => {
  const { AgentWorkflow } = await import('../dist/agent-workflow.js');
  const { work, run, path } = fixture(t);
  let plan;
  await launchModalRun(work.store, run, async (file, emit) => {
    plan = read(file);
    emit({
      kind: 'execution',
      executionId: 'sb-first',
      index: plan.groups.length,
      attempt: 0,
      image: 'im-test',
    });
    emit({ kind: 'log', executionId: 'sb-first', stream: 'stderr', line: 0, text: 'original OOM\n' });
    throw new Error('synthetic disconnect');
  });
  run.status = 'running';
  await launchModalRun(work.store, run, async (_, emit) => {
    emit({
      kind: 'execution',
      executionId: 'sb-first',
      index: plan.groups.length,
      attempt: 0,
      image: 'im-test',
    });
    emit({ kind: 'log', executionId: 'sb-first', stream: 'stderr', line: 0, text: 'original OOM\n' });
    emit({
      kind: 'execution',
      executionId: 'sb-retry',
      index: plan.groups.length,
      attempt: 1,
      image: 'im-test',
    });
    emit({ kind: 'log', executionId: 'sb-retry', stream: 'stderr', line: 0, text: 'retry static failure\n' });
    emit(
      result(plan, {
        exitCode: 2,
        executions: [
          { executionId: 'sb-first', index: plan.groups.length, attempt: 0, exitCode: 137 },
          { executionId: 'sb-retry', index: plan.groups.length, attempt: 1, exitCode: 2 },
        ],
      }),
    );
  });
  assert.equal(readFileSync(join(path, 'shards', 'static.log'), 'utf8'), 'original OOM\n');
  assert.equal(readFileSync(join(path, 'shards', 'static.attempt-2.log'), 'utf8'), 'retry static failure\n');
  const summary = read(join(path, 'result.json')).failureSummary;
  assert.match(summary, /\(static\), attempt 2, exit 2:.*static.attempt-2.log\nretry static failure/);
  assert.doesNotMatch(summary, /original OOM/);
  const agent = new AgentWorkflow(work.store.root);
  assert.equal(
    (await agent.dispatch({ action: 'log', operationId: run.id, shard: 'static', attempt: 2 })).result.text,
    'retry static failure\n',
  );
});

test('retained Modal plan binds the View and exact shard membership before client adoption', async t => {
  for (const change of [
    plan => {
      plan.viewId = randomUUID();
    },
    plan => {
      plan.groups = [['unselected']];
    },
  ]) {
    const { work, run, path } = fixture(t);
    await launchModalRun(work.store, run, async (file, emit) => emit(result(read(file))));
    const plan = read(join(path, 'modal-plan.json'));
    change(plan);
    writeFileSync(join(path, 'modal-plan.json'), JSON.stringify(plan));
    let called = false;
    await launchModalRun(work.store, run, async () => {
      called = true;
    });
    assert.equal(called, false);
    assert.equal(read(join(path, 'result.json')).status, 'interrupted');
    assert.match(read(join(path, 'result.json')).details, /View or plan digest changed/);
  }
});

test('safe network loss records manual recovery with retained completed shards', async t => {
  const { work, run, path } = fixture(t);
  await launchModalRun(work.store, run, async (_, emit) => {
    emit({ kind: 'execution', executionId: 'sb-completed', index: 0, attempt: 0, image: 'im-test' });
    emit({ kind: 'error', category: 'network', safeFallback: true });
  });
  const receipt = read(join(path, 'result.json'));
  assert.equal(receipt.status, 'runner-unavailable');
  assert.equal(receipt.backend.retryable, true);
  assert.equal(receipt.backend.actual, 'modal');
  assert.equal(receipt.failureSummary, undefined);
  assert.match(receipt.details, /Retry with a new run\/finish operation/);
  assert.deepEqual(receipt.backend.executionIds, ['sb-completed']);
  assert.equal(receipt.exitCode, null);
  assert.doesNotMatch(readFileSync(join(path, 'stdout.log'), 'utf8'), /local fallback/);
});

test('named flakes stay distinct from clean passes and only quarantined failures cease blocking', async t => {
  const { work, run, path } = fixture(t, { 'tests/flake.test.mjs': '// synthetic fixture' });
  run.check.args = ['scripts/forge-check.mjs'];
  const identity = 'tests/flake.test.mjs :: intermittent';
  const report = passed => ({
    'tests/flake.test.mjs': {
      file: 'tests/flake.test.mjs',
      complete: true,
      results: [{ name: 'intermittent', passed }],
    },
  });
  const execute = async (failedAgain = false, staticCode = 0, extraFailure = false) => {
    await launchModalRun(work.store, run, async (file, emit) => {
      const plan = read(file);
      const tests = report(!failedAgain);
      if (extraFailure) tests['tests/flake.test.mjs'].results.push({ name: 'unrelated', passed: false });
      for (const [executionId, index, attempt] of [
        ['first', 0, 0],
        ['static', plan.groups.length, 0],
        ['retry', 0, 1],
      ])
        emit({ kind: 'execution', executionId, index, attempt, image: 'im-test' });
      emit(
        result(plan, {
          exitCode: failedAgain || extraFailure ? 1 : staticCode,
          executions: [
            { executionId: 'first', index: 0, attempt: 0, exitCode: 1, tests: report(false) },
            { executionId: 'static', index: plan.groups.length, attempt: 0, exitCode: staticCode },
            {
              executionId: 'retry',
              index: 0,
              attempt: 1,
              exitCode: failedAgain || extraFailure ? 1 : 0,
              tests,
            },
          ],
        }),
      );
    });
    return read(join(path, 'result.json'));
  };
  let receipt = await execute();
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.backend.verdict, 'flake');
  assert.deepEqual(receipt.backend.testVerdicts, [{ test: identity, verdict: 'flake' }]);
  assert.match(receipt.failureSummary, /flake: tests\/flake.test.mjs :: intermittent/);
  const historical = {
    ...run,
    id: randomUUID(),
    status: 'failed',
    endedAt: new Date(Date.now() - 1000).toISOString(),
    backend: receipt.backend,
  };
  work.store.locked(() => {
    const tx = work.store.records();
    tx.append('runs', historical);
    work.store.commitRecords(tx);
  });
  receipt = await execute();
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.backend.verdict, 'flake');
  assert.deepEqual(receipt.backend.quarantine, [{ test: identity, consecutivePasses: 0 }]);
  // Retain the second verdict before checking persistent failure behavior.
  work.store.locked(() => {
    const tx = work.store.records();
    tx.append('runs', {
      ...historical,
      id: randomUUID(),
      endedAt: new Date().toISOString(),
      backend: receipt.backend,
    });
    work.store.commitRecords(tx);
  });
  receipt = await execute(true);
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.exitCode, 1); // The actual failed test outcome stays visible.
  assert.equal(receipt.backend.verdict, 'quarantined');
  assert.equal((await execute(true, 2)).status, 'failed');
  assert.equal((await execute(true, 0, true)).status, 'failed');
});

for (const scenario of [
  { name: 'OOM then pass', first: 137, last: 0, status: 'passed', verdict: 'clean' },
  { name: 'OOM then OOM', first: 137, last: 137, status: 'failed', verdict: 'clean' },
  {
    name: 'sandbox lost then pass',
    infrastructure: 'sandbox-stopped',
    last: 0,
    status: 'passed',
    verdict: 'clean',
  },
  { name: 'named failure then pass', first: 1, named: true, last: 0, status: 'failed', verdict: 'flake' },
  {
    name: 'OOM with named failure then pass',
    first: 137,
    named: true,
    last: 0,
    status: 'failed',
    verdict: 'flake',
  },
  { name: 'unattributed nonzero then pass', first: 1, last: 0, status: 'failed', verdict: 'clean' },
  {
    name: 'OOM then incomplete passing report',
    first: 137,
    last: 0,
    incomplete: true,
    status: 'failed',
    verdict: 'clean',
  },
]) {
  test(`Modal retry verdict: ${scenario.name}`, async t => {
    const file = 'tests/synthetic.test.mjs';
    const { work, run, path } = fixture(t, { [file]: '// synthetic fixture' });
    run.check.args = ['scripts/forge-check.mjs'];
    const report = passed => ({
      [file]: { file, complete: true, results: [{ name: 'synthetic result', passed }] },
    });
    await launchModalRun(work.store, run, async (filename, emit) => {
      const plan = read(filename);
      for (const [executionId, index, attempt] of [
        ['first', 0, 0],
        ['static', plan.groups.length, 0],
        ['retry', 0, 1],
      ])
        emit({ kind: 'execution', executionId, index, attempt, image: 'im-test' });
      emit(
        result(plan, {
          exitCode: scenario.last,
          details: scenario.last === 137 ? 'Shard 0: out of memory (137)' : '',
          executions: [
            {
              executionId: 'first',
              index: 0,
              attempt: 0,
              exitCode: scenario.first,
              infrastructure: scenario.infrastructure,
              ...(scenario.named ? { tests: report(false) } : {}),
            },
            { executionId: 'static', index: plan.groups.length, attempt: 0, exitCode: 0 },
            {
              executionId: 'retry',
              index: 0,
              attempt: 1,
              exitCode: scenario.last,
              ...(!scenario.incomplete ? { tests: report(true) } : {}),
            },
          ],
        }),
      );
    });
    const receipt = read(join(path, 'result.json'));
    assert.equal(receipt.status, scenario.status);
    assert.equal(receipt.backend.verdict, scenario.verdict);
    if (scenario.last === 137) assert.match(receipt.details, /out of memory \(137\)/);
    if (scenario.status === 'passed') {
      assert.deepEqual(receipt.backend.testVerdicts, []);
      assert.deepEqual(receipt.backend.quarantine, []);
    }
  });
}

test('automatic infrastructure recovery keeps finish active and reuses the exact plan', async t => {
  const { work, run, path } = fixture(t);
  let calls = 0,
    retained;
  await launchModalRun(
    work.store,
    run,
    async (file, emit) => {
      calls++;
      const plan = read(file);
      if (calls === 1) {
        retained = plan;
        emit({ kind: 'error', category: 'network', safeFallback: true });
      } else {
        assert.deepEqual(plan, retained);
        assert.equal(existsSync(join(path, 'result.json')), false);
        assert.equal(work.store.select('runs', run.id).status, 'running');
        emit(result(plan));
      }
    },
    1,
  );
  assert.equal(calls, 2);
  assert.equal(read(join(path, 'result.json')).status, 'passed');
  assert.match(readFileSync(join(path, 'stdout.log'), 'utf8'), /retrying the same View\/plan once/);
});
