// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from './landing-batch-fixture.mjs';
import { batchEdit, selectBatch, composeBatch } from '../dist/landing-batch-store.js';
import { claimLandingDriver } from '../dist/landing-driver.js';
import { advanceLandingBatch } from '../dist/landing-batch-step.js';
import { drainLandingBatches } from '../dist/landing-batch.js';
import { launchGithubActionsRun } from '../dist/work-github-actions-run.js';
import { launchModalRun } from '../dist/work-modal-run.js';
import { checkEnvironment, recoverRuns } from '../dist/work-run.js';
import { actionsApi } from '../dist/github-actions-api.js';
import { sweepActionsRefs } from '../dist/github-actions-cleanup.js';
import { processIdentity } from '../dist/local-process.js';
import { saveLandingWorkerState } from '../dist/landing-worker-status.js';

const read = path => JSON.parse(readFileSync(path, 'utf8'));
const turn = () => new Promise(resolve => setImmediate(resolve));
async function reserve(t, backend) {
  const f = await fixture(t);
  if (backend === 'github-actions')
    await f.agent.dispatch({
      action: 'set-policy',
      operationId: randomUUID(),
      checks: { runner: backend, repo: 'synthetic/checks' },
    });
  await f.candidate('recover.txt');
  const batch = await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
  await composeBatch(f.work, batch);
  const saved = f.store.select('landingBatches', batch.id),
    prefix = saved.prefixes.at(-1),
    view = f.store.select('views', prefix.viewId);
  const run = {
    id: prefix.runId,
    viewId: view.id,
    head: view.head,
    base: view.base,
    inputs: view.inputs,
    dependencies: view.dependencies,
    check: f.store.load().checks[0],
    environment: saved.environment,
    status: 'queued',
    startedAt: new Date().toISOString(),
    runner: { ...processIdentity(), host: hostname() },
    details: 'synthetic recovery',
    backend: { requested: backend, actual: backend },
  };
  f.store.locked(() => {
    const tx = f.store.records();
    tx.append('runs', run);
    f.store.commitRecords(tx);
  });
  return { ...f, batch: saved, run, path: join(f.store.directory, `check-${run.id}`) };
}
function publish(f) {
  assert.equal(recoverRuns(f.store, { runs: [f.run] }), true);
  f.store.locked(() => {
    const tx = f.store.records();
    tx.replace('runs', tx.find('runs', f.run.id).position, f.run);
    f.store.commitRecords(tx);
  });
}

test('the driver parks a lost Actions rerun reply, then lands the same attempt without another dispatch', async t => {
  const f = await reserve(t, 'github-actions');
  await f.agent.dispatch({
    action: 'set-policy',
    operationId: randomUUID(),
    checks: { runner: 'github-actions', repo: 'synthetic/checks' },
  });
  const commit = 'a'.repeat(40);
  let replaced = false,
    visible = false,
    reruns = 0,
    dispatches = 0;
  const api = {
    async request(endpoint, method = 'GET') {
      if (endpoint.endsWith('/dispatches')) {
        dispatches++;
        return {};
      }
      if (endpoint.endsWith('/rerun')) {
        reruns++;
        replaced = true;
        throw Error('synthetic lost rerun reply');
      }
      if (endpoint.includes('/branches/')) return { commit: { sha: commit } };
      return {
        id: 10,
        head_sha: commit,
        status: 'completed',
        conclusion: visible ? 'success' : 'startup_failure',
        display_title: `forge-check/${f.run.id}`,
      };
    },
    async pages(endpoint) {
      if (endpoint.includes('/runs?'))
        return [{ id: 10, head_sha: commit, display_title: `forge-check/${f.run.id}` }];
      return [
        {
          id: visible ? 21 : 20,
          name: 'forge-static',
          status: 'completed',
          conclusion: visible ? 'success' : 'startup_failure',
        },
      ];
    },
    async log() {
      return 'synthetic retained output\n';
    },
    async sleep() {},
  };
  await launchGithubActionsRun(
    f.store,
    f.run,
    api,
    async (_plan, journal, save) => {
      journal.commit = commit;
      journal.pushed = true;
      save();
    },
    async () => assert.fail('unresolved replacement must retain its ref'),
  );
  publish(f);
  assert.equal(replaced, true);
  assert.equal(f.run.error.code, 'GITHUB_ACTIONS_PENDING_INFRA');
  await sweepActionsRefs(
    f.store,
    'synthetic/checks',
    api,
    () => {},
    async () => assert.fail('sweep cannot delete a pending replacement ref'),
  );
  const dispatch = f.work.dispatch.bind(f.work);
  // Observe an additional complete discovery window without visibility of the replacement.
  await launchGithubActionsRun(
    f.store,
    f.run,
    api,
    async () => {},
    async () => assert.fail('pending ref'),
  );
  publish(f);
  f.work.dispatch = async command => {
    assert.equal(command.operationId, f.run.id);
    return { result: f.run };
  };
  const driver = await claimLandingDriver(f.work, 'main');
  assert.equal(await advanceLandingBatch(f.work, f.batch.id, driver, { waitMs: 0 }), 'waiting');
  assert.equal(f.store.select('landingBatches', f.batch.id).settlement, undefined);
  assert.equal(f.store.load().channelMoves.length, 0);
  f.work.dispatch = dispatch;
  visible = true;
  for (const name of ['request', 'pages', 'log', 'sleep'])
    t.mock.method(actionsApi, name, (...args) => api[name](...args));
  const bin = join(f.path, 'fake-bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'git'),
    `#!${process.execPath}\nif(process.argv.includes('ls-remote'))process.stdout.write(${JSON.stringify(`${commit}\trefs/heads/forge-check/${f.run.id}`)});else if(!process.argv.includes('push')&&!process.argv.includes('init'))process.exit(1);\n`,
    { mode: 0o755 },
  );
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  t.after(() => {
    process.env.PATH = previous;
  });
  // Post-accept audits keep using the fixture's fake Modal client. The retained
  // Actions attempt continues on its original route through this settings change.
  await f.agent.dispatch({ action: 'set-policy', operationId: randomUUID(), checks: { runner: 'modal' } });
  await drainLandingBatches(f.work, 'main');
  assert.equal(reruns, 1);
  assert.equal(dispatches, 1);
  assert.equal(f.store.select('runs', f.run.id).status, 'passed');
  assert.deepEqual(f.store.select('landingBatches', f.batch.id).prefixes, f.batch.prefixes);
  assert.equal(f.store.load().landingEntries[0].status, 'accepted');
  assert.equal(f.content('recover.txt'), 'recover.txt\n');
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck).length, 1);
  assert.ok(readdirSync(f.path).some(name => name.startsWith('result.json.interrupted-')));
});

for (const backend of ['github-actions', 'modal'])
  test(`${backend} recovery completion explicitly wakes the driver after its receipt is durable`, async t => {
    const f = await reserve(t, backend);
    const sent = [];
    t.mock.method(net, 'createConnection', endpoint => {
      sent.push({ endpoint, status: read(join(f.path, 'result.json')).status });
      return Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {}, end() {} });
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    // Drain setup notifications before registering a fake idle driver.
    await turn();
    saveLandingWorkerState(f.store, {
      schema: 1,
      id: '00000000-0000-4000-8000-000000000007',
      worker: processIdentity(),
      endpoint: 'synthetic-recovery-worker',
      status: 'idle',
      observedAt: new Date().toISOString(),
    });
    let ready = false;
    const beforeResult = async () => {
      // All earlier Work publications have delivered their wakes. Only the
      // receipt write follows this barrier; no completion is published to Work.
      await turn();
      sent.length = 0;
      ready = true;
    };
    if (backend === 'modal') {
      let attempts = 0,
        retained;
      await launchModalRun(
        f.store,
        f.run,
        async (file, emit) => {
          const plan = read(file);
          if (++attempts === 1) {
            retained = plan;
            emit({ kind: 'error', category: 'network', safeFallback: true });
          } else {
            assert.deepEqual(plan, retained);
            await beforeResult();
            emit({
              kind: 'result',
              pin: plan.pin,
              head: plan.head,
              definition: plan.definition,
              exitCode: 0,
              estimatedCostUsd: 0,
            });
          }
        },
        1,
      );
      assert.equal(attempts, 2);
    } else {
      let rerun = false;
      await launchGithubActionsRun(
        f.store,
        f.run,
        {
          async request(endpoint) {
            if (endpoint.endsWith('/rerun')) {
              rerun = true;
              return {};
            }
            if (endpoint.includes('/branches/')) return { commit: { sha: 'a'.repeat(40) } };
            if (endpoint.endsWith('/timing')) await beforeResult();
            return {
              id: 10,
              head_sha: 'a'.repeat(40),
              status: 'completed',
              conclusion: rerun ? 'success' : 'startup_failure',
            };
          },
          async pages(endpoint) {
            if (endpoint.includes('/runs?'))
              return [{ id: 10, head_sha: 'a'.repeat(40), display_title: `forge-check/${f.run.id}` }];
            return [
              {
                id: rerun ? 21 : 20,
                name: 'forge-static',
                status: 'completed',
                conclusion: rerun ? 'success' : 'startup_failure',
              },
            ];
          },
          async log() {
            return 'synthetic\n';
          },
          async sleep() {},
        },
        async (_plan, journal, save) => {
          journal.commit = 'a'.repeat(40);
          journal.pushed = true;
          save();
        },
        async () => {
          await turn();
          assert.deepEqual(sent, [{ endpoint: 'synthetic-recovery-worker', status: 'passed' }]);
        },
      );
      assert.equal(rerun, true);
    }
    assert.equal(ready, true);
    await turn();
    assert.deepEqual(sent, [{ endpoint: 'synthetic-recovery-worker', status: 'passed' }]);
    assert.equal(f.store.select('runs', f.run.id).status, 'running');
  });

test('reopening a legacy interrupted batch discards its old stopped cursor while retaining exact prefixes', async t => {
  const f = await reserve(t, 'github-actions');
  const { reopenActionsLanding } = await import('../dist/github-actions-recovery.js');
  await batchEdit(f.work, f.batch.id, data => {
    data.landingBatches[0].status = 'completed';
    data.landingBatches[0].settlement = { cancelledAt: -1, stopped: 'interrupted' };
    data.landingEntries[0].status = 'interrupted';
    data.landingEntries[0].runId = f.run.id;
  });
  f.store.locked(() => {
    const tx = f.store.records();
    reopenActionsLanding(tx, f.run);
    f.store.commitRecords(tx);
  });
  const resumed = f.store.select('landingBatches', f.batch.id);
  assert.equal(resumed.status, 'checking');
  assert.equal(resumed.settlement, undefined);
  assert.deepEqual(resumed.prefixes, f.batch.prefixes);
  assert.equal(f.store.load().landingEntries[0].status, 'checking');
  assert.equal(f.store.load().landingEntries[0].runId, f.run.id);
});
