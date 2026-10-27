import { runDetails } from '../dist/work-detail-store.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { WorkStore } from '../dist/work-store.js';
import { restoreNativeWork } from '../dist/native-backup.js';
import { workSchema } from '../dist/work-types.js';
import { drainPostAccept } from '../dist/post-accept-main.js';
import { lightweightDocsRun } from '../dist/work-docs-admission.js';
import { CheckQueue } from '../dist/check-queue.js';
import { interactionEvidence } from '../dist/work-interaction.js';
import { scopedPostAccept } from '../dist/post-accept-request.js';
import { trustAgents } from './autonomy-fixture.mjs';

// Check runners pass these through to the suite (main audits set FORGE_CHECK_FULL=1);
// each test sets the scope it exercises, so start from none.
for (const name of ['FORGE_CHECK_FULL', 'FORGE_CHECK_SCOPED', 'FORGE_CHECK_INTERACTION'])
  Reflect.deleteProperty(process.env, name);

const lines = (changes = {}) =>
  Array.from({ length: 20 }, (_, i) => changes[i] ?? `// line ${i}`).join('\n') + '\n';
async function setup(t, code) {
  // The outer full check must not override this fixture's explicit selection scenarios.
  const outerLimit = process.env.FORGE_MAX_CONCURRENT_CHECKS;
  process.env.FORGE_MAX_CONCURRENT_CHECKS = '1';
  t.after(() => {
    if (outerLimit === undefined) delete process.env.FORGE_MAX_CONCURRENT_CHECKS;
    else process.env.FORGE_MAX_CONCURRENT_CHECKS = outerLimit;
  });
  const outerFull = process.env.FORGE_CHECK_FULL;
  delete process.env.FORGE_CHECK_FULL;
  t.after(() => {
    if (outerFull === undefined) delete process.env.FORGE_CHECK_FULL;
    else process.env.FORGE_CHECK_FULL = outerFull;
  });
  const root = mkdtempSync(join(tmpdir(), 'forge-interaction-'));
  const children = new Set();
  const spawn = childProcess.spawn;
  childProcess.spawn = (...args) => {
    const child = spawn(...args);
    const closed = new Promise(resolve => {
      child.once('close', resolve);
      child.once('error', resolve);
    });
    children.add(closed);
    return child;
  };
  syncBuiltinESMExports();
  t.after(async () => {
    try {
      await drainPostAccept(new WorkStore(root));
      // A post-accept worker can spawn another check while it drains.
      for (let observed = -1; observed !== children.size;) {
        observed = children.size;
        await Promise.all(children);
      }
    } finally {
      childProcess.spawn = spawn;
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  for (const dir of ['docs', 'src', 'tests', 'scripts']) mkdirSync(join(root, dir));
  const shared = code ? 'src/shared.ts' : 'docs/status.md';
  writeFileSync(join(root, shared), lines());
  writeFileSync(join(root, 'src/left.ts'), 'export const left = 1;\n');
  writeFileSync(join(root, 'src/right.ts'), 'export const right = 1;\n');
  writeFileSync(join(root, 'tests/shared.test.mjs'), code ? "import '../dist/shared.js';" : '');
  writeFileSync(join(root, 'tests/left.test.mjs'), "import '../dist/left.js';");
  writeFileSync(join(root, 'tests/right.test.mjs'), "import '../dist/right.js';");
  writeFileSync(
    join(root, 'scripts/forge-check.mjs'),
    `
    import { readFileSync, writeFileSync } from 'node:fs';
    const { pinnedComparison, standardSelection } = await import(${JSON.stringify(pathToFileURL(resolve('scripts/test-impact.mjs')).href)});
    const files = new Map(${JSON.stringify(['src/left.ts', 'src/right.ts', ...(code ? ['src/shared.ts'] : []), 'tests/shared.test.mjs', 'tests/left.test.mjs', 'tests/right.test.mjs'])}.map(path => [path, readFileSync(path, 'utf8')]));
    const comparison = pinnedComparison();
    const selection = standardSelection({ ...comparison, files,
      env: process.env.FORGE_CHECK_INTERACTION ? process.env : { ...process.env, FORGE_CHECK_FULL: '1' } });
    writeFileSync(process.env.FORGE_CHECK_SELECTION, JSON.stringify(selection));
  `,
  );
  initNative(root);
  trustAgents(root);
  const agent = new AgentWorkflow(root),
    store = agent.work.store;
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['scripts/forge-check.mjs'],
  });
  const seed = (await agent.dispatch({ action: 'start', outcome: 'seed main' })).result;
  writeFileSync(join(seed.path, 'README.md'), 'seed\n');
  const initial = (
    await agent.dispatch({ action: 'finish', laneId: seed.laneId, message: 'seed', accept: true })
  ).result;
  assert.equal(initial.status, 'accepted');
  const a = (await agent.dispatch({ action: 'start', outcome: 'candidate' })).result;
  const b = (await agent.dispatch({ action: 'start', outcome: 'concurrent main' })).result;
  writeFileSync(join(a.path, shared), lines({ 18: '// candidate' }));
  writeFileSync(join(b.path, shared), lines({ 1: '// main' }));
  writeFileSync(join(a.path, 'src/left.ts'), 'export const left = 2;\n');
  writeFileSync(join(b.path, 'src/right.ts'), 'export const right = 2;\n');
  return { root, agent, store, a, b, shared, initial };
}
for (const code of [false, true])
  test(`native finish actual ${code ? 'code interaction' : 'docs overlap'} selection, restart replay, exact acceptance and full backstop`, async t => {
    const oldScoped = process.env.FORGE_CHECK_SCOPED;
    process.env.FORGE_CHECK_SCOPED = '1';
    t.after(() => {
      if (oldScoped === undefined) delete process.env.FORGE_CHECK_SCOPED;
      else process.env.FORGE_CHECK_SCOPED = oldScoped;
    });
    const f = await setup(t, code),
      original = f.agent.work.dispatch.bind(f.agent.work);
    const output = [];
    const stderr = process.stderr.write;
    process.stderr.write = function (chunk, ...args) {
      output.push(String(chunk));
      return stderr.call(this, chunk, ...args);
    };
    t.after(() => {
      process.stderr.write = stderr;
    });
    let blocker;
    t.after(() => blocker?.release());
    let advanced = false,
      interrupted = false,
      main;
    f.agent.work.dispatch = async (command, ...args) => {
      if (command.action === 'accept-channel' && !advanced) {
        advanced = true;
        main = (
          await f.agent.dispatch({ action: 'finish', laneId: f.b.laneId, message: 'main', accept: true })
        ).result;
        assert.equal(main.status, 'accepted');
      }
      if (!code && command.action === 'run-check' && command.interaction && !blocker) {
        blocker = new CheckQueue(undefined, { limit: 1 });
        assert.equal(blocker.tryAcquire(), true);
      }
      const reply = await original(command, ...args);
      if (command.action === 'run-check' && command.interaction && !interrupted) {
        interrupted = true;
        throw new Error('Lost interaction registration reply');
      }
      return reply;
    };
    const request = {
      action: 'finish',
      operationId: randomUUID(),
      laneId: f.a.laneId,
      expectedHead: f.a.head,
      message: 'candidate',
      accept: { expectedPrevious: f.initial.acceptance.head },
    };
    await assert.rejects(f.agent.dispatch(request), /Lost interaction/);
    const journal = JSON.parse(
      readFileSync(join(f.store.directory, 'agent-finish', `${request.operationId}.json`)),
    );
    const pinned = journal.attempts.at(-1).interaction;
    assert.equal(pinned.main, main.acceptance.head);
    const receipt = (await new AgentWorkflow(f.root).dispatch(request)).result;
    assert.equal(receipt.status, 'accepted');
    const retry = output.find(line => line.startsWith('finish retry:'));
    assert.ok(retry, 'retry reason is printed');
    assert.match(retry, /oldMain.*newMain.*overlappingPaths.*fastPathRejection.*replacementRunId/);
    assert.match(retry, /Changed paths overlap|Disjoint fast path disabled/);
    if (!code) {
      assert.equal(blocker.tryAcquire(), true, 'heavyweight capacity remains occupied during docs landing');
      blocker.release();
    }
    assert.equal(
      receipt.run.checkSelection.scope,
      code ? 'interaction' : 'docs',
      JSON.stringify(receipt.run),
    );
    assert.deepEqual(
      runDetails(f.store, f.store.select('runs', receipt.run.runId)).checkSelection.tests,
      code ? ['tests/shared.test.mjs'] : [],
    );
    assert.equal(receipt.run.head, receipt.acceptance.head);
    assert.equal(receipt.run.interaction.eligible, true);
    assert.equal(receipt.run.interaction.basis, code ? 'main-full-coverage' : 'docs-overlap');
    assert.equal(receipt.run.interaction.reusedRunId, pinned.reusedRunId);
    assert.deepEqual(receipt.run.interaction.lanePaths, [f.shared, 'src/left.ts'].sort());
    assert.deepEqual(receipt.run.interaction.mainPaths, [f.shared, 'src/right.ts'].sort());
    assert.deepEqual(receipt.run.interaction.overlap, [f.shared]);
    assert.equal(receipt.acceptance.postAccept.mode, 'full');
    await drainPostAccept(f.store);
    const data = f.store.load();
    const audit = data.runs.find(run => run.mainCheck && run.head === receipt.acceptance.head);
    assert.equal(audit?.status, 'passed');
    assert.equal(audit.checkSelection.scope, 'full');
    assert.equal(data.schema, 23);
    const view = data.views.find(view => view.id === receipt.view.viewId);
    assert.equal(scopedPostAccept(data, view).mode, 'full');
    const exact = data.runs.find(run => run.id === receipt.run.runId);
    assert.equal(await lightweightDocsRun(f.store, exact), !code);
    for (const override of [
      { environment: { ...exact.environment, env: { ...exact.environment.env, FORGE_CHECK_FULL: '1' } } },
      { environment: { ...exact.environment, env: { ...exact.environment.env, FORGE_CHECK_SCOPED: '0' } } },
      { interaction: null },
      { check: { ...exact.check, args: ['custom.mjs'] } },
      {
        interaction: {
          ...exact.interaction,
          lanePaths: [...exact.interaction.lanePaths, 'unknown.binary'].sort(),
        },
      },
    ])
      assert.equal(await lightweightDocsRun(f.store, { ...exact, ...override }), false);

    assert.deepEqual(
      workSchema.parse(data).runs.find(run => run.id === exact.id).interaction,
      exact.interaction,
    );
    assert.equal(workSchema.safeParse({ ...data, schema: 14 }).success, false);
    const replay = (await new AgentWorkflow(f.root).dispatch({ ...request, ...receipt.resolved })).result;
    const { resolved: _resolved, ...withoutResolved } = receipt;
    assert.deepEqual(replay, withoutResolved);
    // Runner validation retains the pinned request; docs overlap needs no main coverage.
    for (const [index, mutate] of [
      data => {
        data.runs.find(run => run.id === pinned.reusedRunId).status = 'failed';
      },
      data => {
        data.runs.find(run => run.id === pinned.reusedRunId).check.definition = 'f'.repeat(64);
      },
      data => {
        data.runs.find(run => run.id === pinned.reusedRunId).environment.fingerprint = 'f'.repeat(64);
      },
      data => {
        data.runs.find(run => run.id === pinned.reusedRunId).inputs = [];
      },
      data => {
        data.runs = data.runs.filter(run => run.head !== pinned.main);
      },
      data => {
        for (const run of data.runs.filter(run => run.head === pinned.main)) delete run.checkSelection;
      },
      data => {
        data.views.find(view => view.id === exact.viewId).resolution = { viewId: randomUUID() };
      },
    ].entries()) {
      const changed = structuredClone({ ...data, runs: data.runs.map(run => runDetails(f.store, run)) });
      mutate(changed);
      const fallback = interactionEvidence(
        { native: true, root: f.root, load: () => changed },
        exact,
        pinned,
      );
      assert.equal(fallback.eligible, !code && [4, 5].includes(index), fallback.reason);
      assert.equal(fallback.reusedRunId, pinned.reusedRunId);
    }
    const changedEnvironment = structuredClone(exact);
    changedEnvironment.environment.fingerprint = 'f'.repeat(64);
    assert.equal(interactionEvidence(f.store, changedEnvironment, pinned).eligible, false);
    // Export/import preserves the evidence in an actual portable native backup.
    const work = new AgentWorkflow(f.root).work;
    // The post-accept main worker may still hold the Work lock briefly; export waits it out.
    let exported;
    for (const deadline = Date.now() + 60_000; ;) {
      try {
        exported = (await work.dispatch({ action: 'export-work' }, work.store.revision())).result;
        break;
      } catch (error) {
        if (error?.code !== 'WORK_BUSY' || Date.now() > deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const target = join(tmpdir(), `forge-interaction-restored-${randomUUID()}`);
    t.after(() => rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    await restoreNativeWork(exported.path, target);
    const restored = new WorkStore(target).load();
    assert.equal(restored.schema, 23);
    assert.deepEqual(restored.runs.find(run => run.id === exact.id).interaction, exact.interaction);
    assert.deepEqual(restored.runs.find(run => run.id === exact.id).checkSelection, exact.checkSelection);
  });

for (const [code, scoped] of [
  [false, true],
  [true, true],
  [true, false],
])
  test(`native finish without main full coverage: ${code ? 'code' : 'docs'} overlap, scoped ${scoped}`, async t => {
    const oldScoped = process.env.FORGE_CHECK_SCOPED;
    process.env.FORGE_CHECK_SCOPED = scoped ? '1' : '0';
    t.after(() => {
      if (oldScoped === undefined) delete process.env.FORGE_CHECK_SCOPED;
      else process.env.FORGE_CHECK_SCOPED = oldScoped;
    });
    const f = await setup(t, code),
      original = f.agent.work.dispatch.bind(f.agent.work);
    let advanced = false;
    f.agent.work.dispatch = async (command, ...args) => {
      if (command.action === 'accept-channel' && !advanced) {
        advanced = true;
        const main = (
          await f.agent.dispatch({ action: 'finish', laneId: f.b.laneId, message: 'main', accept: true })
        ).result;
        f.store.locked(() => {
          const data = f.store.load();
          data.runs.find(run => run.id === main.run.runId).checkSelection = {
            scope: 'scoped',
            reason: 'fixture: partial main coverage',
            tests: [],
          };
          f.store.save(data);
        });
      }
      return original(command, ...args);
    };
    const receipt = (
      await f.agent.dispatch({ action: 'finish', laneId: f.a.laneId, message: 'candidate', accept: true })
    ).result;
    assert.equal(receipt.status, 'accepted');
    assert.equal(receipt.run.checkSelection.scope, !scoped ? 'full' : code ? 'scoped' : 'docs');
    assert.equal(receipt.run.interaction.eligible, !code);
    if (code) {
      assert.match(receipt.run.interaction.reason, /No exact passing full coverage/);
      if (scoped) assert.match(receipt.run.checkSelection.reason, /Interaction ineligible/);
    } else {
      assert.equal(receipt.run.interaction.basis, 'docs-overlap');
      assert.equal(receipt.run.interaction.mainRunId, undefined);
    }
    assert.equal(receipt.run.head, receipt.acceptance.head);
    if (scoped) {
      assert.equal(receipt.acceptance.postAccept.mode, 'full');
      await drainPostAccept(f.store);
      const audit = f.store.load().runs.find(run => run.mainCheck && run.head === receipt.acceptance.head);
      assert.equal(audit?.status, 'passed');
      assert.equal(audit.checkSelection.scope, 'full');
    }
  });

test('a second main movement pins a separate interaction attempt and preserves accepted source', async t => {
  const oldScoped = process.env.FORGE_CHECK_SCOPED;
  process.env.FORGE_CHECK_SCOPED = '1';
  t.after(() => {
    if (oldScoped === undefined) delete process.env.FORGE_CHECK_SCOPED;
    else process.env.FORGE_CHECK_SCOPED = oldScoped;
  });
  const f = await setup(t, true),
    original = f.agent.work.dispatch.bind(f.agent.work);
  let advances = 0,
    moving = false;
  const mains = [];
  f.agent.work.dispatch = async (command, ...args) => {
    if (
      command.action === 'accept-channel' &&
      !moving &&
      advances < 2 &&
      (advances === 0 || command.expectedPrevious === mains[0].acceptance.head)
    ) {
      moving = true;
      let lane = f.b;
      if (advances === 1) {
        lane = (await f.agent.dispatch({ action: 'start', outcome: 'second main move' })).result;
        writeFileSync(join(lane.path, f.shared), lines({ 1: '// main', 6: '// second main' }));
      }
      advances++;
      mains.push(
        (await f.agent.dispatch({ action: 'finish', laneId: lane.laneId, message: 'main', accept: true }))
          .result,
      );
      moving = false;
    }
    return original(command, ...args);
  };
  const receipt = (
    await f.agent.dispatch({ action: 'finish', laneId: f.a.laneId, message: 'candidate', accept: true })
  ).result;
  assert.equal(receipt.status, 'accepted');
  assert.equal(receipt.attempts.length, 3);
  assert.equal(receipt.run.checkSelection.scope, 'interaction');
  assert.equal(receipt.run.interaction.main, mains[1].acceptance.head);
  assert.equal(receipt.run.interaction.base, mains[0].acceptance.head);
  assert.equal(receipt.run.interaction.reusedRunId, receipt.attempts[1].operations.run);
  assert.equal(receipt.run.head, receipt.acceptance.head);
  assert.match(readFileSync(join(f.a.path, f.shared), 'utf8'), /second main/);
  assert.match(readFileSync(join(f.a.path, f.shared), 'utf8'), /candidate/);
});
