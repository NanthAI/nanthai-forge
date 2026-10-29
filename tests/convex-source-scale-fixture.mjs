// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { getFunctionName, makeFunctionReference } from 'convex/server';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { sourceWorkerPlan } from '../dist/convex-source-provider.js';
import { hostedPayloadHash } from '../dist/hosted-source-operation.js';
import { saveBytes } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';
const names = [
  'projectConvexSourceStore',
  'projectConvexSourceObjects',
  'projectConvexSourceFanout',
  'projectSourceJobs',
];
const modules = Object.fromEntries(
  await Promise.all(names.map(async n => [n, await import(moduleUrl(`../convex/${n}.ts`))])),
);
const actionUrls = Object.fromEntries(
  ['projectConvexSource', 'projectConvexSourceTask'].map(n => [n, moduleUrl(`../convex/${n}.ts`)]),
);
export const at = '2026-10-28T00:00:00.000Z';
export async function scaleFixture({ parallelism = 4, delay = 0, guardRss = false, afterAction } = {}) {
  const f = recordsFixture(),
    { projectId } = await f.setup(),
    objects = new Map(),
    blobs = new Map(),
    scheduled = new Map(),
    ready = [],
    metrics = [],
    calls = [],
    failOnce = [];
  await f.ctx.db.patch(projectId, { sourceAuthority: { mode: 'server', epoch: 1 } });
  const config = {
    FORGE_SOURCE_PARALLELISM: String(parallelism),
    FORGE_BLOBS: 'r2',
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
  };
  const before = Object.fromEntries(Object.keys(config).map(k => [k, process.env[k]]));
  Object.assign(process.env, config);
  let serial = 0,
    storageCalls = 0,
    readObjects = 0,
    readBytes = 0,
    chain = Promise.resolve(),
    active = 0,
    peakActive = 0,
    work = 0,
    peakWork = 0;
  const ctx = f.ctx;
  ctx.storage = {
    getMetadata: async id => {
      const b = blobs.get(id);
      return b ? { size: b.length, sha256: digest(b) } : null;
    },
  };
  ctx.scheduler = {
    runAfter: async (_delay, ref, args) => {
      const id = `scheduled-${++serial}`,
        item = { id, name: getFunctionName(ref), args, state: { kind: 'pending' } };
      scheduled.set(id, item);
      ready.push(item);
      return id;
    },
    cancel: async id => {
      scheduled.get(id).state = { kind: 'canceled' };
    },
  };
  ctx.db.system = { get: async id => scheduled.get(id) ?? null };
  const invoke = (name, args) => {
    const result = chain.then(() => {
      calls.push(name);
      const [n, m] = name.split(':');
      // Real Convex rejects fields the args validator does not name.
      const spec = JSON.parse(modules[n][m].exportArgs());
      if (spec.type === 'object')
        for (const key of Object.keys(args ?? {})) assert(key in spec.value, `${name}: extra field ${key}`);
      return f.call(name, modules[n][m], args);
    });
    chain = result.catch(() => {});
    return result;
  };
  async function putSpec(spec, pin) {
    if (!pin) {
      const b = Buffer.isBuffer(spec) ? spec : generated(spec);
      pin = { sha256: digest(b), size: b.length };
    }
    if (!objects.has(pin.sha256)) {
      objects.set(pin.sha256, spec);
      await ctx.db.insert('projectObjects', {
        projectId,
        digest: pin.sha256,
        size: pin.size,
        removed: false,
        nonce: 'synthetic',
        location: 'r2',
        r2Committed: true,
        r2Key: `v1/p/${projectId}/o/${pin.sha256}`,
      });
    }
    return pin;
  }
  function generated(spec) {
    const b = Buffer.alloc(spec.size, spec.fill ?? 65);
    if (spec.index !== undefined) b.writeBigUInt64LE(BigInt(spec.index));
    return b;
  }
  const json = value => putSpec(Buffer.from(saveBytes(value)));
  const bytes = async pin => {
    const spec = objects.get(pin.sha256);
    return Buffer.isBuffer(spec) ? spec : generated(spec);
  };
  async function enqueue(input) {
    const jobId = randomUUID(),
      operationId = randomUUID(),
      expected = { authorityEpoch: 1, head: input.sha256, receiptId: 'synthetic' };
    const payload = { jobKind: 'register-state', input, inputDigest: input.sha256, ...sourceWorkerPlan({}) };
    await f.run('enqueue-scale-worker', () =>
      modules.projectSourceJobs.enqueueSourceJob(ctx, {
        projectId,
        actor: 'owner',
        request: {
          schema: 1,
          projectId,
          actor: 'owner',
          operationId,
          expected,
          payloadHash: hostedPayloadHash(payload, expected),
        },
        payload,
        firstAttempt: {
          projectId,
          operationId,
          id: randomUUID(),
          parentAttemptId: null,
          at,
          expected,
          ids: { job: jobId },
        },
      }),
    );
    await ctx.scheduler.runAfter(0, makeFunctionReference('projectConvexSource:dispatch'), {
      projectId,
      jobId,
    });
    return jobId;
  }
  // Like Convex: a scheduled function that throws is marked failed and is
  // never retried by the scheduler itself.
  async function execute(item) {
    item.state = { kind: 'inProgress' };
    try {
      const fail = failOnce.findIndex(match => match(item));
      if (fail >= 0 && failOnce.splice(fail, 1))
        throw Object.assign(Error('synthetic platform failure'), { synthetic: true });
      await run(item);
      item.state = { kind: 'success' };
    } catch (error) {
      item.state = { kind: 'failed', error: error.message };
      throw error;
    } finally {
      await afterAction?.(item);
    }
  }
  async function run(item) {
    const [n, m] = item.name.split(':');
    if (!actionUrls[n]) {
      await invoke(item.name, item.args);
      return;
    }
    calls.push(item.name);
    active++;
    peakActive = Math.max(peakActive, active);
    const child = fork(new URL('./convex-source-scale-child.mjs', import.meta.url), [], {
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', b => (stderr += b));
    try {
      await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', code => {
          if (code) reject(Error(`child exit ${code}: ${stderr}`));
        });
        child.on('message', async message => {
          if (message.done) {
            if (message.error) reject(Object.assign(Error(message.error.message), message.error));
            else {
              metrics.push({ ...message.metrics, name: item.name });
              resolve();
            }
            return;
          }
          try {
            let value;
            const a = message.args;
            if (message.kind === 'mutation') {
              if (a.name === 'projectConvexSourceFanout:complete') {
                work--;
              }
              value = await invoke(a.name, a.args);
              if (a.name === 'projectConvexSourceFanout:begin' && value) {
                work++;
                peakWork = Math.max(peakWork, work);
                assert(work <= parallelism);
              }
            } else if (message.kind === 'fetch') {
              const id = new URL(a.url).pathname.split('/o/')[1]?.split('/')[0],
                spec = objects.get(id);
              assert(spec, `source ${id}`);
              readObjects++;
              readBytes += Buffer.isBuffer(spec) ? spec.length : spec.size;
              value = Buffer.isBuffer(spec) ? spec : { ...spec, delay };
            } else if (message.kind === 'get') {
              storageCalls++;
              value = blobs.get(a.id) ?? null;
            } else if (message.kind === 'store') {
              storageCalls++;
              value = `blob-${digest(a.bytes)}`;
              blobs.set(value, a.bytes);
              objects.set(digest(a.bytes), a.bytes);
            }
            child.send({ reply: message.id, value });
          } catch (error) {
            child.send({ reply: message.id, error: { message: error.message, code: error.code } });
          }
        });
        child.send({ run: true, url: actionUrls[n], method: m, args: item.args, guardRss });
      });
    } finally {
      child.kill();
      active--;
    }
  }
  async function drain({ idle = true } = {}) {
    const started = performance.now(),
      running = new Set(),
      countsStart = f.counts.length,
      metricsStart = metrics.length,
      callsStart = calls.length,
      storageStart = storageCalls,
      readsStart = readObjects,
      bytesStart = readBytes;
    while (ready.length || running.size) {
      while (ready.length) {
        const item = ready.shift();
        if (item.state.kind === 'canceled') continue;
        let promise;
        promise = execute(item)
          .catch(error => {
            if (!error.synthetic) throw error;
          })
          .finally(() => running.delete(promise));
        running.add(promise);
      }
      if (running.size) await Promise.race(running);
    }
    await chain;
    const jobMetrics = metrics.slice(metricsStart);
    assert(
      jobMetrics.every(m => m.maxRssBytes < 400 * 1024 * 1024 && m.elapsedMs < 60000),
      JSON.stringify(metrics),
    );
    if (idle)
      assert.equal(
        (
          await ctx.db
            .query('projectSourcePools')
            .withIndex('by_key', q => q.eq('key', 'source'))
            .unique()
        )?.active.length ?? 0,
        0,
      );
    const callCount = calls.length - callsStart + storageCalls - storageStart;
    return {
      wallMs: performance.now() - started,
      steps: jobMetrics.length,
      maxStepMs: Math.max(...jobMetrics.map(m => m.elapsedMs)),
      maxRssBytes: Math.max(...jobMetrics.map(m => m.maxRssBytes)),
      actionMs: jobMetrics.reduce((n, m) => n + m.elapsedMs, 0),
      peakActive,
      peakWork,
      documentsRead: f.counts.slice(countsStart).reduce((n, c) => n + c.documents, 0),
      documentsWritten: f.counts.slice(countsStart).reduce((n, c) => n + c.writes, 0),
      calls: callCount,
      functionCalls: calls.length - callsStart,
      storageCalls: storageCalls - storageStart,
      readObjects: readObjects - readsStart,
      readBytes: readBytes - bytesStart,
    };
  }
  const job = jobId =>
    f.run('load-scale-job', () => modules.projectSourceJobs.loadSourceJob(ctx, projectId, jobId));
  return {
    ...f,
    projectId,
    objects,
    blobs,
    ready,
    scheduled,
    calls,
    metrics,
    failOnce,
    putSpec,
    json,
    bytes,
    enqueue,
    drain,
    execute,
    invoke,
    job,
    restore() {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}
