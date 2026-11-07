// SPDX-License-Identifier: Apache-2.0
// Collector signing authority is scoped to one project and one registered machine,
// and the public collector endpoints bind the signed-in caller to that machine's owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { checksFixture, code } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { outputMessage, signOutput } from '../dist/hosted-check-output.js';
import { signHostedCheckCallback } from '../dist/hosted-check-evidence.js';
import { signMacHeartbeat } from '../dist/hosted-mac-lease.js';
import { machineCollectorKey, runSigningSecret } from '../dist/hosted-collector-key.js';
import { collectorKey } from '../dist/worker-cli.js';
import { digest } from '../dist/hash.js';
const worker = await import(moduleUrl('../convex/projectHostedCheckWorker.ts'));
const api = await import(moduleUrl('../convex/projectHostedOutputApi.ts'));
const batch = await import(moduleUrl('../convex/projectHostedOutputBatch.ts'));
const deploymentKey = 'synthetic-deployment-collector-root';

test.before(() => {
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
  process.env.FORGE_HOSTED_CHECK_KEY_SYNTHETIC = deploymentKey;
});
test.after(() => {
  delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
  delete process.env.FORGE_HOSTED_CHECK_KEY_SYNTHETIC;
});

async function fixture() {
  const f = await checksFixture();
  f.decorateContext(ctx => {
    ctx.scheduler = { runAfter: async () => `timer-${randomUUID()}`, cancel: async () => {} };
  });
  f.insert('projectContributors', { projectId: f.projectId, contributor: 'builder' });
  const machineId = randomUUID(),
    sessionId = randomUUID();
  const configuration = {
    provider: 'mac',
    machineId,
    runtime: f.runner.runtime,
    environmentFingerprint: f.runner.environmentFingerprint,
  };
  const configured = await f.configure({ kind: 'runner', configuration }, f.configuration.digest);
  const registration = { operationId: sessionId, authorityEpoch: 1, configuration };
  const register = (actor = 'owner') =>
    f
      .call(
        'macRegister',
        worker.register,
        { projectId: f.projectId, request: JSON.stringify(registration) },
        actor,
      )
      .then(JSON.parse);
  const registered = await register();
  const control = (runId, command) =>
    f
      .call('macControl', worker.control, {
        projectId: f.projectId,
        machineId,
        sessionId,
        runId,
        command: JSON.stringify({ owner: sessionId, ...command }),
      })
      .then(JSON.parse);
  const queued = await f.enqueue(
    f.selection({
      expectedConfiguration: configured.digest,
      expectedEnvironment: configuration.environmentFingerprint,
    }),
  );
  const token = (await control(queued.id, { kind: 'claim', leaseMs: 60000 })).run.lease.token;
  await control(queued.id, {
    kind: 'prepare',
    token,
    plan: {
      head: queued.request.expectedHead,
      definition: queued.check.definition,
      runtime: configuration.runtime,
      environmentFingerprint: configuration.environmentFingerprint,
      lockfile: 'a'.repeat(64),
      selection: f.put('synthetic-selection'),
      manifest: f.put('synthetic-plan'),
      shardCount: 1,
    },
  });
  await control(queued.id, { kind: 'reserve', token });
  const run = (
    await control(queued.id, {
      kind: 'observe',
      token,
      result: { status: 'accepted', executionId: `mac-${queued.id}` },
    })
  ).run;
  // An empty summary stream seal: a real collector message with no storage object.
  const message = outputMessage(run, {
    kind: 'seal',
    seal: {
      stream: {
        kind: 'summary',
        shard: 0,
        attempt: run.fence,
        executionId: 'synthetic-shard-0',
        stream: 'stdout',
        name: '',
      },
      chunks: 0,
      bytes: 0,
      sha256: digest(''),
    },
  });
  const single = (signature, m = message) => ({
    projectId: f.projectId,
    message: JSON.stringify(m),
    signature,
  });
  const prepare = (signature, actor = 'owner', m = message) =>
    f.call('collectorPrepare', api.workerPrepare, single(signature, m), actor).then(JSON.parse);
  const prepareBatch = (signature, actor = 'owner') =>
    f
      .call(
        'collectorPrepareBatch',
        batch.workerPrepare,
        { projectId: f.projectId, entries: [{ message: JSON.stringify(message), signature }] },
        actor,
      )
      .then(JSON.parse);
  /** The public commit action, with its internal steps run as this store's mutations. */
  const commit = async (module, args, subject) =>
    JSON.parse(
      await module.workerCommit._handler(
        {
          auth: { getUserIdentity: async () => (subject ? { subject } : null) },
          runQuery: async () => assert.fail('No query on the commit path.'),
          runMutation: (ref, input) => {
            const name = getFunctionName(ref).split(':').at(-1);
            return f.call(`collector${name}`, module[name], input);
          },
        },
        args,
      ),
    );
  return {
    ...f,
    machineId,
    sessionId,
    registered,
    register,
    run,
    message,
    prepare,
    prepareBatch,
    commit,
    single,
  };
}

test('registration issues a machine key derived per project and machine, never stored', async () => {
  const f = await fixture();
  const key = f.registered.collectorKey;
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.notEqual(key, deploymentKey);
  assert.equal(
    key,
    machineCollectorKey(deploymentKey, {
      keyId: 'SYNTHETIC',
      projectId: f.projectId,
      machineId: f.machineId,
    }),
  );
  assert.notEqual(
    key,
    machineCollectorKey(deploymentKey, {
      keyId: 'SYNTHETIC',
      projectId: f.projectId,
      machineId: randomUUID(),
    }),
  );
  assert.equal(runSigningSecret(deploymentKey, f.run), key);
  // Provider (non-machine) runs keep the backend-only key.
  assert.equal(
    runSigningSecret(deploymentKey, { ...f.run, configuration: { provider: 'github-actions' } }),
    deploymentKey,
  );
  // Neither key is persisted: not in the worker row, the operation receipt or any table.
  for (const [table, rows] of Object.entries(f.tables))
    for (const row of rows.values()) {
      const text = JSON.stringify(row);
      assert(!text.includes(key), `${table} must not store the machine key`);
      assert(!text.includes(deploymentKey), `${table} must not store the deployment key`);
    }
  // The CLI uses the issued key; it never needs the legacy key file.
  assert.equal(collectorKey(f.registered, {}), key);
  assert.throws(
    () => collectorKey({ ...f.registered, collectorKey: 'not-a-key' }, {}),
    code('RUNNER_UNAVAILABLE'),
  );
  // Only the project owner is issued a key.
  await assert.rejects(f.register('builder'), code('PROJECT_UNAVAILABLE'));
});

test('owner collector path: signed-in owner with the machine key commits output end to end', async t => {
  const f = await fixture();
  const key = f.registered.collectorKey,
    signature = signOutput(f.message, key);
  // Budget: the same one call; binding the caller adds at most two indexed reads.
  await f.call('backendPrepare', api.prepare, f.single(signature));
  const backend = f.counts.at(-1);
  const prepared = await f.prepare(signature);
  const bound = f.counts.at(-1);
  assert.equal(bound.name, 'collectorPrepare');
  assert(bound.documents - backend.documents <= 2, `bound reads ${bound.documents} vs ${backend.documents}`);
  assert.equal(bound.writes, backend.writes);
  t.diagnostic(JSON.stringify({ backendReads: backend.documents, boundReads: bound.documents, calls: 1 }));
  assert.equal(prepared.object, null);
  assert.equal(prepared.target, null);
  const receipt = await f.commit(api, f.single(signature), 'owner');
  assert.equal(receipt.duplicate, false);
  assert.equal(receipt.revision, 1);
  // Batch endpoints accept the same owner and key; the original seal reconciles as a duplicate.
  assert.equal((await f.prepareBatch(signature)).length, 1);
  const replay = await f.commit(
    batch,
    { projectId: f.projectId, entries: [{ message: JSON.stringify(f.message), signature }] },
    'owner',
  );
  assert.equal(replay[0].duplicate, true);
  // Heartbeat and result callbacks are verified with the same machine key.
  const heartbeat = {
    projectId: f.projectId,
    runId: f.run.id,
    owner: f.sessionId,
    token: f.run.lease.token,
    fence: f.run.fence,
    eventId: randomUUID(),
  };
  const renewed = JSON.parse(
    await f.call('collectorHeartbeat', worker.heartbeat, {
      projectId: f.projectId,
      callback: JSON.stringify(heartbeat),
      signature: signMacHeartbeat(heartbeat, key),
    }),
  );
  assert(renewed.lease.until >= f.run.lease.until);
  const shard = { ...f.shard(f.run, 0, 'passed', { attempt: f.run.fence }), provider: 'mac' };
  const settled = JSON.parse(
    await f.call('collectorCallback', worker.callback, {
      projectId: f.projectId,
      callback: JSON.stringify(shard),
      signature: signHostedCheckCallback(shard, key),
    }),
  );
  assert.equal(settled.counts.passed, 1);
});

test('authority for one project or machine is refused on another project’s run', async () => {
  const f = await fixture();
  // The real key another project's owner holds for a machine with this very UUID,
  // a key for another machine here, and the deployment key a legacy collector held.
  const otherProject = machineCollectorKey(deploymentKey, {
    keyId: 'SYNTHETIC',
    projectId: `${f.projectId}-other`,
    machineId: f.machineId,
  });
  const otherMachine = machineCollectorKey(deploymentKey, {
    keyId: 'SYNTHETIC',
    projectId: f.projectId,
    machineId: randomUUID(),
  });
  for (const foreign of [otherProject, otherMachine, deploymentKey]) {
    const signature = signOutput(f.message, foreign);
    await assert.rejects(f.prepare(signature), code('EVIDENCE_CHANGED'));
    await assert.rejects(f.prepareBatch(signature), code('EVIDENCE_CHANGED'));
    await assert.rejects(f.commit(api, f.single(signature), 'owner'), code('EVIDENCE_CHANGED'));
    const heartbeat = {
      projectId: f.projectId,
      runId: f.run.id,
      owner: f.sessionId,
      token: f.run.lease.token,
      fence: f.run.fence,
      eventId: randomUUID(),
    };
    await assert.rejects(
      f.call('foreignHeartbeat', worker.heartbeat, {
        projectId: f.projectId,
        callback: JSON.stringify(heartbeat),
        signature: signMacHeartbeat(heartbeat, foreign),
      }),
      code('EVIDENCE_CHANGED'),
    );
    const shard = { ...f.shard(f.run, 0, 'passed', { attempt: f.run.fence }), provider: 'mac' };
    await assert.rejects(
      f.call('foreignCallback', worker.callback, {
        projectId: f.projectId,
        callback: JSON.stringify(shard),
        signature: signHostedCheckCallback(shard, foreign),
      }),
      code('EVIDENCE_CHANGED'),
    );
  }
  assert.equal(f.tables.projectHostedOutputStreams.size, 0);
});

test('a caller who is not the machine owner is refused, even with a valid signature', async () => {
  const f = await fixture();
  const signature = signOutput(f.message, f.registered.collectorKey);
  for (const actor of ['builder', 'stranger']) {
    await assert.rejects(f.prepare(signature, actor), code('PROJECT_UNAVAILABLE'));
    await assert.rejects(f.prepareBatch(signature, actor), code('PROJECT_UNAVAILABLE'));
    await assert.rejects(f.commit(api, f.single(signature), actor), code('PROJECT_UNAVAILABLE'));
    await assert.rejects(
      f.commit(
        batch,
        { projectId: f.projectId, entries: [{ message: JSON.stringify(f.message), signature }] },
        actor,
      ),
      code('PROJECT_UNAVAILABLE'),
    );
  }
  // No identity at all is refused before any record is read.
  await assert.rejects(f.commit(api, f.single(signature), null), code('PROJECT_UNAVAILABLE'));
  // A revoked machine's owner is refused too.
  const machine = [...f.tables.projectHostedCheckWorkers.values()].find(r => r.machineId === f.machineId);
  f.patch('projectHostedCheckWorkers', machine._id, { revokedAt: Date.now() });
  await assert.rejects(f.prepare(signature), code('MAC_MACHINE_REVOKED'));
  assert.equal(f.tables.projectHostedOutputStreams.size, 0);
});

test('collector endpoints refuse provider runs, whose output only the backend signs', async () => {
  const f = await checksFixture();
  const run = await f.activate((await f.enqueue(f.selection())).id);
  assert.equal(run.configuration.provider, 'github-actions');
  const message = outputMessage(run, {
    kind: 'seal',
    seal: {
      stream: {
        kind: 'summary',
        shard: 0,
        attempt: 0,
        executionId: 'synthetic-shard-0',
        stream: 'stdout',
        name: '',
      },
      chunks: 0,
      bytes: 0,
      sha256: digest(''),
    },
  });
  await assert.rejects(
    f.call('providerPrepare', api.workerPrepare, {
      projectId: f.projectId,
      message: JSON.stringify(message),
      signature: signOutput(message, deploymentKey),
    }),
    code('PROJECT_UNAVAILABLE'),
  );
});
