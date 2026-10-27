// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as immediate } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { checksFixture, code } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { checkPin } from '../dist/hosted-check.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { checkEnvironment } from '../dist/check-environment.js';
import { executeHostedMacCheck } from '../dist/hosted-mac-execute.js';
import { deliverMacCallback } from '../dist/hosted-mac-delivery.js';
import { workerCli } from '../dist/worker-cli.js';
import { runHostedMacWorker, HostedMacProvider } from '../dist/hosted-mac-worker.js';
import { signMacHeartbeat } from '../dist/hosted-mac-lease.js';
const worker = await import(moduleUrl('../convex/projectHostedCheckWorker.ts'));
const lease = await import(moduleUrl('../convex/projectHostedCheckLease.ts'));
const outputStore = await import(moduleUrl('../convex/projectHostedOutputStore.ts'));
const secret = 'synthetic-mac-fixed-collector';

async function fixture(t, actualEnvironment = false) {
  const localLogs = mkdtempSync(join(tmpdir(), 'forge-mac-log-test-'));
  const oldLogs = process.env.FORGE_LOCAL_CHECK_LOG_DIR;
  process.env.FORGE_LOCAL_CHECK_LOG_DIR = localLogs;
  t.after(() => {
    if (oldLogs === undefined) delete process.env.FORGE_LOCAL_CHECK_LOG_DIR;
    else process.env.FORGE_LOCAL_CHECK_LOG_DIR = oldLogs;
    rmSync(localLogs, { recursive: true, force: true });
  });
  const oldId = process.env.FORGE_HOSTED_CHECK_KEY_ID,
    oldKey = process.env.FORGE_HOSTED_CHECK_KEY_SYNTHETIC;
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
  process.env.FORGE_HOSTED_CHECK_KEY_SYNTHETIC = secret;
  t.after(() => {
    for (const [name, value] of [
      ['FORGE_HOSTED_CHECK_KEY_ID', oldId],
      ['FORGE_HOSTED_CHECK_KEY_SYNTHETIC', oldKey],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  const f = await checksFixture(),
    scheduled = [];
  f.decorateContext(ctx => {
    ctx.scheduler = {
      runAfter: async (delay, ref, args) => {
        scheduled.push({ delay, args });
        return `timer-${scheduled.length}`;
      },
    };
  });
  const machineId = randomUUID(),
    sessionId = randomUUID();
  const configuration = {
    provider: 'mac',
    machineId,
    runtime: f.runner.runtime,
    environmentFingerprint: actualEnvironment
      ? checkEnvironment().fingerprint
      : f.runner.environmentFingerprint,
  };
  const configured = await f.configure({ kind: 'runner', configuration }, f.configuration.digest);
  const address = { projectId: f.projectId, machineId, sessionId };
  const registration = { operationId: sessionId, authorityEpoch: 1, configuration };
  const register = (request = registration, actor = 'owner') =>
    f
      .call(
        'macRegister',
        worker.register,
        { projectId: f.projectId, request: JSON.stringify(request) },
        actor,
      )
      .then(JSON.parse);
  await register();
  const enqueue = overrides =>
    f.enqueue(
      f.selection({
        expectedConfiguration: configured.digest,
        expectedEnvironment: configuration.environmentFingerprint,
        ...overrides,
      }),
    );
  const control = (runId, command) =>
    f
      .call('macControl', worker.control, { ...address, runId, command: JSON.stringify(command) })
      .then(JSON.parse);
  const claim = id => control(id, { kind: 'claim', owner: sessionId, leaseMs: 60_000 });
  const heartbeat = (run, eventId = randomUUID(), signature) => {
    const value = {
      projectId: f.projectId,
      runId: run.id,
      owner: sessionId,
      token: run.lease.token,
      fence: run.fence,
      eventId,
    };
    return f
      .call('macHeartbeat', worker.heartbeat, {
        projectId: f.projectId,
        callback: JSON.stringify(value),
        signature: signature ?? signMacHeartbeat(value, secret),
      })
      .then(JSON.parse);
  };
  const expire = (run, now) =>
    f.run('macExpire', (ctx, input) => lease.expireMacLease(ctx, input, now), {
      projectId: f.projectId,
      runId: run.id,
      fence: run.fence,
      until: run.lease?.until ?? run.ownerDeadline,
    });
  return {
    ...f,
    localLogs,
    configuration,
    scheduled,
    address,
    enqueue,
    register,
    registration,
    claim,
    control,
    heartbeat,
    expire,
  };
}

test('landing-worker wedge replay requeues one expired owner, fences late work, then settles and wakes without restart', async t => {
  const f = await fixture(t),
    run = await f.enqueue();
  assert.equal(f.scheduled.length, 1, 'An unclaimed run also has a finite owner deadline.');
  const first = (await f.claim(run.id)).run;
  const repeat = (await f.claim(run.id)).run;
  assert.deepEqual(repeat.lease, first.lease, 'Lost claim replies retain the same live lease.');
  await f.expire(first, first.lease.until);
  const queued = await f.status(run.id);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.leaseRetries, 1);
  assert.equal(queued.fence, first.fence + 1);
  await assert.rejects(f.heartbeat(first), code('WORK_STALE'));
  const second = (await f.claim(run.id)).run;
  assert.equal(second.lease.owner, f.address.sessionId);
  assert(second.lease.token > first.lease.token);
  await assert.rejects(
    f.control(run.id, { kind: 'reserve', owner: first.lease.owner, token: first.lease.token }),
    code('WORK_STALE'),
  );
  await f.expire(first, second.lease.until + 1);
  assert.equal(
    (await f.status(run.id)).status,
    'preparing',
    'An old watchdog cannot expire the replacement.',
  );
  await f.expire(second, second.lease.until);
  const terminal = await f.status(run.id);
  assert.equal(terminal.status, 'runner-unavailable');
  assert.equal(terminal.failureReason, 'MAC_RUNNER_LEASE_EXPIRED');
  assert(terminal.terminalDigest);
  assert(terminal.endedAt);
  assert.equal((await f.claim(run.id)).acquired, false);
  await f.expire(second, second.lease.until + 100_000);
  assert.deepEqual(await f.status(run.id), terminal, 'Expiry redelivery is idempotent.');
});

test('a never-started or requeued run with no controller settles after the finite owner windows', async t => {
  const f = await fixture(t),
    run = await f.enqueue();
  await f.expire(run, run.ownerDeadline);
  const queued = await f.status(run.id);
  await f.expire(queued, queued.ownerDeadline);
  assert.equal((await f.status(run.id)).failureReason, 'MAC_RUNNER_NO_OWNER');
});

test('signed heartbeats renew preparation, reject tampering and expiry, and retry without extending twice', async t => {
  const f = await fixture(t),
    run = (await f.claim((await f.enqueue()).id)).run;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.setTime(Date.now() + 1000);
  const event = randomUUID();
  await assert.rejects(f.heartbeat(run, event, 'wrong'), code('EVIDENCE_CHANGED'));
  const renewed = await f.heartbeat(run, event),
    timerCount = f.scheduled.length;
  assert(renewed.lease.until >= run.lease.until);
  assert.deepEqual(await f.heartbeat(run, event), renewed);
  assert.equal(f.scheduled.length, timerCount);
  await f.expire(run, run.lease.until);
  assert(renewed.lease.until > run.lease.until);
  assert.equal((await f.status(run.id)).status, 'preparing');
  await f.expire(renewed, renewed.lease.until);
  await assert.rejects(f.heartbeat(renewed), code('WORK_STALE'));
});

test('registration and claims recheck owner, configured machine, session and operation identity', async t => {
  const f = await fixture(t);
  await assert.rejects(
    f.register({ ...f.registration, operationId: randomUUID() }, 'outsider'),
    code('PROJECT_UNAVAILABLE'),
  );
  assert.equal((await f.register()).status, 'completed');
  await assert.rejects(
    f.register({ ...f.registration, configuration: { ...f.configuration, runtime: 'a'.repeat(64) } }),
    code('WORK_OPERATION_CHANGED'),
  );
  const run = await f.enqueue();
  await assert.rejects(
    f.control(run.id, { kind: 'claim', owner: randomUUID(), leaseMs: 60_000 }),
    code('WORK_STALE'),
  );
  const work = JSON.parse(await f.call('macWork', worker.work, f.address));
  assert.deepEqual(work, [run.id]);
  const count = f.tables.projectHostedCheckWorkers.size;
  assert.equal(count, 1);
});

test('cancel fences a reserved execution immediately and late signed success cannot revive it', async t => {
  const f = await fixture(t),
    id = (await f.enqueue()).id,
    claim = (await f.claim(id)).run;
  const plan = {
    head: claim.request.expectedHead,
    definition: claim.check.definition,
    runtime: claim.configuration.runtime,
    environmentFingerprint: claim.request.expectedEnvironment,
    lockfile: 'e'.repeat(64),
    selection: f.put('{}'),
    manifest: f.put('{"plan":1}'),
    shardCount: 1,
  };
  const command = change =>
    f.control(id, { owner: f.address.sessionId, token: claim.lease.token, ...change });
  await command({ kind: 'prepare', plan });
  await command({ kind: 'reserve' });
  const running = (
    await command({ kind: 'observe', result: { status: 'accepted', executionId: 'mac-execution' } })
  ).run;
  const cancelled = await f.cancel(id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.fence, running.fence + 1);
  assert.deepEqual(await f.cancel(id), cancelled);
  const callback = f.complete(running, 'passed');
  callback.provider = 'mac';
  await assert.rejects(f.callback(callback), code('EVIDENCE_CHANGED'));
  assert.equal((await f.status(id)).status, 'cancelled');
});

test('one idle minute makes zero Convex calls and has no poll or heartbeat timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let update,
    calls = 0,
    closed = 0;
  const stop = new AbortController();
  const running = runHostedMacWorker(
    {
      sessionId: randomUUID(),
      key: secret,
      work: listener => {
        update = listener;
        listener([]);
        return () => {};
      },
      watch: () => assert.fail('No active run'),
      control: async () => {
        calls++;
        assert.fail('Idle runner must not claim.');
      },
      heartbeat: async () => {
        calls++;
        assert.fail('Idle runner must not renew.');
      },
      execute: () => assert.fail('No queued work'),
      close: async () => {
        closed++;
      },
    },
    stop.signal,
  );
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  update([]);
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(calls, 0);
  stop.abort();
  await running;
  assert.equal(closed, 1);
});

test('provider refuses a run with no live owner and deduplicates concurrent delivery', async t => {
  const f = await fixture(t),
    run = (await f.claim((await f.enqueue()).id)).run;
  run.dispatchStarted = true;
  run.executionId = 'mac-execution';
  run.planDigest = 'a'.repeat(64);
  run.plan = {};
  let starts = 0;
  const provider = new HostedMacProvider(
    run,
    async () => {
      starts++;
    },
    new AbortController().signal,
  );
  await Promise.all([provider.dispatch(run), provider.dispatch(run)]);
  assert.equal(starts, 1);
  run.lease = null;
  await assert.rejects(provider.dispatch(run), code('WORK_STALE'));
});

for (const uploadLocal of [false, true])
  test(`direct hosted/R2 execution preserves local logs and uploads them only with opt-in (${uploadLocal})`, async t => {
    const f = await fixture(t, true);
    const definition = await f.configure(
      {
        kind: 'definition',
        checkId: f.checkId,
        command: {
          name: 'synthetic-process',
          executable: process.execPath,
          args: [
            '-e',
            'console.log("synthetic success"); console.error("diagnostic"); if(process.env.FORGE_HOSTED_CHECK_KEY_SYNTHETIC) process.exit(99);',
          ],
          environmentLabel: 'clean',
        },
      },
      f.definition.digest,
    );
    f.tables.hostedProjects.get(f.projectId).autonomyPolicy = {
      ...policyPreset('supervised'),
      checkLogs: { uploadLocal, retentionDays: 90 },
    };
    const run = (await f.claim((await f.enqueue({ expectedDefinition: definition.digest })).id)).run;
    const state = Buffer.from(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: [],
        message: 'synthetic check source',
        at: '2026-01-01T00:00:00.000Z',
      }),
    );
    assert.equal(digest(state), run.request.expectedHead);
    const uploaded = [],
      outputObjects = new Map();
    let lostChunkReply = false,
      lostCompletionReply = false;
    const transport = {
      objects: async ids =>
        ids.map(sha256 => {
          assert.equal(sha256, run.request.expectedHead);
          return { sha256, size: state.length };
        }),
      downloadToFile: async (_, path) => writeFile(path, state),
      upload: async (pin, bytes) => {
        uploaded.push(pin);
        f.put(bytes);
      },
      callback: async (callback, signature) => {
        const result = JSON.parse(
          await f.call('macCallback', worker.callback, {
            projectId: f.projectId,
            callback: JSON.stringify(callback),
            signature,
          }),
        );
        if (callback.result.kind === 'complete' && !lostCompletionReply) {
          lostCompletionReply = true;
          throw new TypeError('Completion committed; reply lost.');
        }
        return result;
      },
      output: {
        prepare: async message => {
          const object =
            message.body.kind === 'chunk'
              ? message.body.chunk.object
              : (await import('../dist/hosted-check-output.js')).outputRootObject(message.body.root);
          return {
            object,
            target: { kind: 'r2', url: `https://synthetic.invalid/${object.sha256}`, headers: {} },
          };
        },
        put: async (url, _, bytes) => {
          outputObjects.set(url.split('/').at(-1), Buffer.from(bytes));
          return { status: 200 };
        },
        commit: async (message, signature) => {
          const result = await f.run(
            'macOutput',
            (ctx, input) => outputStore.commitHostedOutput(ctx, input, () => secret),
            {
              projectId: f.projectId,
              message,
              signature,
            },
          );
          if (message.body.kind === 'chunk' && !lostChunkReply) {
            lostChunkReply = true;
            throw new TypeError('Chunk committed; reply lost.');
          }
          return result;
        },
      },
    };
    await executeHostedMacCheck(
      run,
      new AbortController().signal,
      async command => (await f.control(run.id, command)).run,
      transport,
      secret,
    );
    assert.equal((await f.status(run.id)).status, 'passed');
    assert(lostCompletionReply);
    assert.equal(lostChunkReply, uploadLocal);
    assert.equal(uploaded.length, 2);
    if (uploadLocal) assert(outputObjects.size >= 3);
    assert.equal(
      [...outputObjects.values()].some(bytes => bytes.toString().includes('synthetic success')),
      uploadLocal,
    );
    const localFiles = readdirSync(f.localLogs, { recursive: true }).filter(name =>
      String(name).endsWith('.log'),
    );
    assert(
      localFiles.some(name => readFileSync(join(f.localLogs, name), 'utf8').includes('synthetic success')),
    );
    assert.equal(f.tables.projectHostedActionsExports.size, 0);
  });

test('active renewal is signed, cancel stops the live process through its subscription, then idle stops calling', async t => {
  const f = await fixture(t),
    queued = await f.enqueue();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let notify,
    heartbeats = 0,
    started;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  const stop = new AbortController();
  const running = runHostedMacWorker(
    {
      sessionId: f.address.sessionId,
      key: secret,
      work: update => {
        update([queued.id]);
        return () => {};
      },
      watch: (_, update) => {
        notify = update;
        return () => {};
      },
      control: f.control,
      heartbeat: async (callback, signature) => {
        heartbeats++;
        assert.equal(signature, signMacHeartbeat(callback, secret));
        return JSON.parse(
          await f.call('macHeartbeat', worker.heartbeat, {
            projectId: f.projectId,
            callback: JSON.stringify(callback),
            signature,
          }),
        );
      },
      execute: async (_, signal) => {
        started();
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      },
      close: async () => {},
    },
    stop.signal,
  );
  await ready;
  t.mock.timers.tick(20_000);
  await immediate();
  assert.equal(heartbeats, 1);
  notify(await f.cancel(queued.id));
  await immediate();
  t.mock.timers.tick(120_000);
  await immediate();
  assert.equal(heartbeats, 1, 'No renewal after cancellation, including while idle.');
  stop.abort();
  await running;
});

test('a hung heartbeat cannot keep execution alive beyond its last acknowledged lease', async t => {
  const f = await fixture(t),
    queued = await f.enqueue();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  let started,
    stopped = false;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  const stop = new AbortController();
  const running = runHostedMacWorker(
    {
      sessionId: f.address.sessionId,
      key: secret,
      work: update => {
        update([queued.id]);
        return () => {};
      },
      watch: () => () => {},
      control: f.control,
      heartbeat: () => new Promise(() => {}),
      execute: async (_, signal) => {
        started();
        await new Promise(resolve =>
          signal.addEventListener(
            'abort',
            () => {
              stopped = true;
              resolve();
            },
            { once: true },
          ),
        );
      },
      close: async () => {},
    },
    stop.signal,
  );
  await ready;
  t.mock.timers.tick(60_001);
  await immediate();
  assert(stopped);
  stop.abort();
  await running;
});

test('replacement execution can pass after the expired execution already reported a shard', async t => {
  const f = await fixture(t),
    id = (await f.enqueue()).id;
  const activate = async () => {
    const run = (await f.claim(id)).run;
    const send = change => f.control(id, { owner: f.address.sessionId, token: run.lease.token, ...change });
    await send({
      kind: 'prepare',
      plan: {
        head: run.request.expectedHead,
        definition: run.check.definition,
        runtime: run.configuration.runtime,
        environmentFingerprint: run.request.expectedEnvironment,
        lockfile: 'a'.repeat(64),
        selection: f.put('{}'),
        manifest: f.put('{"plan":1}'),
        shardCount: 1,
      },
    });
    await send({ kind: 'reserve' });
    return (
      await send({ kind: 'observe', result: { status: 'accepted', executionId: `mac-attempt-${run.fence}` } })
    ).run;
  };
  const first = await activate();
  const shard = run => {
    const value = f.shard(run, 0, 'passed', { attempt: run.fence });
    value.provider = 'mac';
    return value;
  };
  await f.callback(shard(first));
  await f.expire(first, first.lease.until);
  const second = await activate();
  const reported = await f.callback(shard(second));
  assert.deepEqual(reported.counts, { completed: 1, passed: 1, failed: 0 });
  const complete = f.complete(second, 'passed');
  complete.provider = 'mac';
  assert.equal((await f.callback(complete)).status, 'passed');
  await assert.rejects(f.callback(shard(first)), code('EVIDENCE_CHANGED'));
});

test('worker CLI rejects incomplete addresses before opening a connection', async () => {
  await assert.rejects(workerCli([]), code('BAD_ARGUMENT'));
  await assert.rejects(
    workerCli(['https://synthetic.invalid', 'project', 'invalid-machine']),
    code('BAD_ARGUMENT'),
  );
});

test('unknown callback replies retry the retained event while definitive denials stop immediately', async () => {
  const event = { eventId: randomUUID() };
  let calls = 0;
  const result = await deliverMacCallback(async () => {
    calls++;
    if (calls === 1) throw new TypeError('Reply lost');
    return event;
  });
  assert.equal(result, event);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    deliverMacCallback(async () => {
      calls++;
      throw Object.assign(new Error('revoked'), { code: 'PROJECT_UNAVAILABLE' });
    }),
    code('PROJECT_UNAVAILABLE'),
  );
  assert.equal(calls, 1);
});

test('lease failure settles after requester access is revoked without returning private data', async t => {
  const f = await fixture(t),
    first = (await f.claim((await f.enqueue()).id)).run;
  await f.expire(first, first.lease.until);
  const queued = await f.status(first.id);
  f.patch('hostedProjects', f.projectId, { removal: 'trash' });
  await f.expire(queued, queued.ownerDeadline);
  const stored = [...f.tables.projectHostedCheckRuns.values()].find(row => row.runId === first.id);
  assert.equal(JSON.parse(stored.value).status, 'runner-unavailable');
  assert.equal(await f.claim(first.id).catch(error => error.data?.code ?? error.code), 'PROJECT_UNAVAILABLE');
});
