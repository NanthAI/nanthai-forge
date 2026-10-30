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
import { checkPin, hostedMacRunnerSchema, hostedMachineRunnerSchema } from '../dist/hosted-check.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { checkEnvironment } from '../dist/check-environment.js';
import { executeHostedMacCheck } from '../dist/hosted-mac-execute.js';
import { deliverMacCallback } from '../dist/hosted-mac-delivery.js';
import { workerCli, workerConfiguration } from '../dist/worker-cli.js';
import { runHostedMacWorker, HostedMacProvider } from '../dist/hosted-mac-worker.js';
import { signMacHeartbeat, hostedMacRuntime } from '../dist/hosted-mac-lease.js';
const worker = await import(moduleUrl('../convex/projectHostedCheckWorker.ts'));
const lease = await import(moduleUrl('../convex/projectHostedCheckLease.ts'));
const outputStore = await import(moduleUrl('../convex/projectHostedOutputStore.ts'));
const secret = 'synthetic-mac-fixed-collector';

async function fixture(t, actualEnvironment = false, provider = 'mac') {
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
    provider,
    ...(provider === 'self-hosted'
      ? { platform: { os: process.platform, arch: process.arch }, labels: ['build'] }
      : {}),
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
  await assert.rejects(f.callback(callback), code('CHECK_CANCELLED'));
  await assert.rejects(f.heartbeat(running), code('CHECK_CANCELLED'));
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

for (const provider of ['mac', 'self-hosted'])
  for (const uploadLocal of [false, true])
    test(`direct hosted/R2 execution preserves local logs and uploads them only with opt-in (${provider}, ${uploadLocal})`, async t => {
      if (provider === 'self-hosted') {
        const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'linux' });
        t.after(() => Object.defineProperty(process, 'platform', descriptor));
        const { syncBuiltinESMExports } = await import('node:module');
        const childProcess = await import('node:child_process');
        const original = childProcess.default.execFileSync;
        t.mock.method(childProcess.default, 'execFileSync', (...args) => {
          assert(
            !['/bin/ps', 'security', 'launchctl', 'sandbox-exec', 'xcodebuild'].includes(args[0]),
            'No Darwin tool on Linux',
          );
          return original(...args);
        });
        syncBuiltinESMExports();
        t.after(() => {
          t.mock.restoreAll();
          syncBuiltinESMExports();
        });
      }
      const f = await fixture(t, true, provider);
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
      if (provider === 'self-hosted')
        for (let i = 0; i < 1500; i++)
          f.insert('projectHostedCheckRuns', {
            projectId: f.projectId,
            runId: randomUUID(),
            candidateId: randomUUID(),
            machineId: randomUUID(),
            status: 'passed',
            value: '{}',
          });
      const meterStart = f.counts.length,
        wallStart = performance.now();
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
          if (provider === 'self-hosted')
            await assert.rejects(
              f.call('badSelfCallback', worker.callback, {
                projectId: f.projectId,
                callback: JSON.stringify(callback),
                signature: '0'.repeat(64),
              }),
              code('EVIDENCE_CHANGED'),
            );
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
      await f.heartbeat(run);
      if (provider === 'self-hosted') {
        const stop = new AbortController();
        await runHostedMacWorker(
          {
            sessionId: f.address.sessionId,
            key: secret,
            work: update => {
              update([run.id]);
              return () => {};
            },
            watch: () => () => {},
            control: f.control,
            heartbeat: async (callback, signature) =>
              JSON.parse(
                await f.call('heartbeat', worker.heartbeat, {
                  projectId: f.projectId,
                  callback: JSON.stringify(callback),
                  signature,
                }),
              ),
            execute: async (owned, signal, control) => {
              await executeHostedMacCheck(owned, signal, control, transport, secret);
              stop.abort();
            },
            close: async () => {},
          },
          stop.signal,
        );
      } else
        await executeHostedMacCheck(
          run,
          new AbortController().signal,
          async command => (await f.control(run.id, command)).run,
          transport,
          secret,
        );
      const completed = await f.status(run.id);
      assert.equal(completed.status, 'passed');
      assert.equal(completed.configuration.provider, provider);
      assert.equal(completed.macEvidence.machineId, f.configuration.machineId);
      assert.equal(completed.macEvidence.registrationId, f.address.sessionId);
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
      if (provider === 'self-hosted') {
        const meters = f.counts.slice(meterStart);
        const reads = meters.reduce((sum, meter) => sum + meter.documents, 0);
        const writes = meters.reduce((sum, meter) => sum + meter.writes, 0);
        assert(
          meters.length <= 40 && reads <= 200 && writes <= 100,
          'bounded single-run control/evidence traffic',
        );
        t.diagnostic(
          `Linux fake, 1500 retained runs, uploadLocal=${uploadLocal}: ${meters.length} function calls (includes lost-reply retries and signature-negative probes), ${reads} document reads, ${writes} writes; wall ${Math.round(performance.now() - wallStart)}ms; process maxRSS ${process.resourceUsage().maxRSS} KiB`,
        );
      }
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

test('machine schemas retain legacy bytes while new configurations round-trip platform and labels', () => {
  const legacy = {
    provider: 'mac',
    machineId: randomUUID(),
    runtime: 'a'.repeat(64),
    environmentFingerprint: 'b'.repeat(64),
  };
  assert.deepEqual(hostedMacRunnerSchema.parse(legacy), legacy);
  assert.equal(checkPin(hostedMachineRunnerSchema.parse(legacy)), checkPin(legacy));
  const current = {
    ...legacy,
    provider: 'self-hosted',
    platform: { os: 'linux', arch: 'x64' },
    labels: ['linux', 'build'],
  };
  assert.deepEqual(hostedMachineRunnerSchema.parse(current), current);
  // Optional metadata permits additive server-first deployment; new CLI writes it.
  assert(hostedMachineRunnerSchema.safeParse({ ...legacy, provider: 'self-hosted' }).success);
  assert(!hostedMachineRunnerSchema.safeParse({ ...current, platform: { os: 'linux' } }).success);
});

test('new worker keeps the exact legacy or self-hosted registration and refuses pin drift', () => {
  const machineId = randomUUID();
  const environmentFingerprint = checkEnvironment().fingerprint;
  const legacy = { provider: 'mac', machineId, runtime: hostedMacRuntime, environmentFingerprint };
  assert.deepEqual(workerConfiguration(legacy, machineId), legacy);
  const current = {
    ...legacy,
    provider: 'self-hosted',
    platform: { os: process.platform, arch: process.arch },
    labels: ['build'],
  };
  assert.deepEqual(workerConfiguration(current, machineId), current);
  assert.throws(
    () => workerConfiguration({ ...current, environmentFingerprint: 'f'.repeat(64) }, machineId),
    code('EVIDENCE_CHANGED'),
  );
  assert.throws(
    () => workerConfiguration({ ...current, platform: { os: 'different', arch: process.arch } }, machineId),
    code('EVIDENCE_CHANGED'),
  );
  assert.throws(() => workerConfiguration(current, randomUUID()), code('EVIDENCE_CHANGED'));
});

test('one-command setup configures and starts in the same environment with replayable parameters', async t => {
  const { startSelfHostedRunner } = await import('../scripts/self-hosted-runner/start.mjs');
  const root = mkdtempSync(join(tmpdir(), 'forge-setup-test-'));
  const old = process.env.FORGE_RUNNER_STATE_DIR;
  process.env.FORGE_RUNNER_STATE_DIR = root;
  t.after(() => {
    if (old === undefined) delete process.env.FORGE_RUNNER_STATE_DIR;
    else process.env.FORGE_RUNNER_STATE_DIR = old;
    rmSync(root, { recursive: true, force: true });
  });
  const machineId = randomUUID(),
    calls = [];
  const services = {
    transport: { dispatch: async (action, parameters) => calls.push({ action, parameters }) },
    worker: async args => calls.push(args),
  };
  const args = ['https://synthetic.invalid', 'synthetic-project', machineId, '["build"]'];
  await startSelfHostedRunner(args, services);
  const selected = calls[0].parameters.configuration;
  assert.equal(calls[0].action, 'configure-runner');
  assert.equal(selected.provider, 'self-hosted');
  assert.deepEqual(selected.labels, ['build']);
  assert.deepEqual(workerConfiguration(selected, machineId), selected);
  assert.deepEqual(calls[1], args.slice(0, 3));
  await startSelfHostedRunner(args, services);
  assert.deepEqual(calls[2], calls[0], 'same pins retain the journal operation identity');
  await assert.rejects(startSelfHostedRunner([], services));
  await assert.rejects(startSelfHostedRunner([...args.slice(0, 3), '{}'], services));
});

test('dogfood-sized idle queue is bounded and a settled empty subscription makes zero further calls', async t => {
  const f = await fixture(t, false, 'self-hosted');
  for (let i = 0; i < 1500; i++)
    f.insert('projectHostedCheckRuns', {
      projectId: f.projectId,
      runId: randomUUID(),
      candidateId: randomUUID(),
      machineId: randomUUID(),
      status: 'passed',
      value: '{}',
    });
  const before = f.counts.length,
    start = performance.now();
  const queue = JSON.parse(await f.call('idleWork', worker.work, f.address));
  assert.deepEqual(queue, []);
  const startup = f.counts.slice(before);
  assert.equal(startup.length, 1);
  assert(startup[0].documents <= 6);
  assert.equal(startup[0].writes, 0);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stop = new AbortController();
  let calls = 0;
  const running = runHostedMacWorker(
    {
      sessionId: f.address.sessionId,
      key: secret,
      work: update => {
        update(queue);
        return () => {};
      },
      watch: () => {
        calls++;
        return () => {};
      },
      control: async () => {
        calls++;
        throw new Error('unexpected idle control');
      },
      heartbeat: async () => {
        calls++;
        throw new Error('unexpected idle heartbeat');
      },
      execute: async () => {
        calls++;
      },
      close: async () => {},
    },
    stop.signal,
  );
  t.mock.timers.tick(86400000);
  await Promise.resolve();
  assert.equal(calls, 0);
  assert.equal(f.counts.length - before, 1, 'only the initial work subscription query');
  stop.abort();
  await running;
  t.diagnostic(
    `1500 retained runs: initial work query ${startup[0].documents} document reads, 0 writes; idle 24h: 0 calls/reads/writes; fixture wall ${Math.round(performance.now() - start)}ms; process maxRSS ${process.resourceUsage().maxRSS} KiB`,
  );
});

for (const provider of ['mac', 'self-hosted'])
  test(`${provider} cancellation stops at its next existing 20-second heartbeat even without a watch update`, async t => {
    const f = await fixture(t, false, provider),
      queued = await f.enqueue();
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    let started,
      stopped = false,
      heartbeats = 0;
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
        heartbeat: async (callback, signature) => {
          heartbeats++;
          return JSON.parse(
            await f.call('cancelHeartbeat', worker.heartbeat, {
              projectId: f.projectId,
              callback: JSON.stringify(callback),
              signature,
            }),
          );
        },
        execute: async (_, signal) => {
          started();
          await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
          stopped = true;
        },
        close: async () => {},
      },
      stop.signal,
    );
    await ready;
    await f.cancel(queued.id);
    t.mock.timers.tick(19_999);
    await immediate();
    assert.equal(stopped, false);
    t.mock.timers.tick(1);
    await immediate();
    assert.equal(stopped, true);
    assert.equal(heartbeats, 1);
    t.mock.timers.tick(60_000);
    await immediate();
    assert.equal(heartbeats, 1);
    stop.abort();
    await running;
  });
