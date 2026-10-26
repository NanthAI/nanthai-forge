// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { checkRunSchema } from '../dist/work-types.js';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './landing-batch-fixture.mjs';
import { batchEdit, selectBatch, composeBatch, enqueueLanding } from '../dist/landing-batch-store.js';
import { evaluateBatch } from '../dist/landing-batch-check.js';
import { advanceLandingBatch } from '../dist/landing-batch-step.js';
import { reuseLandingCheck, validateReusedCheck } from '../dist/landing-check-reuse.js';
import { validatePassingPrefix } from '../dist/landing-diagnosis.js';
import { queueObservation } from '../dist/landing-observation.js';
import { NativeSource } from '../dist/native-source.js';
import { digest } from '../dist/hash.js';
import { partitionTests } from '../scripts/test-shards.mjs';
import { runReceipt } from '../dist/agent-receipts.js';
import { waitRun } from '../dist/agent-wait-run.js';
import { trainAccounting } from '../dist/train-accounting.js';

const driver = { beforePublish() {} };
async function prepared(t, options = {}, definition) {
  const f = await fixture(t, options);
  if (definition) {
    const current = f.store.load().checks[0];
    await f.agent.dispatch({
      action: 'define-check',
      checkId: current.id,
      name: current.name,
      executable: current.executable,
      args: current.args,
      ...definition(f),
    });
  }
  const input = await f.candidate('fsevents.txt', undefined, false);
  if (f.store.load().checks[0].args[0] === 'scripts/forge-check.mjs') {
    mkdirSync(join(input.lane.path, 'tests'));
    for (let i = 0; i < 20; i++)
      writeFileSync(join(input.lane.path, 'tests', `synthetic-${i}.test.mjs`), '// synthetic test source\n');
    const saved = (
      await f.agent.dispatch({
        action: 'checkpoint',
        laneId: input.lane.laneId,
        message: 'Synthetic test inventory',
      })
    ).result;
    const composed = (
      await f.agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        laneId: input.lane.laneId,
        intentId: input.lane.intentId,
        inputs: [{ laneId: input.lane.laneId, head: saved.head }],
        dependencies: [],
      })
    ).result;
    input.view = f.store.select('views', composed.viewId);
    input.command.expectedHead = saved.head;
  }
  await enqueueLanding(f.work, input.command, input.view);
  const first = await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
  await composeBatch(f.work, first);
  const originalBatch = f.store.select('landingBatches', first.id);
  await evaluateBatch(f.work, originalBatch, driver);
  const original = f.store.select('runs', originalBatch.prefixes[0].runId);
  assert.equal(original.status, 'passed');
  await batchEdit(f.work, 'interrupted-after-pass', data => {
    data.landingBatches[0].status = 'superseded';
    data.landingEntries[0].status = 'interrupted';
    data.landingEntries[0].reason = 'Queued landing pins changed: cli';
  });
  async function resubmit() {
    const command = { ...input.command, operationId: randomUUID() };
    await enqueueLanding(f.work, command, input.view);
    await batchEdit(f.work, 'different-submitting-cli', data => {
      data.landingEntries.at(-1).runtimeSnapshot.cli = 'a-different-submitting-cli';
    });
    const selected = await batchEdit(f.work, 'select-next', data => selectBatch(f.work, data, 'main'));
    assert.ok(selected, 'CLI change does not invalidate the check inputs');
    await composeBatch(f.work, selected);
    const batch = f.store.select('landingBatches', selected.id);
    return { batch, prefix: batch.prefixes[0], entryId: command.operationId };
  }
  return { ...f, input, original, resubmit, ...(await resubmit()) };
}

for (const remote of [true, false])
  test(`${remote ? 'remote' : 'local'} identical inputs reuse a passed check across CLI interruption and repeated resubmissions`, async t => {
    const f = await prepared(t, { remote });
    const dispatch = f.work.dispatch.bind(f.work);
    f.work.dispatch = (...args) => {
      assert.notEqual(args[0].action, 'run-check', 'a retained pass must never dispatch again');
      return dispatch(...args);
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const reused = await reuseLandingCheck(f.work, f.batch, f.prefix, driver);
      assert.equal(reused.reusedFrom.runId, f.original.id);
      assert.equal(reused.reusedFrom.endedAt, f.original.endedAt);
      assert.equal(reused.viewId, f.prefix.viewId);
      assert.equal(reused.runner.pid, 0);
      assert.equal(checkRunSchema.safeParse({ ...reused, reusedFrom: undefined }).success, false);
      assert.equal(checkRunSchema.safeParse({ ...reused, runner: f.original.runner }).success, false);
      assert.equal(
        z.object({ pid: z.number().int().positive(), host: z.string() }).safeParse(reused.runner).success,
        false,
        'older readers must reject virtual checks instead of dropping source provenance',
      );
      const receipt = runReceipt(reused);
      assert.equal(receipt.reuse, 'reused');
      assert.equal(receipt.reusedFrom.runId, f.original.id);
      assert.equal(receipt.diagnostic, `reused check ${f.original.id} from ${f.original.endedAt}`);
      const waited = waitRun(f.store, reused).event;
      assert.equal(waited.reusedFrom.runId, f.original.id);
      assert.equal(waited.logPath, join(f.store.directory, `check-${f.original.id}`, 'stdout.log'));
      validatePassingPrefix(f.work, f.batch, f.prefix);
      const observation = queueObservation(f.store.select('landingEntries', f.entryId), reused);
      assert.equal(observation.checkReuse.runId, f.original.id);
      assert.equal(observation.message, `reused check ${f.original.id} from ${f.original.endedAt}`);
      assert.equal(await evaluateBatch(f.work, f.batch, driver), true);
      assert.equal(trainAccounting(f.store.load().runs).total.executions, 1);
      if (attempt < 2) {
        await batchEdit(f.work, 'interrupted-again', data => {
          data.landingBatches.find(batch => batch.id === f.batch.id).status = 'superseded';
          data.landingEntries.find(entry => entry.id === f.entryId).status = 'interrupted';
        });
        Object.assign(f, await f.resubmit());
      }
    }
    await advanceLandingBatch(f.work, f.batch.id, driver);
    assert.equal(f.store.select('landingEntries', f.entryId).status, 'accepted');
    assert.equal(f.store.load().channelMoves.length, 1);
  });

test('different State metadata with identical composed file bytes and modes reuses the pass', async t => {
  const f = await prepared(t);
  const source = new NativeSource(f.root);
  const head = source.writeState(
    source.state(f.prefix.head).files,
    [f.prefix.head],
    'New composition',
    'later',
  );
  await batchEdit(f.work, 'metadata-only', data => {
    data.views.find(view => view.id === f.prefix.viewId).head = head;
    data.landingBatches.find(batch => batch.id === f.batch.id).prefixes[0].head = head;
  });
  const batch = f.store.select('landingBatches', f.batch.id);
  const reused = await reuseLandingCheck(f.work, batch, batch.prefixes[0], driver);
  assert.equal(reused.reusedFrom.runId, f.original.id);
  assert.equal(reused.head, head);
});

test('every modeled input change and incomplete outcome falls through to normal execution', async t => {
  const f = await prepared(t);
  const snapshot = f.store.load();
  const resultPath = join(f.store.directory, `check-${f.original.id}`, 'result.json');
  const planPath = join(f.store.directory, `check-${f.original.id}`, 'modal-plan.json');
  const result = readFileSync(resultPath, 'utf8');
  const plan = readFileSync(planPath, 'utf8');
  const source = new NativeSource(f.root);
  const mutate = async fn =>
    batchEdit(f.work, 'changed-input', data => {
      const run = data.runs.find(run => run.id === f.original.id);
      const batch = data.landingBatches.find(batch => batch.id === f.batch.id);
      const view = data.views.find(view => view.id === f.prefix.viewId);
      const entry = data.landingEntries.find(entry => entry.id === f.entryId);
      fn({ data, run, batch, view, entry });
    });
  const treeChange = change => async () =>
    mutate(({ batch, view }) => {
      const files = structuredClone(source.state(view.head).files);
      change(files);
      const head = source.writeState(files, [view.head], 'Changed check input', 'later');
      view.head = head;
      batch.prefixes[0].head = head;
    });
  const changedRecipe = patch => async () => {
    const changed = JSON.parse(plan);
    patch(changed);
    changed.pin = digest(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(changed).filter(([name]) => !['pin', 'source', 'output'].includes(name)),
        ),
      ),
    );
    writeFileSync(planPath, JSON.stringify(changed));
    const receipt = JSON.parse(result);
    Object.assign(receipt.backend, {
      pin: changed.pin,
      runtime: changed.runtime,
      lockfile: changed.lockfile,
    });
    writeFileSync(resultPath, JSON.stringify(receipt));
    await mutate(({ run }) => Object.assign(run.backend, receipt.backend));
  };
  const cases = {
    'selected test scope': changedRecipe(plan => {
      plan.selection.scope = 'docs';
    }),
    'selected test files': changedRecipe(plan => {
      plan.selection.tests = ['tests/different.test.mjs'];
    }),
    'configured shard count': changedRecipe(plan => {
      plan.groups = [['tests/different.test.mjs']];
    }),
    'plan lockfile': changedRecipe(plan => {
      plan.lockfile = 'b'.repeat(64);
    }),
    'plan command': changedRecipe(plan => {
      plan.command = ['node', 'different.mjs'];
    }),
    'source bytes': treeChange(files => {
      files[0].blob = source.put(Buffer.from('different'));
    }),
    'source path': treeChange(files => {
      files[0].path = 'renamed.txt';
    }),
    'source mode': treeChange(files => {
      files[0].mode = 'executable';
    }),
    lockfile: treeChange(files => {
      files.push({ path: 'package-lock.json', mode: 'file', blob: source.put(Buffer.from('{}')) });
    }),
    base: async () =>
      mutate(({ batch, view }) => {
        batch.base = view.base = source.writeState(
          source.state(view.base).files,
          [view.base],
          'Other base',
          'later',
        );
      }),
    'comparison base': async () =>
      mutate(({ view }) => {
        view.composedMain = view.head;
      }),
    'Lane input': async () =>
      mutate(({ view }) => {
        view.inputs[0].head = view.base;
      }),
    dependencies: async () =>
      mutate(({ view }) => {
        view.dependencies = [{ kind: 'view', viewId: randomUUID(), head: view.head }];
      }),
    definition: async () =>
      mutate(({ data, entry }) => {
        data.checks[0].definition = entry.definition = 'd'.repeat(64);
      }),
    'runtime recipe': async () => {
      const changed = JSON.parse(plan);
      changed.runtime = 'old-node-runtime';
      changed.pin = digest(
        JSON.stringify(
          Object.fromEntries(
            Object.entries(changed).filter(([name]) => !['pin', 'source', 'output'].includes(name)),
          ),
        ),
      );
      writeFileSync(planPath, JSON.stringify(changed));
      const receipt = JSON.parse(result);
      receipt.backend.runtime = changed.runtime;
      receipt.backend.pin = changed.pin;
      writeFileSync(resultPath, JSON.stringify(receipt));
      await mutate(({ run }) => {
        run.backend.runtime = changed.runtime;
        run.backend.pin = changed.pin;
      });
    },
    'failed run': async () =>
      mutate(({ run }) => {
        run.status = 'failed';
        run.exitCode = 1;
      }),
    'cancelled run': async () =>
      mutate(({ run }) => {
        run.status = 'cancelled';
      }),
    'interrupted run': async () =>
      mutate(({ run }) => {
        run.status = 'interrupted';
      }),
    'pending run': async () =>
      mutate(({ run }) => {
        run.status = 'running';
      }),
    'cancel requested': async () =>
      mutate(({ run }) => {
        run.cancelRequested = true;
      }),
    'cancellation record': async () =>
      mutate(({ run }) => {
        run.cancellation = { at: run.endedAt, reason: 'command' };
      }),
    signal: async () =>
      mutate(({ run }) => {
        run.signal = 'SIGTERM';
      }),
    'missing completion time': async () =>
      mutate(({ run }) => {
        delete run.endedAt;
      }),
    'missing result': async () => rmSync(resultPath),
    'corrupt result': async () => writeFileSync(resultPath, '{'),
    'corrupt result details': async () =>
      writeFileSync(resultPath, JSON.stringify({ ...JSON.parse(result), details: 'corrupted completion' })),
    'result disagrees with run': async () =>
      writeFileSync(resultPath, JSON.stringify({ ...JSON.parse(result), exitCode: 1 })),
    'missing plan': async () => rmSync(planPath),
    'corrupt plan': async () => writeFileSync(planPath, '{}'),
    'unknown declared observation': async () =>
      mutate(({ run }) => {
        run.inputObservations = [
          {
            input: { kind: 'source', path: 'missing' },
            status: 'unknown',
            producer: 'test',
            details: 'unavailable',
          },
        ];
      }),
  };
  for (const [name, change] of Object.entries(cases))
    await t.test(name, async () => {
      await batchEdit(f.work, 'restore', data =>
        Object.assign(data, structuredClone(snapshot), { revision: data.revision }),
      );
      writeFileSync(resultPath, result);
      writeFileSync(planPath, plan);
      await change();
      const batch = f.store.select('landingBatches', f.batch.id);
      const reused = await reuseLandingCheck(f.work, batch, batch.prefixes[0], driver);
      assert.equal(reused, undefined);
      assert.equal(f.store.select('runs', f.prefix.runId), undefined);
    });
  // Restore evidence, then fail it: the ordinary runner must own a fresh result.
  await batchEdit(f.work, 'restore-final', data =>
    Object.assign(data, structuredClone(snapshot), { revision: data.revision }),
  );
  writeFileSync(resultPath, result);
  writeFileSync(planPath, plan);
  await mutate(({ run }) => {
    run.status = 'failed';
    run.exitCode = 1;
  });
  let dispatched = 0;
  const dispatch = f.work.dispatch.bind(f.work);
  f.work.dispatch = (...args) => {
    if (args[0].action === 'run-check') dispatched++;
    return dispatch(...args);
  };
  assert.equal(await evaluateBatch(f.work, f.batch, driver), true);
  assert.equal(dispatched, 1);
  assert.equal(f.store.select('runs', f.prefix.runId).status, 'passed');
  assert.equal(f.store.select('runs', f.prefix.runId).reusedFrom, undefined);
});

test('reused receipt loses acceptance authority if the source result disappears', async t => {
  const f = await prepared(t);
  const reused = await reuseLandingCheck(f.work, f.batch, f.prefix, driver);
  validateReusedCheck(f.store, reused);
  rmSync(join(f.store.directory, `check-${f.original.id}`, 'result.json'));
  assert.throws(() => validatePassingPrefix(f.work, f.batch, f.prefix), { code: 'EVIDENCE_CHANGED' });
  await assert.rejects(
    f.work.dispatch(
      {
        action: 'accept-channel',
        operationId: randomUUID(),
        channel: 'main',
        viewId: f.prefix.viewId,
        expectedHead: f.prefix.head,
        expectedPrevious: null,
      },
      f.store.revision(),
    ),
    { code: 'EVIDENCE_CHANGED' },
  );
  assert.equal(f.store.load().channelMoves.length, 0);
});

test('retained Blacksmith pass survives Node patch and runner-label changes without an Actions dispatch', async t => {
  const f = await prepared(t, {}, () => ({ args: ['scripts/forge-check.mjs'] }));
  const path = join(f.store.directory, `check-${f.original.id}`);
  const plan = JSON.parse(readFileSync(join(path, 'modal-plan.json'), 'utf8'));
  plan.runtime =
    'github-actions;repo:synthetic/fixture;node:24.22.0;runs-on:blacksmith-4vcpu-ubuntu-2404;unfinished-retry:1';
  plan.pin = digest(
    JSON.stringify(
      Object.fromEntries(Object.entries(plan).filter(([key]) => !['pin', 'source', 'output'].includes(key))),
    ),
  );
  writeFileSync(join(path, 'modal-plan.json'), JSON.stringify(plan));
  const receipt = JSON.parse(readFileSync(join(path, 'result.json'), 'utf8'));
  Object.assign(receipt.backend, {
    actual: 'github-actions',
    requested: 'github-actions',
    runtime: plan.runtime,
    pin: plan.pin,
  });
  writeFileSync(join(path, 'result.json'), JSON.stringify(receipt));
  await batchEdit(f.work, 'retained-Blacksmith-evidence', data => {
    Object.assign(data.runs.find(run => run.id === f.original.id).backend, receipt.backend);
  });
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    checks: { runner: 'github-actions', repo: 'synthetic/fixture', runsOn: 'ubuntu-latest' },
  });
  const dispatch = f.work.dispatch.bind(f.work);
  f.work.dispatch = (...args) => {
    assert.notEqual(args[0].action, 'run-check');
    return dispatch(...args);
  };
  assert.equal(await evaluateBatch(f.work, f.batch, driver), true);
  const reused = f.store.select('runs', f.prefix.runId);
  assert.equal(reused.reusedFrom.runId, f.original.id);
  assert.deepEqual(
    { scope: reused.checkSelection.scope, tests: reused.checkSelection.tests },
    { scope: plan.selection.scope, tests: plan.selection.tests },
  );
  // Avoid a post-accept audit: this test stops at the exact passing landing receipt.
  validatePassingPrefix(f.work, f.batch, f.prefix);
});

test('observed tool byte changes prevent reuse without executing the tool', async t => {
  let tool;
  const f = await prepared(t, {}, f => {
    tool = join(f.store.directory, 'observed-tool');
    writeFileSync(tool, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    return { declaredInputs: [{ kind: 'tool', executable: tool }] };
  });
  writeFileSync(tool, '#!/bin/sh\nexit 1\n');
  assert.equal(await reuseLandingCheck(f.work, f.batch, f.prefix, driver), undefined);
});

for (const input of [
  { kind: 'source', path: 'missing.txt' },
  { kind: 'external', name: 'service', claimSha256: 'a'.repeat(64) },
  { kind: 'environment', name: 'NOT_FORWARDED' },
])
  test(`unknown or claimed ${input.kind} inputs run normally`, async t => {
    const f = await prepared(t, {}, () => ({ declaredInputs: [input] }));
    assert.equal(await reuseLandingCheck(f.work, f.batch, f.prefix, driver), undefined);
  });

test('advisory timing history retains the passed shard placement', async t => {
  const f = await prepared(t, {}, () => ({ args: ['scripts/forge-check.mjs'] }));
  const path = join(f.store.directory, `check-${f.original.id}`, 'modal-plan.json');
  const oldPlan = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(oldPlan.selection.tests.length, 20);
  const history = {
    version: 1,
    runs: [],
    files: Object.fromEntries(
      oldPlan.selection.tests.map((file, i) => [
        file,
        { durationMs: (i + 1) * 1000, updatedAt: new Date().toISOString() },
      ]),
    ),
  };
  const durations = Object.fromEntries(
    Object.entries(history.files).map(([file, timing]) => [file, timing.durationMs]),
  );
  assert.notDeepEqual(
    partitionTests(oldPlan.selection.tests, oldPlan.groups.length, durations),
    oldPlan.groups,
  );
  writeFileSync(join(f.store.directory, 'test-timings.json'), JSON.stringify(history));
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    checks: { runner: 'modal', shards: 3 },
  });
  const reused = await reuseLandingCheck(f.work, f.batch, f.prefix, driver);
  assert.equal(reused.reusedFrom.runId, f.original.id);
  assert.equal(readFileSync(path, 'utf8'), JSON.stringify(oldPlan));
});

test('ordinary recorded PATH passthrough remains reusable', async t => {
  const f = await prepared(t, { remote: false }, () => ({ env: ['PATH'] }));
  const reused = await reuseLandingCheck(f.work, f.batch, f.prefix, driver);
  assert.equal(reused.reusedFrom.runId, f.original.id);
});

test('unrecorded passthrough values require a normal run', async t => {
  const f = await prepared(t, { remote: false }, () => ({ env: ['SYNTHETIC_UNRECORDED_VALUE'] }));
  assert.equal(await reuseLandingCheck(f.work, f.batch, f.prefix, driver), undefined);
});

test('local reuse ignores admitted Node binary observations but retains scope evidence', async t => {
  const f = await prepared(t, { remote: false });
  for (const missing of [false, true]) {
    await batchEdit(f.work, 'changed-old-Node-bytes', data => {
      const runtime = data.landingEntries[0].runtimeSnapshot;
      if (missing) delete runtime.nodeBinary;
      else runtime.nodeBinary = 'a'.repeat(64);
    });
  }
  const reused = await reuseLandingCheck(f.work, f.batch, f.prefix, driver);
  assert.equal(reused.reusedFrom.runId, f.original.id);
  await batchEdit(f.work, 'retire-previous-request', data => {
    data.landingBatches.find(batch => batch.id === f.batch.id).status = 'superseded';
    data.landingEntries.find(entry => entry.id === f.entryId).status = 'interrupted';
  });
  Object.assign(f, await f.resubmit());
  rmSync(join(f.store.directory, `check-${f.original.id}`, 'changes.json'));
  assert.equal(await reuseLandingCheck(f.work, f.batch, f.prefix, driver), undefined);
});

test('declared tool inputs are re-observed at reuse publication', async t => {
  let tool;
  const f = await prepared(t, {}, f => {
    tool = join(f.store.directory, 'changing-tool');
    writeFileSync(tool, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    return { declaredInputs: [{ kind: 'tool', executable: tool }] };
  });
  const reused = await reuseLandingCheck(f.work, f.batch, f.prefix, {
    beforePublish() {
      writeFileSync(tool, '#!/bin/sh\nexit 1\n');
    },
  });
  assert.equal(reused, undefined);
  assert.equal(f.store.select('runs', f.prefix.runId), undefined);
});

test('billing-only plan pins do not invalidate successful command evidence', async t => {
  const f = await prepared(t);
  const path = join(f.store.directory, `check-${f.original.id}`);
  const plan = JSON.parse(readFileSync(join(path, 'modal-plan.json'), 'utf8'));
  plan.costSafetyMargin += 1;
  plan.pin = digest(
    JSON.stringify(
      Object.fromEntries(Object.entries(plan).filter(([key]) => !['pin', 'source', 'output'].includes(key))),
    ),
  );
  writeFileSync(join(path, 'modal-plan.json'), JSON.stringify(plan));
  const receipt = JSON.parse(readFileSync(join(path, 'result.json'), 'utf8'));
  receipt.backend.pin = plan.pin;
  writeFileSync(join(path, 'result.json'), JSON.stringify(receipt));
  await batchEdit(f.work, 'billing-bookkeeping', data => {
    data.runs.find(run => run.id === f.original.id).backend.pin = plan.pin;
  });
  assert.equal((await reuseLandingCheck(f.work, f.batch, f.prefix, driver)).reusedFrom.runId, f.original.id);
});

for (const [setting, change] of [
  ['runner', { runner: 'local' }],
  ['shard count', { shards: 4 }],
])
  test(`${setting} settings are revalidated at reuse publication`, async t => {
    const f = await prepared(t);
    const reused = await reuseLandingCheck(f.work, f.batch, f.prefix, {
      beforePublish() {
        const data = f.store.load();
        Object.assign(data.autonomyPolicy.checks, change);
        data.revision++;
        f.store.save(data);
      },
    });
    assert.equal(reused, undefined);
    assert.equal(f.store.select('runs', f.prefix.runId), undefined);
  });

for (const failed of [false, true, 'cancelled-request'])
  test(`concurrent requests for one Candidate share a detached ${failed === true ? 'failing' : failed === 'cancelled-request' ? 'passing run after one request cancels' : 'passing'} run`, async t => {
    const { gatedFixture, until } = await import('./landing-worker-fixture.mjs');
    const { withDetachedChecks } = await import('../dist/check-execution-context.js');
    const f = await gatedFixture(t);
    if (failed === true) {
      const check = f.store.load().checks[0];
      await f.agent.dispatch({
        action: 'define-check',
        checkId: check.id,
        name: check.name,
        executable: check.executable,
        args: [check.args[0], `${check.args[1]}socket.on('end',()=>process.exit(1));`],
      });
    }
    const input = await f.candidate('concurrent.txt');
    await enqueueLanding(
      f.work,
      {
        ...input.command,
        operationId: randomUUID(),
        accept: { channel: 'release', expectedPrevious: null },
      },
      input.view,
    );
    const batches = [];
    for (const channel of ['main', 'release']) {
      const selected = await batchEdit(f.work, channel, data => selectBatch(f.work, data, channel));
      await composeBatch(f.work, selected);
      batches.push(f.store.select('landingBatches', selected.id));
    }
    let dispatches = 0;
    const dispatch = f.work.dispatch.bind(f.work);
    f.work.dispatch = (...args) => {
      if (args[0].action === 'run-check') dispatches++;
      return dispatch(...args);
    };
    try {
      const evaluations = batches.map(batch =>
        withDetachedChecks(() => evaluateBatch(f.work, batch, driver, 0)),
      );
      assert.deepEqual(await Promise.all(evaluations), [false, false]);
      // A nonblocking admission can yield before the peer reserves its run.
      // The next worker sweep adopts that reservation instead of dispatching.
      for (const batch of batches)
        assert.equal(await withDetachedChecks(() => evaluateBatch(f.work, batch, driver, 0)), false);
      const saved = batches.map(batch => f.store.select('landingBatches', batch.id));
      assert.equal(saved[0].prefixes[0].runId, saved[1].prefixes[0].runId);
      assert.equal(saved[0].prefixes[0].viewId, saved[1].prefixes[0].viewId);
      assert.equal(dispatches, 1);
      assert.equal(f.store.load().runs.length, 1);
      await until(f, () => f.started, 'detached check starts');
      if (failed === 'cancelled-request') {
        const { cancelLandingEntry } = await import('../dist/landing-batch-cancel.js');
        await cancelLandingEntry(f.work, input.command.operationId);
        assert.notEqual(f.store.load().runs[0].cancelRequested, true);
      }
      f.release();
      for (const batch of saved) assert.equal(await evaluateBatch(f.work, batch, driver), true);
      assert.equal(f.store.load().runs.length, 1);
      assert.equal(f.store.load().runs[0].status, failed === true ? 'failed' : 'passed');
      assert.equal(dispatches, 1);
    } finally {
      f.release();
    }
  });

test('resubmitting the same full Candidate after acceptance and audit needs no further check or acceptance', async t => {
  const previous = process.env.FORGE_CHECK_FULL;
  process.env.FORGE_CHECK_FULL = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_CHECK_FULL;
    else process.env.FORGE_CHECK_FULL = previous;
  });
  const { drainPostAccept } = await import('../dist/post-accept-main.js');
  const { withDetachedChecks } = await import('../dist/check-execution-context.js');
  const f = await prepared(t, {}, () => ({ args: ['scripts/forge-check.mjs'] }));
  await evaluateBatch(f.work, f.batch, driver);
  await advanceLandingBatch(f.work, f.batch.id, driver);
  await drainPostAccept(f.store);
  const executions = new Set(
    f.store
      .load()
      .runs.filter(run => !run.reusedFrom)
      .map(run => run.id),
  );
  const before = f.store.load();
  const dispatch = f.work.dispatch.bind(f.work);
  f.work.dispatch = (...args) => {
    assert.notEqual(args[0].action, 'run-check', 'accepted source must not execute again');
    return dispatch(...args);
  };
  for (let i = 0; i < 7; i++) {
    const command = { ...f.input.command, operationId: randomUUID() };
    await enqueueLanding(f.work, command, f.input.view);
    await batchEdit(f.work, 'different-submitting-cli', data => {
      data.landingEntries.at(-1).runtimeSnapshot.cli = 'a-different-submitting-cli';
    });
    const { drainLandingBatches } = await import('../dist/landing-batch.js');
    await withDetachedChecks(() => drainLandingBatches(f.work, 'main'));
    const entry = f.store.select('landingEntries', command.operationId);
    assert.equal(entry.status, 'accepted');
    assert.equal(entry.alreadyOnMain, f.main().head);
    assert.equal(entry.acceptanceId, undefined);
    assert.equal(entry.runId, undefined);
    await drainPostAccept(f.store);
  }
  assert.equal(f.store.load().runs.length, before.runs.length);
  assert.equal(f.store.load().channelMoves.length, before.channelMoves.length);
  assert.equal(f.store.load().runs.filter(run => !run.reusedFrom).length, executions.size);
});

test('a main audit does not reuse a scoped pass over identical source', async t => {
  const { reuseMainCheck } = await import('../dist/landing-check-reuse.js');
  const f = await prepared(t, {}, () => ({ args: ['scripts/forge-check.mjs'] }));
  const path = join(f.store.directory, `check-${f.original.id}`);
  const plan = JSON.parse(readFileSync(join(path, 'modal-plan.json'), 'utf8'));
  plan.selection.scope = 'scoped';
  plan.selection.tests = plan.selection.tests.slice(0, 1);
  plan.groups = [plan.selection.tests];
  plan.pin = digest(
    JSON.stringify(
      Object.fromEntries(Object.entries(plan).filter(([key]) => !['pin', 'source', 'output'].includes(key))),
    ),
  );
  writeFileSync(join(path, 'modal-plan.json'), JSON.stringify(plan));
  const receipt = JSON.parse(readFileSync(join(path, 'result.json'), 'utf8'));
  receipt.backend.pin = plan.pin;
  receipt.checkSelection = plan.selection;
  writeFileSync(join(path, 'result.json'), JSON.stringify(receipt));
  const view = {
    ...f.input.view,
    id: randomUUID(),
    base: f.prefix.head,
    composedMain: f.prefix.head,
    head: f.prefix.head,
    inputs: [],
    dependencies: [],
    mainCheck: { channel: 'main' },
  };
  await batchEdit(f.work, 'scoped-evidence', data => {
    Object.assign(
      data.runs.find(run => run.id === f.original.id),
      {
        backend: receipt.backend,
        checkSelection: receipt.checkSelection,
      },
    );
    data.views.push(view);
  });
  assert.equal(await reuseMainCheck(f.work, view, randomUUID(), f.store.load().checks[0]), undefined);
});

for (const status of ['interrupted', 'running']) {
  test(`a ${status} diagnostic adopts a later identical pass without altering the old run`, async t => {
    const f = await prepared(t);
    const { hostname } = await import('node:os');
    const { retainDiagnosisNode } = await import('../dist/landing-diagnosis.js');
    const stalled = {
      ...f.original,
      id: f.prefix.runId,
      viewId: f.prefix.viewId,
      head: f.prefix.head,
      status,
      runner: { pid: 2147483647, host: hostname() },
      endedAt: undefined,
      exitCode: undefined,
      error: { code: 'GITHUB_ACTIONS_PENDING_INFRA', message: 'synthetic pending discovery' },
    };
    await batchEdit(f.work, 'stalled-diagnostic', data => {
      data.runs.push(stalled);
    });
    const originalId = stalled.id;
    await retainDiagnosisNode(f.work, f.batch, f.prefix, undefined, driver, stalled);
    const retained = f.store.select('runs', originalId);
    const dispatch = f.work.dispatch.bind(f.work);
    f.work.dispatch = (...args) => {
      assert.notEqual(args[0].action, 'run-check', 'a validated passing twin must not dispatch');
      return dispatch(...args);
    };
    assert.equal(await evaluateBatch(f.work, f.store.select('landingBatches', f.batch.id), driver, 0), true);
    const saved = f.store.select('landingBatches', f.batch.id);
    const adopted = f.store.select('runs', saved.prefixes[0].runId);
    assert.notEqual(adopted.id, originalId);
    assert.equal(adopted.reusedFrom.runId, f.original.id);
    assert.equal(adopted.status, 'passed');
    assert.deepEqual(f.store.select('runs', originalId), retained);
    assert.equal(saved.diagnosis.nodes.find(node => node.runId === originalId).status, status);
    assert.equal(saved.diagnosis.nodes.find(node => node.runId === adopted.id).status, 'passed');
    validatePassingPrefix(f.work, saved, saved.prefixes[0]);
    await advanceLandingBatch(f.work, saved.id, driver);
    assert.equal(f.store.select('landingEntries', f.entryId).status, 'accepted');
  });
}

test('a dead-controller cancellation settles the batch even when a passing twin exists', async t => {
  const f = await prepared(t);
  const { hostname } = await import('node:os');
  const stalled = {
    ...f.original,
    id: f.prefix.runId,
    viewId: f.prefix.viewId,
    head: f.prefix.head,
    status: 'running',
    runner: { pid: 2147483647, host: hostname() },
    endedAt: undefined,
    exitCode: undefined,
  };
  await batchEdit(f.work, 'cancel-stalled-diagnostic', data => {
    data.runs.push(stalled);
  });
  const result = await f.work.dispatch(
    { action: 'cancel-check', operationId: stalled.id },
    f.store.revision(),
  );
  assert.equal(result.result.status, 'cancelled');
  await evaluateBatch(f.work, f.store.select('landingBatches', f.batch.id), driver, 0);
  await advanceLandingBatch(f.work, f.batch.id, driver);
  assert.equal(f.store.select('landingEntries', f.entryId).status, 'cancelled');
  assert.equal(f.store.select('landingBatches', f.batch.id).status, 'completed');
  assert.equal(f.store.select('landingBatches', f.batch.id).acceptanceId, undefined);
});

test('a live controller retains its diagnostic identity despite an identical pass', async t => {
  const f = await prepared(t);
  const { hostname } = await import('node:os');
  const pending = {
    ...f.original,
    id: f.prefix.runId,
    viewId: f.prefix.viewId,
    head: f.prefix.head,
    status: 'running',
    runner: { pid: process.pid, host: hostname() },
    endedAt: undefined,
    exitCode: undefined,
  };
  await batchEdit(f.work, 'live-diagnostic', data => {
    data.runs.push(pending);
  });
  assert.equal(await reuseLandingCheck(f.work, f.batch, f.prefix, driver), undefined);
  assert.equal(f.store.select('landingBatches', f.batch.id).prefixes[0].runId, pending.id);
});

test('a passing twin cannot hide changed pins on the retained diagnostic run', async t => {
  const f = await prepared(t);
  const stalled = {
    ...f.original,
    id: f.prefix.runId,
    viewId: f.prefix.viewId,
    head: 'a'.repeat(64),
    status: 'interrupted',
    endedAt: undefined,
    exitCode: undefined,
  };
  await batchEdit(f.work, 'changed-diagnostic-pins', data => {
    data.runs.push(stalled);
  });
  const retained = f.store.select('runs', stalled.id);
  await assert.rejects(reuseLandingCheck(f.work, f.batch, f.prefix, driver), { code: 'EVIDENCE_CHANGED' });
  assert.equal(f.store.select('landingBatches', f.batch.id).prefixes[0].runId, stalled.id);
  assert.deepEqual(f.store.select('runs', stalled.id), retained);
});

for (const remote of [false, true])
  test(`${remote ? 'remote' : 'local'} restart observations and Node patch changes retain reusable evidence`, async t => {
    const f = await prepared(t, { remote });
    const { WorkService } = await import('../dist/work.js');
    const { withLifecycleMetric, readSelfMetricReceipts } = await import('../dist/self-metrics-journal.js');
    const { nativeSelfMetricsReader } = await import('../dist/self-metrics-native.js');
    await batchEdit(f.work, 'restart-and-sleep-observations', data => {
      const environment = data.landingBatches.find(batch => batch.id === f.batch.id).environment;
      environment.node = environment.node.replace(/\.\d+$/, '.999');
      environment.env.PATH = '/different/install/bin';
      environment.env.npm_config_cache = '/different/cache';
      environment.fingerprint = 'c'.repeat(64);
    });
    const batch = f.store.select('landingBatches', f.batch.id);
    const restarted = new WorkService(f.root);
    const { readSelfMetrics } = await import('../dist/self-metrics.js');
    const reader = nativeSelfMetricsReader(f.root);
    const baseline = await reader.read();
    const period = { from: baseline.coverage.checkRequests, to: new Date(Date.now() + 1000).toISOString() };
    assert.equal((await readSelfMetrics(reader, period)).metric6.reuseRate, 0);
    const response = await withLifecycleMetric(
      f.store.directory,
      { action: 'finish', operationId: randomUUID() },
      async () => {
        const reused = await reuseLandingCheck(restarted, batch, batch.prefixes[0], driver);
        assert.equal(reused.reusedFrom.runId, f.original.id);
        assert.equal(reused.reuseKey, f.original.reuseKey);
        assert.notEqual(reused.environment.fingerprint, f.original.environment.fingerprint);
        validatePassingPrefix(restarted, batch, batch.prefixes[0]);
        return { result: { run: runReceipt(reused) } };
      },
    );
    assert.equal(
      readSelfMetricReceipts(f.store.directory).at(-1).checkRequests[0].reuseKey,
      response.result.run.reuseKey,
    );
    const metrics = await nativeSelfMetricsReader(f.root).read();
    const fastMetrics = await nativeSelfMetricsReader(f.input.lane.path, { fast: true }).read();
    assert.equal(
      fastMetrics.runs.find(run => run.id === batch.prefixes[0].runId).reuseKey,
      f.original.reuseKey,
      'Lane status reads retain recorded keys without reconstructing source identities',
    );
    assert.equal(metrics.runs.find(run => run.id === batch.prefixes[0].runId).reuseKey, f.original.reuseKey);
    period.to = new Date(Date.now() + 1000).toISOString();
    assert.equal((await readSelfMetrics(reader, period)).metric6.reuseRate, 0.5);
    t.diagnostic('Metric 6 synthetic replay: reuse rate 0 -> 0.5; one full execution, one reused request.');
  });

test('Node minor changes require a new local execution', async t => {
  const f = await prepared(t, { remote: false });
  await batchEdit(f.work, 'Node-minor-upgrade', data => {
    const environment = data.landingBatches.find(batch => batch.id === f.batch.id).environment;
    environment.node = 'v24.23.0';
    environment.fingerprint = 'd'.repeat(64);
  });
  const batch = f.store.select('landingBatches', f.batch.id);
  assert.equal(await reuseLandingCheck(f.work, batch, batch.prefixes[0], driver), undefined);
});

for (const partial of [false, true, 'scope'])
  test(`${partial ? 'partial' : 'legacy unkeyed'} passes cannot be reused`, async t => {
    const f = await prepared(t);
    const path = join(f.store.directory, `check-${f.original.id}`, 'result.json');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    if (partial)
      receipt.checkSelection = {
        scope: partial === 'scope' ? 'partial' : 'full',
        tests: ['tests/one.test.mjs'],
        reason: 'Explicit files',
        ...(partial === true ? { partial: true } : {}),
      };
    else delete receipt.reuseKey;
    writeFileSync(path, JSON.stringify(receipt));
    await batchEdit(f.work, 'ineligible-result', data => {
      const original = data.runs.find(run => run.id === f.original.id);
      if (partial) original.checkSelection = receipt.checkSelection;
      else delete original.reuseKey;
    });
    assert.equal(await reuseLandingCheck(f.work, f.batch, f.prefix, driver), undefined);
    assert.equal(readFileSync(path, 'utf8'), JSON.stringify(receipt), 'legacy evidence is never backfilled');
    if (!partial) {
      const { nativeSelfMetricsReader } = await import('../dist/self-metrics-native.js');
      const metrics = await nativeSelfMetricsReader(f.root).read();
      assert.equal(
        metrics.runs.find(run => run.id === f.original.id).reuseKey,
        undefined,
        'metrics never reconstruct missing legacy receipt keys',
      );
    }
    if (partial) {
      const { enforceAcceptance } = await import('../dist/work-autonomy.js');
      const data = f.store.load();
      const view = data.views.find(view => view.id === f.original.viewId);
      assert.throws(
        () => enforceAcceptance(f.store, data, view, null, { kind: 'agent', id: 'synthetic-agent' }),
        { code: 'CHECK_REQUIRED' },
      );
    }
  });

test('content-equivalent passed evidence can cross runner routes while retaining original execution provenance', async t => {
  const f = await prepared(t, { remote: false });
  await f.agent.dispatch({ action: 'set-policy', operationId: randomUUID(), checks: { runner: 'modal' } });
  await batchEdit(f.work, 'different-requesting-owner-node', data => {
    const environment = data.landingBatches.find(batch => batch.id === f.batch.id).environment;
    environment.node = 'v24.23.0';
    environment.fingerprint = 'e'.repeat(64);
  });
  const batch = f.store.select('landingBatches', f.batch.id);
  const reused = await reuseLandingCheck(f.work, batch, batch.prefixes[0], driver);
  assert.equal(reused.reusedFrom.runId, f.original.id);
  assert.equal(reused.reuseKey, f.original.reuseKey);
  assert.equal(reused.backend.actual, f.original.backend.actual);
  assert.equal(reused.backend.runtime, f.original.backend.runtime);
  validatePassingPrefix(f.work, batch, batch.prefixes[0]);
});

test('finish adopts a keyed pass across owner fingerprints while preserving explicit environment pins', async t => {
  const { adoptFinishRun } = await import('../dist/agent-finish-reuse.js');
  const { checkEnvironment } = await import('../dist/check-environment.js');
  const f = await prepared(t, { remote: false });
  const command = { checkId: f.original.check.id, expectedDefinition: f.original.check.definition };
  const viewId = f.original.viewId;
  await batchEdit(f.work, 'changed-owner-observation', data => {
    const original = data.runs.find(run => run.id === f.original.id);
    original.environment.fingerprint = 'a'.repeat(64);
  });
  const path = join(f.store.directory, `check-${f.original.id}`, 'result.json');
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  receipt.environment.fingerprint = 'a'.repeat(64);
  writeFileSync(path, JSON.stringify(receipt));
  assert.equal(adoptFinishRun(f.store, command, viewId)?.id, f.original.id);
  assert.equal(
    adoptFinishRun(f.store, { ...command, expectedEnvironment: checkEnvironment().fingerprint }, viewId)?.id,
    f.original.id,
  );
  assert.equal(
    adoptFinishRun(f.store, { ...command, expectedEnvironment: 'b'.repeat(64) }, viewId),
    undefined,
  );
  await batchEdit(f.work, 'partial-pass', data => {
    data.runs.find(run => run.id === f.original.id).checkSelection = {
      scope: 'partial',
      reason: 'Explicit list',
      tests: ['tests/one.test.mjs'],
    };
  });
  assert.equal(adoptFinishRun(f.store, command, viewId), undefined);
});
