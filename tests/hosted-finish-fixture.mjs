// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { composeFixture, jobApi as composeJobs } from './hosted-compose-fixture.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';
import { driver as landingDriver, control as landingControl } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
import { digest } from '../dist/hash.js';
export const driver = await import(moduleUrl('../convex/projectHostedFinishDriver.ts'));
export const api = await import(moduleUrl('../convex/projectHostedFinish.ts'));
export const control = await import(moduleUrl('../convex/projectHostedFinishControl.ts'));
export const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
export const landingApi = await import(moduleUrl('../convex/projectHostedLanding.ts'));
const sourceJobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
const schema = (await import(moduleUrl('../convex/schema.ts'))).default;
export const maxima = {};
export const code = value => error => (error.data?.code ?? error.code) === value;
export async function compose(c, selection) {
  await c.prepare(selection);
  await c.stage(selection);
  await c.submit(selection);
  return (await c.publish(await c.work(selection))).outcome.result;
}
export async function finishFixture(t, { overlap = false, inputCount = 1 } = {}) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const c = await composeFixture();
  const selectedState = c.state(
    [overlap ? c.file('a.txt', 'ours\nb\nc\n') : c.baseFile, c.hidden, c.file('selected.txt', 'selected\n')],
    [c.baseline.sha256],
  );
  const lane = await c.lane(selectedState),
    lanes = [lane];
  for (let i = 1; i < inputCount; i++) lanes.push(await c.lane(c.baseline));
  const selection = c.selection(lanes);
  const candidate = await compose(c, selection);
  const f = await acceptanceFixture({
    store: c,
    projectId: c.projectId,
    candidate,
    state: { sha256: candidate.result.head, size: c.objects.get(candidate.result.head).length },
  });
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('trusted') });
  const blobs = new Map(),
    metrics = { transfers: 0, downloadBytes: 0, uploadBytes: 0, sourceJobs: 0, ticks: 0, stepCalls: [] };
  f.decorateContext(ctx => {
    ctx.db.system = { get: ctx.db.get };
    ctx.storage = {
      getMetadata: async id => blobs.get(id)?.metadata ?? null,
      getUrl: async id => `https://metadata.invalid/${id}`,
    };
    ctx.scheduler = {
      runAfter: async (delay, ref, args) =>
        ctx.db.insert('_scheduled_functions', {
          name: getFunctionName(ref),
          args: [args],
          scheduledTime: now + delay,
          state: { kind: 'pending' },
        }),
      cancel: async id => {
        const old = await ctx.db.get(id);
        if (old && !['success', 'failed'].includes(old.state.kind))
          await ctx.db.patch(id, { state: { kind: 'canceled' } });
      },
    };
  });
  const tx = async (name, fn, args, actor = 'owner') => {
    try {
      return await f.transaction(name, fn, args, actor);
    } finally {
      for (const count of f.counts.filter(r => r.name === name)) {
        assert(count.ranges <= 1600 && count.documents <= 1600, `${name}: bounded reads`);
        assert(count.readBytes < 2 * 1024 * 1024 && count.writeBytes < 512 * 1024, `${name}: metadata bytes`);
        assert(
          !count.touched.some(k =>
            [
              'projectWorkRecords',
              'projectWorkGenerations',
              'projectWorkEvents',
              'projectBackups',
              'projectHostedCheckShards',
            ].includes(k),
          ),
          `${name}: no Work/history/shard hydration`,
        );
        if (name === 'finishStep')
          assert(count.ranges <= 120 && count.documents <= 120, 'constant-size finish control');
        const max = (maxima[name] ??= { ranges: 0, documents: 0, readBytes: 0, writes: 0, writeBytes: 0 });
        for (const key of Object.keys(max)) max[key] = Math.max(max[key], count[key]);
      }
      for (const row of f.tables.projectHostedFinishes.values()) {
        const fields = schema.tables.projectHostedFinishes.export().documentType.value;
        assert(Object.keys(row).every(k => ['_id', '_creationTime'].includes(k) || k in fields));
        for (const [key, field] of Object.entries(fields)) assert(field.optional || key in row, key);
      }
    }
  };
  const request = overrides =>
    f.request({
      candidateId: candidate.id,
      expectedHead: candidate.result.head,
      check: {
        kind: 'request',
        checkId: f.rawChecks.checkId,
        expectedDefinition: f.rawChecks.definition.digest,
        expectedConfiguration: f.rawChecks.configuration.digest,
        expectedEnvironment: f.rawChecks.runner.environmentFingerprint,
      },
      finish: { composeOperationId: selection.request.operationId, after: null },
      ...overrides,
    });
  const enqueue = r =>
    tx('finishEnqueue', landingApi.enqueue, { projectId: f.projectId, request: JSON.stringify(r) }).then(
      JSON.parse,
    );
  const current = id =>
    tx('finishStatus', api.status, { projectId: f.projectId, submissionId: id }).then(JSON.parse);
  const row = id => [...f.tables.projectHostedFinishes.values()].find(x => x.submissionId === id);
  const pending = () =>
    [...f.tables._scheduled_functions.values()]
      .filter(x => x.state.kind === 'pending')
      .sort((a, b) => a.scheduledTime - b.scheduledTime);
  const execute = async (task = pending()[0], stop = null) => {
    assert(task, 'pending task');
    now = Math.max(now, task.scheduledTime);
    f.patch('_scheduled_functions', task._id, { state: { kind: 'inProgress' } });
    const input = task.args[0];
    metrics.ticks++;
    try {
      if (task.name === 'projectHostedFinishDriver:drive') {
        if (stop === 'before-step') return null;
        const calls = [];
        metrics.stepCalls.push(calls);
        await driver.drive._handler(
          {
            runMutation: async (ref, args) => {
              const name = getFunctionName(ref);
              calls.push(name);
              if (name.endsWith(':step')) {
                const result = await tx('finishStep', driver.step, args);
                if (stop === 'after-step') {
                  const e = new Error('synthetic crash after durable step');
                  e.command = result;
                  throw e;
                }
                return result;
              }
              if (stop === 'before-resume') throw new Error('synthetic crash after IO');
              return tx('finishResume', driver.resume, args);
            },
            storage: {
              store: async blob => {
                const bytes = Buffer.from(await blob.arrayBuffer()),
                  sha256 = digest(bytes),
                  id = `blob-${randomUUID()}`;
                blobs.set(id, { metadata: { sha256, size: bytes.length } });
                c.objects.set(sha256, bytes);
                metrics.uploadBytes += bytes.length;
                return id;
              },
            },
          },
          input,
        );
      } else if (task.name === 'projectHostedLandingDriver:drive') {
        const claim = await tx('finishLandingClaim', landingDriver.claim, input);
        if (claim) await tx('finishLandingAdvance', landingDriver.advance, claim);
      } else if (task.name === 'projectHostedLandingDriver:checkWake') {
        await tx('finishCheckWake', landingDriver.checkWake, input);
      } else if (task.name === 'projectHostedFinishDriver:dependents') {
        await tx('finishDependents', driver.dependents, input);
      } else if (task.name === 'projectHostedAcceptance:complete') {
        await f.materialize(input.receiptId);
      } else if (task.name === 'projectModalSource:dispatch') {
        if (stop === 'before-source') throw new Error('synthetic crash before source job');
        metrics.sourceJobs++;
        const sourceRow = [...f.tables.projectHostedComposes.values()].find(r => r.jobId === input.jobId);
        const source = JSON.parse(sourceRow.value),
          x = { request: source.request };
        const output = await c.work(x);
        if (stop === 'after-source-callback') throw new Error('synthetic crash after source callback');
        await tx('finishSourcePublish', composeJobs.publish, {
          projectId: f.projectId,
          jobId: output.jobId,
          result: output.manifest,
        });
        if (stop === 'after-source-publish') throw new Error('synthetic crash after source publication');
      } else if (task.name === 'projectHostedComposeJobs:complete') {
        const job = await tx(
          'finishLoadJob',
          { _handler: ctx => sourceJobs.loadSourceJob(ctx, f.projectId, input.jobId) },
          {},
        );
        await tx('finishSourcePublish', composeJobs.publish, {
          projectId: f.projectId,
          jobId: input.jobId,
          result: c.objects.get(job.output.sha256).toString(),
        });
      } else assert.fail(`Unexpected task ${task.name}`);
      f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
    } catch (error) {
      f.patch('_scheduled_functions', task._id, { state: { kind: 'failed' } });
      throw error;
    }
  };
  const drain = async () => {
    let steps = 0;
    while (pending().length) {
      assert(++steps <= 100, 'no idle poller or busy loop');
      await execute();
    }
    return steps;
  };
  const passChecks = async () => {
    for (const row of [...f.tables.projectHostedCheckRuns.values()]) {
      const run = JSON.parse(row.value);
      if (run.status === 'queued') await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    }
  };
  const moveMain = ({ overlap = false, sameHead = false } = {}) => {
    const old = f.currentMain(),
      state = sameHead
        ? { sha256: old.head }
        : c.state(
            [
              overlap ? c.file('a.txt', 'theirs\nb\nc\n') : c.baseFile,
              c.hidden,
              c.file('accepted.txt', 'already accepted\n'),
            ],
            [old.head],
          );
    if (!sameHead) c.register(state);
    f.patch('projectHostedChannels', f.mainId, {
      selection: JSON.stringify({
        ...old,
        head: state.sha256,
        receipt: { ...old.receipt, id: randomUUID() },
      }),
    });
    return f.currentMain();
  };
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async url => {
    const hash = new URL(url).pathname.split('/').at(-1),
      bytes = c.objects.get(hash);
    assert(bytes, 'metadata request only targets a synthetic committed object');
    metrics.transfers++;
    metrics.downloadBytes += bytes.length;
    return new Response(bytes);
  });
  t.after(() => {
    assert.notEqual(globalThis.fetch, originalFetch);
  });
  return {
    ...f,
    c,
    tx,
    candidate,
    lane,
    selection,
    request,
    enqueue,
    current,
    row,
    pending,
    execute,
    drain,
    passChecks,
    moveMain,
    metrics,
    advanceClock: ms => {
      now += ms;
    },
  };
}
