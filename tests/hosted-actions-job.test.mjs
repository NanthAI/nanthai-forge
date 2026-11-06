// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  hostedActionsCapabilities,
  actionsPreflightCapability,
  actionsInlineLogCapability,
  actionsJobCalls,
} from '../dist/hosted-actions-capabilities.js';
import { z } from 'zod';
import { ConvexHttpClient } from 'convex/browser';
import { ActionsJobClient } from '../dist/hosted-actions-job-client.js';
import {
  materializeActionsSource,
  verifySourceTree,
  actionsFileConcurrency,
} from '../dist/hosted-actions-job-source.js';
import { prepareActionsJob } from '../dist/hosted-actions-job-plan.js';
import { executeActionsJob } from '../dist/hosted-actions-job-run.js';
import { savePin } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';
import { hostedActionsRuntime } from '../dist/hosted-actions.js';
import { createSourcePack } from '../dist/source-pack-archive.js';
import { refreshSourcePack, sourcePackFileBytes } from '../dist/source-pack.js';
import { gzipSync, gunzipSync } from 'node:zlib';
import { truncateSync } from 'node:fs';
import { partitionTests, timedShards, shardDuration, checkCallBudget } from '../scripts/test-shards.mjs';
import { poolUnits, keptFiles } from '../scripts/shard-pool.mjs';
function fixture(
  t,
  {
    sourceDelay = 0,
    downloadDelay = 0,
    timingHistory = { version: 1, files: {}, runs: [] },
    capabilities = hostedActionsCapabilities,
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-direct-job-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const objects = new Map(),
    recipes = new Map();
  const put = text => {
    const bytes = Buffer.from(text),
      pin = { sha256: digest(bytes), size: bytes.length };
    objects.set(pin.sha256, bytes);
    return pin;
  };
  const entry = (path, text, mode = 'file') => ({ path, blob: put(text).sha256, mode });
  const files = [
    entry('package-lock.json', '{}'),
    entry('scripts/example.sh', '#!/bin/sh\nexit 0\n', 'executable'),
    entry('test-link', 'package-lock.json', 'symlink'),
    entry('README.md', 'synthetic before'),
  ];
  const state = entries =>
    put(
      JSON.stringify({
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files: entries,
        at: '2026-01-01T00:00:00.000Z',
        message: 'synthetic',
      }),
    );
  const base = state(files),
    candidate = state(
      files.map(file => (file.path === 'README.md' ? entry(file.path, 'synthetic after') : file)),
    );
  const run = {
    id: randomUUID(),
    projectId: 'synthetic-project',
    request: { expectedHead: candidate.sha256, expectedEnvironment: 'b'.repeat(64) },
    candidate: { base: { head: base.sha256 } },
    check: { executable: 'node', args: ['scripts/forge-check.mjs'], definition: 'c'.repeat(64) },
    configuration: { provider: 'github-actions', runtime: hostedActionsRuntime },
    fence: 1,
    executionId: '123',
  };
  const session = { sourcePack: null, unsupported: false };
  const calls = [],
    traffic = { active: 0, peak: 0, downloads: 0, oidc: 0, claims: [] },
    claimStore = { units: new Map(), failing: false };
  const oldUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL,
    oldToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://oidc.invalid/token';
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = 'synthetic-request-token';
  t.after(() => {
    for (const [key, value] of [
      ['ACTIONS_ID_TOKEN_REQUEST_URL', oldUrl],
      ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', oldToken],
    ])
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  const client = new ActionsJobClient('https://convex.invalid', run.projectId, run.id, async (url, init) => {
    if (String(url).startsWith('https://oidc.invalid/')) {
      traffic.oidc++;
      return Response.json({
        value: `header.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 300 })).toString('base64url')}.signature`,
      });
    }
    if (String(url).startsWith('https://output.invalid/')) return fetch(url, init);
    // Synthetic create-only claim store (R2 If-None-Match: * semantics).
    if (String(url).startsWith('https://claims.invalid/')) {
      const unit = Number(String(url).split('/').at(-1));
      traffic.claims.push({ method: init?.method, unit });
      if (claimStore.failing) return new Response(null, { status: 503 });
      if (init?.method === 'HEAD')
        return new Response(null, { status: claimStore.units.has(unit) ? 200 : 404 });
      assert.equal(init?.method, 'PUT');
      assert.equal(init.headers['if-none-match'], '*');
      if (claimStore.units.has(unit)) return new Response(null, { status: 412 });
      claimStore.units.set(unit, Buffer.from(init.body).toString());
      return new Response(null, { status: 200 });
    }
    if (String(url).startsWith('https://objects.invalid/') && init?.method === 'PUT') {
      const parts = [];
      for await (const chunk of init.body) parts.push(chunk);
      const bytes = Buffer.concat(parts),
        hash = String(url).split('/').at(-1);
      assert.equal(digest(bytes), hash);
      objects.set(hash, bytes);
      return new Response(null, { status: 200 });
    }
    if (String(url).startsWith('https://objects.invalid/')) {
      traffic.active++;
      traffic.peak = Math.max(traffic.peak, traffic.active);
      traffic.downloads++;
      if (downloadDelay) await new Promise(resolve => setTimeout(resolve, downloadDelay));
      traffic.active--;
      return new Response(objects.get(String(url).split('/').at(-1)));
    }
    if (url === 'https://convex.invalid/api/query') {
      assert(capabilities?.includes(actionsPreflightCapability), 'old servers receive no new query');
      const body = JSON.parse(init.body);
      assert.equal(body.path, 'projectHostedActionsPreflight:check');
      assert.deepEqual(body.args, [
        {
          projectId: run.projectId,
          runId: run.id,
          fence: run.fence,
          signature: 'a'.repeat(64),
        },
      ]);
      calls.push({ kind: 'preflight' });
      return Response.json({
        status: 'success',
        value: { status: run.cancelRequested ? 'cancelled' : 'active' },
      });
    }
    assert.equal(url, 'https://convex.invalid/checks/actions');
    const body = JSON.parse(init.body),
      command = body.command;
    calls.push(command);
    if (capabilities === null) {
      // A pre-extension server rejects new wire shapes.
      if (command.kind === 'session')
        z.object({ kind: z.literal('session') })
          .strict()
          .parse(command);
      if (command.kind === 'result')
        z.object({
          index: z.number(),
          exitCode: z.number(),
          log: z.unknown().optional(),
          contractReports: z.unknown().optional(),
        })
          .strict()
          .parse(command.result);
      assert.notEqual(command.kind, 'sourcePack', 'old servers must never receive pack commands');
    }
    if (command.kind === 'session')
      return Response.json(
        command.timings
          ? {
              run,
              timingHistory: JSON.stringify(timingHistory),
              ...(session.sourcePack ? { sourcePack: session.sourcePack } : {}),
              ...(capabilities ? { capabilities } : {}),
            }
          : { ...run, ...(capabilities ? { capabilities } : {}) },
        {
          headers: {
            'X-Forge-Actions-Preflight': JSON.stringify({
              endpoint: 'https://convex.invalid',
              signature: 'a'.repeat(64),
            }),
          },
        },
      );
    if (command.kind === 'output') return Response.json({ url: 'https://output.invalid/log', headers: {} });
    if (command.kind === 'result') {
      run.status = command.result.exitCode === 0 ? 'passed' : 'failed';
      return Response.json(run);
    }
    if (command.kind === 'source') {
      if (sourceDelay) await new Promise(resolve => setTimeout(resolve, sourceDelay));
      return Response.json(
        command.digests.map(sha256 => ({
          descriptor: {
            object: { sha256, size: objects.get(sha256).length },
            recipe: recipes.get(sha256) ?? null,
          },
          url: recipes.has(sha256) ? null : `https://objects.invalid/${sha256}`,
        })),
      );
    }
    if (command.kind === 'sourcePack') {
      if (session.unsupported) return new Response(null, { status: 403 });
      if (command.phase === 'prepare')
        return Response.json({ url: `https://objects.invalid/${command.object.sha256}`, headers: {} });
      assert.equal(objects.get(command.object.sha256).length, command.object.size);
      return Response.json(null);
    }
    if (command.kind === 'plan') {
      run.plan = {
        head: run.request.expectedHead,
        manifest: savePin(command.plan.recipe),
        selection: savePin(command.plan.recipe.selection),
        shardCount: command.plan.recipe.groups.length + 1,
      };
      const { pool, groups } = command.plan.recipe;
      return Response.json(
        pool
          ? {
              run,
              claims: poolUnits(groups, pool).map(({ unit }) => ({
                put: { url: `https://claims.invalid/${unit}`, headers: { 'if-none-match': '*' } },
                head: `https://claims.invalid/${unit}`,
              })),
            }
          : run,
      );
    }
    throw new Error(`Unexpected synthetic command ${command.kind}`);
  });
  return {
    directory,
    objects,
    recipes,
    put,
    entry,
    state,
    files,
    run,
    calls,
    client,
    traffic,
    session,
    claimStore,
  };
}

test('6000-file download measurement keeps source calls within the existing page budget', async t => {
  // Warm the planner and filesystem path before measuring; no tight timing assertions.
  const warm = fixture(t);
  await prepareActionsJob(warm.client, join(warm.directory, 'candidate'), join(warm.directory, 'cache'));
  const s = fixture(t, { sourceDelay: 10, downloadDelay: 1 });
  const files = Array.from({ length: 6000 }, (_, i) =>
    s.entry(`source/file-${String(i).padStart(4, '0')}.txt`, `synthetic-${i}`),
  );
  s.run.request.expectedHead = s.state(files).sha256;
  s.run.check = { executable: 'true', args: [], definition: 'c'.repeat(64) };
  const started = performance.now();
  const prepared = await prepareActionsJob(
    s.client,
    join(s.directory, 'candidate'),
    join(s.directory, 'cache'),
  );
  assert.equal(prepared.singleShard, 'static');
  assert.deepEqual(prepared.matrix, []);
  const planPath = join(s.directory, 'plan.json');
  writeFileSync(planPath, JSON.stringify(prepared.recipe));
  assert.equal(s.calls.filter(call => call.kind === 'result').length, 0);
  assert.equal(
    await executeActionsJob(s.client, join(s.directory, 'candidate'), planPath, prepared.singleShard),
    0,
  );
  // Same metadata budget as a separate execution; placement adds no function calls.
  assert.equal(s.calls.length, 21);
  assert.equal(s.calls.filter(call => call.kind === 'preflight').length, 1);
  assert.equal(s.calls.filter(call => call.kind === 'result').length, 1);
  const sourceCalls = s.calls.filter(call => call.kind === 'source');
  assert.equal(sourceCalls.length, 16); // One manifest window and fifteen file windows.
  assert(sourceCalls.every(call => call.digests.length <= 400));
  assert.equal(s.traffic.downloads, 6002);
  // Three page workers, each with up to 16 concurrent object reads (actionsReadConcurrency).
  assert(s.traffic.peak > 3 && s.traffic.peak <= 3 * 16);
  assert.equal(readFileSync(join(s.directory, 'candidate/source/file-5999.txt'), 'utf8'), 'synthetic-5999');
  t.diagnostic(
    JSON.stringify({
      files: 6000,
      elapsedMs: performance.now() - started,
      sourceCalls: sourceCalls.length,
      peakDownloads: s.traffic.peak,
      rssBytes: process.memoryUsage().rss,
    }),
  );
});

test('pages may complete out of order, but links are created only after every regular file', async t => {
  const s = fixture(t),
    candidate = join(s.directory, 'candidate');
  const files = [
    s.entry('link', 'source/file-1199.txt', 'symlink'),
    ...Array.from({ length: 1200 }, (_, i) => s.entry(`source/file-${i}.txt`, `bytes-${i}`)),
  ];
  s.run.request.expectedHead = s.state(files).sha256;
  // Source download is under test, not selection: an opaque command has no test selection.
  s.run.check = { executable: 'true', args: [], definition: 'c'.repeat(64) };
  const original = s.client.transport.bind(s.client);
  let release,
    ahead = false;
  const blocked = new Promise(resolve => {
    release = resolve;
  });
  s.client.transport = () => {
    const transport = original();
    const read = transport.transport.read;
    transport.transport.read = async pin => {
      if (pin.sha256 === files[0].blob) await blocked;
      if (pin.sha256 === files[1199].blob) {
        assert.equal(existsSync(join(candidate, 'link')), false);
        ahead = true;
        release();
      }
      return read(pin);
    };
    return transport;
  };
  await prepareActionsJob(s.client, candidate, join(s.directory, 'objects'));
  assert(ahead);
  assert(lstatSync(join(candidate, 'link')).isSymbolicLink());
  assert.equal(readFileSync(join(candidate, 'link'), 'utf8'), 'bytes-1199');
});

test('a failed page drains in-flight pages and never publishes a plan or creates links', async t => {
  const s = fixture(t),
    candidate = join(s.directory, 'candidate');
  const files = [
    s.entry('link', 'source/file-0.txt', 'symlink'),
    ...Array.from({ length: 1600 }, (_, i) => s.entry(`source/file-${i}.txt`, `bytes-${i}`)),
  ];
  s.run.request.expectedHead = s.state(files).sha256;
  const original = s.client.transport.bind(s.client);
  let active = 0,
    peak = 0,
    pages = 0;
  s.client.transport = () => {
    const transport = original(),
      resolve = transport.resolve;
    transport.resolve = async hashes => {
      if (hashes.length < 100) return resolve(hashes);
      pages++;
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise(done => setImmediate(done));
        if (hashes.includes(files[400].blob)) throw new Error('synthetic page failure');
        await resolve(hashes);
      } finally {
        active--;
      }
    };
    return transport;
  };
  await assert.rejects(
    prepareActionsJob(s.client, candidate, join(s.directory, 'objects')),
    /synthetic page failure/,
  );
  assert.equal(active, 0);
  assert.equal(peak, 3);
  assert.equal(pages, 3);
  assert.equal(existsSync(join(candidate, 'link')), false);
  assert.equal(
    s.calls.some(command => command.kind === 'plan'),
    false,
  );
});

test('queue pressure changes pinned shard groups without new Convex calls or lost tests', async t => {
  const tests = Array.from({ length: 80 }, (_, i) => `tests/capacity-${i}.test.mjs`);
  const s = fixture(t, {
    timingHistory: {
      version: 1,
      runs: [],
      files: Object.fromEntries(tests.map(file => [file, { durationMs: 45000, updatedAt: '2026-01-01' }])),
    },
  });
  s.run.request.expectedHead = s.state([
    s.entry('package-lock.json', '{}'),
    ...tests.map(file => s.entry(file, '// synthetic')),
  ]).sha256;
  const prepared = await prepareActionsJob(
    s.client,
    join(s.directory, 'candidate'),
    join(s.directory, 'cache'),
    { activeChecks: 15, jobCap: 20 },
  );
  assert.equal(prepared.recipe.groups.length, 2);
  assert.deepEqual(prepared.recipe.groups.flat().sort(), tests.sort());
  assert.equal(prepared.matrix.length, 3);
  assert.equal(prepared.singleShard, '');
  assert.equal(s.calls.filter(call => call.kind === 'session').length, 2);
  assert.equal(s.calls.filter(call => call.kind === 'plan').length, 1);
  assert.equal(s.calls.filter(call => call.kind === 'result').length, 0);
});

test('shard count keeps Convex calls per check within the budget for old and inline-log servers', async t => {
  const tests = Array.from({ length: 80 }, (_, i) => `tests/budget-${i}.test.mjs`);
  const timingHistory = {
    version: 1,
    runs: [],
    files: Object.fromEntries(tests.map(file => [file, { durationMs: 45000, updatedAt: '2026-01-01' }])),
  };
  const oldServer = hostedActionsCapabilities.filter(value => value !== actionsInlineLogCapability);
  for (const [capabilities, shards, calls] of [
    [oldServer, 7, 6],
    [hostedActionsCapabilities, 11, 4],
  ]) {
    const s = fixture(t, { timingHistory, capabilities });
    s.run.request.expectedHead = s.state([
      s.entry('package-lock.json', '{}'),
      ...tests.map(file => s.entry(file, '// synthetic')),
    ]).sha256;
    const prepared = await prepareActionsJob(
      s.client,
      join(s.directory, 'candidate'),
      join(s.directory, 'cache'),
    );
    assert.equal(actionsJobCalls(capabilities), calls);
    assert.equal(prepared.recipe.groups.length, shards);
    assert.equal(prepared.matrix.length, shards + 1);
    assert(prepared.matrix.length * calls <= checkCallBudget);
    assert.deepEqual(prepared.recipe.groups.flat().sort(), tests.slice().sort());
  }
});

test('planner consumes session timing history for balanced LPT shards; empty and corrupt history preserve round-robin', async t => {
  const tests = Array.from(
    { length: 80 },
    (_, i) => `tests/synthetic-${String(i).padStart(3, '0')}.test.mjs`,
  );
  const durations = Object.fromEntries(tests.map((file, i) => [file, (80 - i) * 100]));
  for (const filesHistory of [
    {},
    Object.fromEntries(tests.map(file => [file, { durationMs: durations[file], updatedAt: '2026-01-01' }])),
  ]) {
    const s = fixture(t, { timingHistory: { version: 1, files: filesHistory, runs: [] } });
    s.run.request.expectedHead = s.state([
      s.entry('package-lock.json', '{}'),
      ...tests.map(file => s.entry(file, '// synthetic')),
    ]).sha256;
    const prepared = await prepareActionsJob(
      s.client,
      join(s.directory, 'candidate'),
      join(s.directory, 'cache'),
    );
    assert.deepEqual(
      prepared.recipe.groups,
      timedShards(tests, Object.keys(filesHistory).length ? durations : {}, { callsPerJob: 4 }),
    );
    assert.equal(s.calls.filter(call => call.kind === 'session').length, 2);
    if (Object.keys(filesHistory).length) {
      assert.equal(prepared.recipe.groups.length, 2);
      const estimates = prepared.recipe.groups.map(group => shardDuration(group, durations));
      assert(Math.max(...estimates) <= Math.min(...estimates) * 1.2);
      t.diagnostic(
        JSON.stringify({
          countBasedMs: Math.max(...partitionTests(tests, 8).map(group => shardDuration(group, durations))),
          weightedMs: Math.max(...estimates),
          minWeightedMs: Math.min(...estimates),
        }),
      );
    }
  }
  const s = fixture(t, { timingHistory: { version: 99, files: {}, runs: [] } });
  await s.client.session(true);
  assert.deepEqual(s.client.timings, {});
});

test('overlapping descriptor and token refresh requests are coalesced without extra Convex calls', async t => {
  const s = fixture(t, { sourceDelay: 10 });
  const pins = Array.from({ length: 600 }, (_, i) => s.put(`shared-${i}`));
  const { resolve } = s.client.transport();
  await Promise.all([
    resolve(pins.map(pin => pin.sha256)),
    resolve(pins.slice(200, 500).map(pin => pin.sha256)),
    s.client.call({ kind: 'session' }),
  ]);
  const source = s.calls.filter(call => call.kind === 'source');
  assert.equal(source.length, 2);
  assert.equal(source.flatMap(call => call.digests).length, 600);
  assert.equal(s.traffic.oidc, 1);
});

test('a hash mismatch in a concurrent page fails before links and plan publication', async t => {
  const s = fixture(t),
    candidate = join(s.directory, 'candidate');
  const files = [
    s.entry('link', 'file-0.txt', 'symlink'),
    ...Array.from({ length: 800 }, (_, i) => s.entry(`file-${i}.txt`, `bytes-${i}`)),
  ];
  s.run.request.expectedHead = s.state(files).sha256;
  s.objects.set(files[400].blob, Buffer.from('corrupted'));
  await assert.rejects(
    prepareActionsJob(s.client, candidate, join(s.directory, 'cache')),
    error => error.code === 'SOURCE_HASH_MISMATCH',
  );
  assert.equal(existsSync(join(candidate, 'link')), false);
  assert.equal(
    s.calls.some(command => command.kind === 'plan'),
    false,
  );
});

test('a shared descriptor failure drains independent requests and permits a clean retry', async t => {
  const s = fixture(t),
    a = s.put('shared-failure').sha256,
    b = s.put('slow-independent').sha256;
  let rejectShared,
    releaseSlow,
    settled = false;
  const shared = new Promise((_, reject) => {
    rejectShared = reject;
  });
  const slow = new Promise(resolve => {
    releaseSlow = resolve;
  });
  const call = s.client.call.bind(s.client);
  s.client.call = async command => {
    if (command.kind === 'source' && command.digests.includes(a)) await shared;
    if (command.kind === 'source' && command.digests.includes(b)) await slow;
    return call(command);
  };
  const { resolve } = s.client.transport();
  const first = assert.rejects(resolve([a]), /shared failure/);
  const second = assert.rejects(resolve([a, b]), /shared failure/).then(() => {
    settled = true;
  });
  rejectShared(new Error('synthetic shared failure'));
  await first;
  await new Promise(done => setImmediate(done));
  assert.equal(settled, false);
  releaseSlow();
  await second;
  s.client.call = call;
  await resolve([a, b]);
  assert.equal(s.calls.filter(command => command.kind === 'source').length, 2);
});
test('fixed planner materializes verified pinned bytes, modes and links; docs scope needs only static', async t => {
  const s = fixture(t),
    candidate = join(s.directory, 'candidate');
  const prepared = await prepareActionsJob(s.client, candidate, join(s.directory, 'objects'));
  assert.deepEqual(prepared.matrix, []);
  assert.equal(prepared.singleShard, 'static');
  assert.equal(prepared.recipe.selection.scope, 'docs');
  assert.equal(readFileSync(join(candidate, 'README.md'), 'utf8'), 'synthetic after');
  assert(lstatSync(join(candidate, 'test-link')).isSymbolicLink());
  assert(lstatSync(join(candidate, 'scripts/example.sh')).mode & 0o111);
  assert.equal(s.calls.filter(call => call.kind === 'source').length, 2);
  assert.equal(s.run.plan.manifest.sha256, savePin(prepared.recipe).sha256);
});
test('untrusted traversal manifests and altered downloads fail before materialization', async t => {
  const s = fixture(t);
  const malicious = s.state([{ path: '../escape', blob: s.put('bad').sha256, mode: 'file' }]);
  s.run.request.expectedHead = malicious.sha256;
  await assert.rejects(
    prepareActionsJob(s.client, join(s.directory, 'candidate'), join(s.directory, 'objects')),
    /Native|Invalid|validation|input/i,
  );
});
const withoutInlineLog = hostedActionsCapabilities.filter(value => value !== actionsInlineLogCapability);
test('fixed supervisor records actual child exit, strips OIDC env and posts bounded output', async t => {
  const s = fixture(t, { capabilities: withoutInlineLog }),
    candidate = join(s.directory, 'candidate'),
    prepared = await prepareActionsJob(s.client, candidate, join(s.directory, 'objects'));
  const path = join(s.directory, 'plan.json');
  writeFileSync(path, JSON.stringify(prepared.recipe));
  const posted = [];
  let uploaded = null;
  const realCall = s.client.call.bind(s.client);
  s.client.call = async command => {
    if (command.kind === 'output') {
      posted.push(command);
      return { url: 'https://output.invalid/log', headers: {} };
    }
    if (command.kind === 'result') {
      posted.push(command);
      return {};
    }
    return realCall(command);
  };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    uploaded = Buffer.from(init.body);
    return new Response(null, { status: 200 });
  });
  const program = `if(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || process.env.ACTIONS_ID_TOKEN_REQUEST_URL)process.exit(99); console.log('x'.repeat(70000)); console.log('__FORGE_TESTS__'+JSON.stringify({file:'tests/synthetic.test.mjs',complete:true,durationMs:5,results:[{name:'synthetic',passed:false}]})); process.exitCode = 7;`;
  // Avoid sending a huge synthetic line to the test reporter.
  t.mock.method(process.stdout, 'write', () => true);
  const exit = await executeActionsJob(s.client, candidate, path, 'static', [
    process.execPath,
    '--eval',
    program,
  ]);
  assert.equal(exit, 7);
  assert(uploaded.length <= 65536);
  const result = posted.find(command => command.kind === 'result').result;
  assert.equal(result.exitCode, 7);
  assert.equal(result.log.object.sha256, digest(uploaded));
  assert.equal(result.contractReports['tests/synthetic.test.mjs'].failed, true);
});
test('an inline-log server receives the bounded log inside the one result call', async t => {
  const s = fixture(t),
    candidate = join(s.directory, 'candidate'),
    prepared = await prepareActionsJob(s.client, candidate, join(s.directory, 'objects'));
  const path = join(s.directory, 'plan.json');
  writeFileSync(path, JSON.stringify(prepared.recipe));
  const posted = [];
  const realCall = s.client.call.bind(s.client);
  s.client.call = async command => {
    if (command.kind !== 'output' && command.kind !== 'result') return realCall(command);
    posted.push(command);
    return {};
  };
  const uploads = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  t.mock.method(process.stdout, 'write', () => true);
  const program = `console.log('x'.repeat(70000)); console.log('__FORGE_TESTS__'+JSON.stringify({file:'tests/synthetic.test.mjs',complete:true,durationMs:5,results:[{name:'synthetic',passed:false}]})); process.exitCode = 7;`;
  const exit = await executeActionsJob(s.client, candidate, path, 'static', [
    process.execPath,
    '--eval',
    program,
  ]);
  assert.equal(exit, 7);
  assert.deepEqual(
    posted.map(command => command.kind),
    ['result'],
  );
  assert.equal(uploads.mock.callCount(), 0, 'the server stores the log; the runner makes no PUT');
  const [{ result, logBytes }] = posted;
  const bytes = Buffer.from(logBytes, 'base64');
  assert(bytes.length <= 65536);
  assert.deepEqual(result.log.object, { sha256: digest(bytes), size: bytes.length });
  assert.equal(result.exitCode, 7);
  assert.equal(result.contractReports['tests/synthetic.test.mjs'].failed, true);
  assert.equal(actionsJobCalls(hostedActionsCapabilities), 4);
  assert.equal(actionsJobCalls(withoutInlineLog), 6);
});

test('a result too large to carry its log falls back to the separate output upload', async t => {
  const s = fixture(t),
    candidate = join(s.directory, 'candidate'),
    prepared = await prepareActionsJob(s.client, candidate, join(s.directory, 'objects'));
  const path = join(s.directory, 'plan.json');
  writeFileSync(path, JSON.stringify(prepared.recipe));
  const posted = [];
  s.client.call = async command => {
    posted.push(command);
    return command.kind === 'output' ? { url: 'https://output.invalid/log', headers: {} } : {};
  };
  const uploads = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  t.mock.method(process.stdout, 'write', () => true);
  // About 450 KiB of failure excerpts: with the base64 log the request would pass the window.
  const program = `for(let i=0;i<300;i++)console.log('__FORGE_TESTS__'+JSON.stringify({file:'tests/wide-'+i+'.test.mjs',complete:true,durationMs:5,failed:true,firstError:'e'.repeat(1500),results:[{name:'n',passed:false}]}));`;
  assert.equal(
    await executeActionsJob(s.client, candidate, path, 'static', [process.execPath, '--eval', program]),
    0,
  );
  assert.deepEqual(
    posted.map(command => command.kind),
    ['output', 'result'],
  );
  assert.equal('logBytes' in posted[1], false);
  assert.equal(uploads.mock.callCount(), 1);
  assert.equal(Object.keys(posted[1].result.contractReports).length, 300);
});

test('workflow keeps the native plan branch and uses OIDC without GitHub secrets for hosted jobs', () => {
  const workflow = readFileSync(new URL('../.github/workflows/forge-check.yml', import.meta.url), 'utf8');
  assert.match(workflow, /inputs.deployment == '' && inputs.plan != '\[\]'/);
  assert.match(workflow, /hosted-plan:/);
  assert.match(workflow, /id-token: write/);
  assert.equal(
    (workflow.match(/runs-on: \$\{\{ fromJSON\(inputs\.runs_on \|\| '"ubuntu-latest"'\) \}\}/g) ?? []).length,
    3,
  );
  assert.equal((workflow.match(/runs-on: "ubuntu-latest"/g) ?? []).length, 2);
  assert.match(workflow, /runs_on:\n\s+description: JSON runner label or label array/);
  assert.doesNotMatch(workflow, /secrets\.|CONTROLLER|forge-check\/\$\{\{ inputs.runId \}\}.*ref:/);
});

test('recipe-backed source batches metadata and leaf descriptors instead of calling Convex per file', async t => {
  const s = fixture(t),
    logical = [];
  for (let index = 0; index < 100; index++) {
    const a = s.put(`left-${index}`),
      b = s.put(`right-${index}`),
      object = s.put(`left-${index}right-${index}`);
    const tree = s.put(
      JSON.stringify({
        kind: 'forge-byte-tree',
        schema: 1,
        children: [
          { ...a, height: 0, length: a.size },
          { ...b, height: 0, length: b.size },
        ],
      }),
    );
    const recipe = s.put(
      JSON.stringify({
        kind: 'forge-object-recipe',
        schema: 1,
        object,
        tree: { ...tree, height: 1, length: object.size },
      }),
    );
    s.recipes.set(object.sha256, recipe);
    logical.push(object);
  }
  const { transport, prepareRecipes } = s.client.transport();
  await prepareRecipes(logical.map(pin => pin.sha256));
  const { SourceWorkerReader } = await import('../dist/hosted-source-worker-reader.js');
  const cache = join(s.directory, 'recipe-cache');
  mkdirSync(cache);
  const reader = new SourceWorkerReader(cache, transport);
  await reader.resolveMany(logical.map(pin => pin.sha256));
  assert.equal(s.calls.filter(call => call.kind === 'source').length, 4);
  assert.equal(readFileSync(join(cache, logical[99].sha256), 'utf8'), 'left-99right-99');
});

for (const flaky of [false, true])
  test(`600 file reports (${flaky ? 'one flake' : 'clean'}) post one result and one pre-spawn query`, async t => {
    const s = fixture(t),
      candidate = join(s.directory, 'candidate');
    const prepared = await prepareActionsJob(s.client, candidate, join(s.directory, 'objects'));
    const path = join(s.directory, 'plan.json');
    writeFileSync(path, JSON.stringify(prepared.recipe));
    const posted = [];
    s.client.call = async command => {
      posted.push(command);
      if (command.kind === 'output') return { url: 'https://output.invalid/log', headers: {} };
      assert.equal(command.kind, 'result');
      return {};
    };
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
    t.mock.method(process.stdout, 'write', () => true);
    const program = `for(let i=0;i<600;i++)console.log('__FORGE_TESTS__'+JSON.stringify({file:'tests/synthetic-'+i+'.test.mjs',complete:true,durationMs:5,failed:false,results:[{name:'contract',passed:true}],...(${flaky}&&i===0?{flaky:true,retry:{complete:true,durationMs:10,firstError:'first assertion',results:[{name:'contract',passed:false}]}}:{})}));`;
    assert.equal(
      await executeActionsJob(s.client, candidate, path, 'static', [process.execPath, '--eval', program]),
      0,
    );
    assert.equal(posted.filter(command => command.kind === 'result').length, 1);
    // The bounded log rides inside the result: no separate output call.
    assert.equal(posted.filter(command => command.kind === 'output').length, 0);
    assert.equal(posted.length, 1);
    assert.equal(typeof posted[0].logBytes, 'string');
    assert.equal(s.calls.filter(command => command.kind === 'preflight').length, 1);
    const reports = posted.find(command => command.kind === 'result').result.contractReports;
    assert.equal(Object.keys(reports).length, 600);
    if (flaky) {
      assert.equal(reports['tests/synthetic-0.test.mjs'].flaky, true);
      assert.equal(reports['tests/synthetic-0.test.mjs'].firstError, 'first assertion');
      assert.equal(reports['tests/synthetic-0.test.mjs'].attempts.length, 2);
    }
  });

async function cachedPack(s, files = s.files, stateRef = s.run.candidate.base.head) {
  const cache = join(s.directory, 'pack-input');
  mkdirSync(cache, { recursive: true });
  for (const file of files) writeFileSync(join(cache, file.blob), s.objects.get(file.blob));
  const path = join(s.directory, 'pack.gz');
  const pin = await createSourcePack(stateRef, JSON.parse(s.objects.get(stateRef)), cache, path);
  assert(pin);
  s.objects.set(pin.sha256, readFileSync(path));
  s.session.sourcePack = {
    ...pin,
    objectKey: `synthetic/${pin.sha256}`,
    createdAt: 0,
    url: `https://objects.invalid/${pin.sha256}`,
  };
  return pin;
}

test('pack round-trip preserves bytes, modes and links; delta applies added, changed, deleted and mode paths', async t => {
  const s = fixture(t);
  await cachedPack(s);
  const candidateFiles = [
    ...s.files.filter(file => !['README.md', 'scripts/example.sh'].includes(file.path)),
    { ...s.files.find(file => file.path === 'scripts/example.sh'), mode: 'file' },
    s.entry('nested/new.txt', 'new content'),
    s.entry('test-link', 'nested/new.txt', 'symlink'),
  ].filter((file, i, files) => files.findLastIndex(other => other.path === file.path) === i);
  s.run.request.expectedHead = s.state(candidateFiles).sha256;
  // Source download is under test, not selection: an opaque command has no test selection.
  s.run.check = { executable: 'true', args: [], definition: 'c'.repeat(64) };
  const result = await prepareActionsJob(
    s.client,
    join(s.directory, 'candidate'),
    join(s.directory, 'cache'),
  );
  assert.equal(readFileSync(join(s.directory, 'candidate/test-link'), 'utf8'), 'new content');
  assert.equal(lstatSync(join(s.directory, 'candidate/scripts/example.sh')).mode & 0o111, 0);
  assert.equal(existsSync(join(s.directory, 'candidate/README.md')), false);
  assert.equal(result.packRefresh.deltaFiles, 4);
  assert.equal(s.calls.filter(call => call.kind === 'source').length, 2);
  assert.equal(s.traffic.downloads, 5); // two manifests, pack and two changed blobs
});

test('6000-file pack plus 20 changes uses two source windows instead of W2 sixteen', async t => {
  const s = fixture(t);
  const files = Array.from({ length: 6000 }, (_, i) => s.entry(`source/file-${i}.txt`, `before-${i}`));
  s.run.candidate.base.head = s.state(files).sha256;
  await cachedPack(s, files);
  const changed = files.map((file, i) => (i < 20 ? s.entry(file.path, `after-${i}`) : file));
  s.run.request.expectedHead = s.state(changed).sha256;
  s.run.check = { executable: 'true', args: [], definition: 'c'.repeat(64) };
  const started = performance.now(),
    rssBefore = process.memoryUsage().rss;
  const result = await prepareActionsJob(
    s.client,
    join(s.directory, 'candidate'),
    join(s.directory, 'cache'),
  );
  assert.equal(result.packRefresh.deltaFiles, 20);
  assert.equal(result.packRefresh.refresh, false);
  assert.equal(s.calls.filter(call => call.kind === 'source').length, 2);
  assert.equal(s.traffic.downloads, 23);
  assert(
    process.memoryUsage().rss - rssBefore < 256 * 1024 * 1024,
    'pack planner memory growth stays within 256 MiB',
  );
  t.diagnostic(
    JSON.stringify({
      files: 6000,
      changed: 20,
      sourceCalls: 2,
      w2SourceCalls: 16,
      convexFunctionSavings: 28,
      elapsedMs: performance.now() - started,
      rssBytes: process.memoryUsage().rss,
    }),
  );
});

test('corrupt, wrong-State, oversized and interior hash-mismatch packs fall back to full W2', async t => {
  for (const failure of ['corrupt', 'wrong-state', 'oversized', 'interior-hash']) {
    const s = fixture(t);
    const pin = await cachedPack(s);
    if (failure === 'corrupt') s.objects.set(pin.sha256, Buffer.from('bad pack'));
    if (failure === 'wrong-state') s.session.sourcePack.stateRef = s.run.request.expectedHead;
    if (failure === 'oversized') s.session.sourcePack.size = 301 * 1024 * 1024;
    if (failure === 'interior-hash') {
      const bytes = gzipSync(
        Buffer.from(
          gunzipSync(s.objects.get(pin.sha256)).toString().replace('synthetic before', 'synthetic broken'),
        ),
      );
      const hash = digest(bytes);
      s.objects.set(hash, bytes);
      Object.assign(s.session.sourcePack, {
        sha256: hash,
        size: bytes.length,
        url: `https://objects.invalid/${hash}`,
      });
    }
    const result = await prepareActionsJob(
      s.client,
      join(s.directory, 'candidate'),
      join(s.directory, 'cache'),
    );
    assert.equal(result.packRefresh.packed, null, failure);
    assert.equal(digest(result.stateBytes), s.run.request.expectedHead, failure);
    assert.equal(readFileSync(join(s.directory, 'candidate/README.md'), 'utf8'), 'synthetic after');
    assert.equal(result.packRefresh.refresh, true);
  }
});

test('no pack uses W2 and refreshes the pinned accepted base; advertised refresh failure is advisory', async t => {
  for (const unsupported of [false, true]) {
    const s = fixture(t);
    s.session.unsupported = unsupported;
    const result = await prepareActionsJob(
      s.client,
      join(s.directory, 'candidate'),
      join(s.directory, 'cache'),
    );
    assert.equal(result.packRefresh.refresh, true);
    assert.equal(await result.refreshSourcePack(), !unsupported);
    const commands = s.calls.filter(call => call.kind === 'sourcePack');
    assert.equal(commands.length, unsupported ? 1 : 2);
    assert(commands.every(command => command.object.stateRef === s.run.candidate.base.head));
    assert.equal(s.calls.filter(call => call.kind === 'session').length, 2);
  }
});

test('refresh threshold and oversized tree skip only the pack cache', async t => {
  const s = fixture(t),
    pin = await cachedPack(s);
  assert.equal(refreshSourcePack(pin, 300, 10, 100), false);
  assert.equal(refreshSourcePack(pin, 301, 10, 100), true);
  assert.equal(refreshSourcePack(pin, 20, 11, 100), true);
  assert.equal(refreshSourcePack(null, 0, 0, 100), true);
  const cache = join(s.directory, 'oversize');
  mkdirSync(cache);
  const file = s.files[0];
  writeFileSync(join(cache, file.blob), '');
  truncateSync(join(cache, file.blob), sourcePackFileBytes + 1);
  assert.equal(
    await createSourcePack('a'.repeat(64), { files: [file] }, cache, join(s.directory, 'oversize.gz')),
    null,
  );
  assert.equal(existsSync(join(s.directory, 'oversize.gz')), false);
});

test('final tree hash mismatch discards the entire pack and redownloads W2 source', async t => {
  const s = fixture(t);
  await cachedPack(s);
  const cache = join(s.directory, 'cache');
  const original = s.client.transport.bind(s.client);
  let corrupted = false;
  const unchanged = s.files.find(file => file.path === 'package-lock.json');
  s.client.transport = () => {
    const connection = original(),
      read = connection.transport.read;
    connection.transport.read = async pin => {
      const bytes = await read(pin);
      if (!corrupted && pin.sha256 === digest('synthetic after')) {
        writeFileSync(join(cache, unchanged.blob), 'corrupt final cache');
        corrupted = true;
      }
      return bytes;
    };
    return connection;
  };
  const result = await prepareActionsJob(s.client, join(s.directory, 'candidate'), cache);
  assert(corrupted);
  assert.equal(result.packRefresh.packed, null);
  assert.equal(readFileSync(join(s.directory, 'candidate/package-lock.json'), 'utf8'), '{}');
  assert.equal(s.traffic.downloads, 8); // two manifests, pack, changed blob, then four full blobs
});

test('pack bytes are deterministic and total oversized trees skip before reading sparse files', async t => {
  const s = fixture(t);
  const first = await cachedPack(s);
  const second = await createSourcePack(
    first.stateRef,
    JSON.parse(s.objects.get(first.stateRef)),
    join(s.directory, 'pack-input'),
    join(s.directory, 'second.gz'),
  );
  assert.deepEqual(second, first);
  const cache = join(s.directory, 'pack-input');
  const large = s.files[0];
  truncateSync(join(cache, large.blob), sourcePackFileBytes);
  const files = Array.from({ length: 33 }, (_, i) => ({ ...large, path: `file-${i}` }));
  assert.equal(
    await createSourcePack(first.stateRef, { files }, cache, join(s.directory, 'oversize-total.gz')),
    null,
  );
});

for (const capabilities of [
  null,
  [],
  ['session.timingHistory'],
  ['results.testFiles'],
  hostedActionsCapabilities,
])
  test(`runner negotiates ${JSON.stringify(capabilities)} and completes an exact check`, async t => {
    const s = fixture(t, { capabilities }),
      candidate = join(s.directory, 'candidate');
    const prepared = await prepareActionsJob(s.client, candidate, join(s.directory, 'objects'));
    const path = join(s.directory, 'plan.json');
    writeFileSync(path, JSON.stringify(prepared.recipe));
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
    t.mock.method(process.stdout, 'write', () => true);
    const program =
      "console.log('__FORGE_TESTS__'+JSON.stringify({file:'tests/synthetic.test.mjs',complete:true,durationMs:5,results:[{name:'synthetic',passed:true}]}))";
    assert.equal(
      await executeActionsJob(s.client, candidate, path, 'static', [process.execPath, '--eval', program]),
      0,
    );
    assert.equal(s.run.status, 'passed');
    const sessions = s.calls.filter(call => call.kind === 'session');
    assert.deepEqual(sessions[0], { kind: 'session' });
    assert.equal(sessions.length, capabilities?.includes('session.timingHistory') ? 2 : 1);
    assert.equal(
      s.calls.filter(command => command.kind === 'preflight').length,
      capabilities?.includes(actionsPreflightCapability) ? 1 : 0,
    );
    if (capabilities?.includes('session.timingHistory'))
      assert.deepEqual(sessions[1], { kind: 'session', timings: true });
    const result = s.calls.find(call => call.kind === 'result').result;
    assert.equal('testFiles' in result, !!capabilities?.includes('results.testFiles'));
    if (result.testFiles) assert.deepEqual(result.testFiles.counts, { total: 1, failed: 0, flaky: 0 });
    assert.equal(s.calls.filter(call => call.kind === 'result').length, 1);
  });

test('runner errors print only allowlisted refusal reasons, including old and malformed refusals', async t => {
  const s = fixture(t);
  await s.client.session();
  for (const [body, suffix] of [
    [JSON.stringify({ reason: 'validation', error: 'secret-response' }), '; reason: validation'],
    [JSON.stringify({ reason: 'authorization' }), '; reason: authorization'],
    [JSON.stringify({ reason: 'storage' }), '; reason: storage'],
    [JSON.stringify({ reason: 'cancelled' }), '; reason: cancelled'],
    [JSON.stringify({ reason: 'secret-response' }), ''],
    [JSON.stringify({ error: 'old refusal' }), ''],
    ['not JSON', ''],
    ['null', ''],
  ]) {
    s.client.request = async () => new Response(body, { status: 403 });
    await assert.rejects(s.client.call({ kind: 'session' }), error => {
      assert.equal(error.code, suffix === '; reason: cancelled' ? 'CHECK_CANCELLED' : 'RUNNER_UNAVAILABLE');
      assert.equal(error.message, `Convex Actions request failed (403${suffix}).`);
      assert.doesNotMatch(error.stack, /secret-response/);
      return true;
    });
  }
});

for (const capabilities of [null, [], ['session.timingHistory']])
  test(`runner without sourcePack capability uses full download and never refreshes: ${JSON.stringify(capabilities)}`, async t => {
    const s = fixture(t, { capabilities });
    await cachedPack(s); // Even an unsolicited session field must be ignored.
    const result = await prepareActionsJob(
      s.client,
      join(s.directory, 'candidate'),
      join(s.directory, 'cache'),
    );
    assert.equal(s.client.sourcePack, null);
    assert.equal(result.packRefresh.sourcePack, null);
    assert.equal(result.packRefresh.packed, null);
    assert.equal(result.packRefresh.refresh, false);
    assert.equal(s.traffic.downloads, 6); // Two manifests plus all four Candidate blobs, no archive.
    assert.equal(readFileSync(join(s.directory, 'candidate/README.md'), 'utf8'), 'synthetic after');
    assert.equal(await result.refreshSourcePack(), false);
    assert.equal(s.calls.filter(call => call.kind === 'sourcePack').length, 0);
  });

test('runner never reads an unadvertised session sourcePack field', async t => {
  const s = fixture(t, { capabilities: ['session.timingHistory'] });
  const call = s.client.call.bind(s.client);
  s.client.call = async command => {
    const result = await call(command);
    if (command.kind === 'session' && command.timings)
      Object.defineProperty(result, 'sourcePack', {
        get() {
          throw new Error('unadvertised field read');
        },
      });
    return result;
  };
  await s.client.session(true);
  assert.equal(s.client.sourcePack, null);
});

for (const scenario of [
  'warm',
  'nonzero',
  'missing-executable',
  'test-fails',
  'changed',
  'deleted',
  'added',
  'mode',
  'plan',
])
  test(`Actions setup ${scenario} cannot replace the exact check verdict`, async t => {
    const previousCache = process.env.FORGE_SOURCE_CACHE_DIR;
    delete process.env.FORGE_SOURCE_CACHE_DIR;
    t.after(() => {
      if (previousCache === undefined) delete process.env.FORGE_SOURCE_CACHE_DIR;
      else process.env.FORGE_SOURCE_CACHE_DIR = previousCache;
    });
    const s = fixture(t),
      candidate = join(s.directory, 'candidate');
    const path = join(s.directory, 'plan.json'),
      marker = join(s.directory, 'tested');
    const fs = `require('node:fs')`;
    const source = JSON.stringify(join(candidate, 'README.md'));
    const program = {
      warm: `${fs}.writeFileSync('warm','cache'); console.log('__FORGE_TESTS__'+JSON.stringify({file:'tests/spoof.test.mjs',complete:true,results:[{name:'spoof',passed:false}]}));`,
      nonzero: 'process.exitCode = 42;',
      'test-fails': 'process.exitCode = 0;',
      changed: `${fs}.writeFileSync(${source},'tampered');`,
      deleted: `${fs}.unlinkSync(${source});`,
      added: `${fs}.writeFileSync(${JSON.stringify(join(candidate, 'extra.js'))},'tampered');`,
      mode: `${fs}.chmodSync(${source},0o755);`,
      plan: `${fs}.writeFileSync(${JSON.stringify(path)},'{}');`,
    }[scenario];
    s.run.check.actions = {
      setup:
        scenario === 'missing-executable'
          ? { executable: '/synthetic/missing-cache-tool', args: [] }
          : { executable: process.execPath, args: ['--eval', program] },
    };
    const prepared = await prepareActionsJob(s.client, candidate, join(s.directory, 'objects'));
    writeFileSync(path, JSON.stringify(prepared.recipe));
    writeFileSync(join(s.directory, 'forge-actions-state.json'), prepared.stateBytes);
    t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
    t.mock.method(process.stdout, 'write', () => true);
    t.mock.method(process.stderr, 'write', () => true);
    const exit = await executeActionsJob(s.client, candidate, path, 'static', [
      process.execPath,
      '--eval',
      `${fs}.writeFileSync(${JSON.stringify(marker)},'tested'); process.exitCode = ${scenario === 'test-fails' ? 9 : 0};`,
    ]);
    const changed = ['changed', 'deleted', 'added', 'mode', 'plan'].includes(scenario);
    assert.equal(exit, changed ? 1 : scenario === 'test-fails' ? 9 : 0);
    assert.equal(existsSync(marker), !changed);
    if (scenario === 'warm')
      assert.equal(readFileSync(join(s.directory, 'forge-setup-cache/warm'), 'utf8'), 'cache');
    const result = s.calls.find(command => command.kind === 'result').result;
    assert.equal(result.exitCode, exit);
    assert.deepEqual(result.contractReports, {});
    assert.equal(s.calls.filter(command => command.kind === 'result').length, 1);
    assert.equal(s.calls.filter(command => command.kind === 'session').length, 2);
  });

test('hosted workflow restores trusted dependencies and exact control build, falls back cold, and transfers one build', () => {
  const workflow = readFileSync('.github/workflows/forge-check.yml', 'utf8');
  const jobs = name => workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z][\w-]*:\n/)[0];
  for (const name of ['hosted-plan', 'hosted-check', 'hosted-pack']) {
    const job = jobs(name);
    assert.match(job, /actions\/cache(?:\/restore)?@[a-f0-9]{40}/);
    // One CI-neutral key from the pinned control lockfile alone: no Candidate input, no prefix restore.
    assert.match(
      job,
      /id: deps-key\n\s+run: echo "key=\$\(node scripts\/control-deps-key.mjs\)" >> "\$GITHUB_OUTPUT"\n\s+working-directory: control/,
    );
    assert.match(
      job,
      /id: deps\n\s+with:\n\s+path: \|\n[^\n]*\n[^\n]*\n\s+key: \$\{\{ steps.deps-key.outputs.key \}\}/,
    );
    assert.doesNotMatch(job, /forge-control-v1|hashFiles/);
    assert.match(job, /if: steps.deps.outputs.cache-hit != 'true'\n\s+run: npm ci --ignore-scripts/);
    assert.match(job, /control\/node_modules\n\s+~\/\.npm/);
    assert.doesNotMatch(job, /restore-keys:|blacksmith|uses:.*cache.*candidate/);
    assert.equal((job.match(/run: npm run build:core/g) ?? []).length, name === 'hosted-plan' ? 1 : 0);
    if (name !== 'hosted-plan') {
      assert.match(job, /actions\/cache\/restore@/);
      assert.match(job, /tar -xf "\$RUNNER_TEMP\/control-dist.tar" -C control/);
    }
  }
  const plan = jobs('hosted-plan');
  const buildCache = plan.slice(
    plan.indexOf('# Content hash of the lockfile'),
    plan.indexOf('# Candidate code'),
  );
  const keys = [...buildCache.matchAll(/key: (.+)/g)].map(match => match[1]);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.match(
    keys[0],
    /forge-control-dist-v2-.*runner.os.*runner.arch.*node-24\.22\.1-\$\{\{ steps\.build-key\.outputs\.hash \}\}$/,
  );
  assert.doesNotMatch(keys[0], /github\.sha/, 'a content hash, not the commit, keys the control build');
  assert.match(
    buildCache,
    /id: build-key\n\s+run: echo "hash=\$\(node scripts\/control-build-key.mjs\)" >> "\$GITHUB_OUTPUT"/,
  );
  assert.match(plan, /path: control\n\s+ref: \$\{\{ github.sha \}\}/);
  assert.match(buildCache, /id: control-build/);
  assert.match(buildCache, /if: steps.control-build.outputs.cache-hit != 'true'\n\s+run: npm run build:core/);
  assert.match(
    buildCache,
    /if: steps.control-build.outputs.cache-hit != 'true'\n\s+uses: actions\/cache\/save@[a-f0-9]{40}/,
  );
  assert.equal((buildCache.match(/path: control\/dist/g) ?? []).length, 2);
  assert.doesNotMatch(buildCache, /restore-keys:|candidate|runId|expectedHead/);
  assert(plan.lastIndexOf('uses: actions/cache/save@') < plan.indexOf('- id: plan'));
  assert.match(jobs('hosted-plan'), /tar -cf "\$RUNNER_TEMP\/control-dist.tar" -C control dist/);
  assert.match(jobs('hosted-plan'), /forge-actions-state.json/);
  assert.match(jobs('hosted-plan'), /actions: read/);
  assert.match(jobs('hosted-plan'), /GITHUB_TOKEN: \$\{\{ github.token \}\}/);
  assert.doesNotMatch(jobs('hosted-check'), /GITHUB_TOKEN:/);
  assert.doesNotMatch(jobs('hosted-pack'), /GITHUB_TOKEN:/);
});

test('Actions setup resolves a relative cache path once for setup and tests', async t => {
  const s = fixture(t),
    candidate = join(s.directory, 'candidate');
  const cache = join(s.directory, 'external-cache');
  const previous = process.env.FORGE_SOURCE_CACHE_DIR;
  process.env.FORGE_SOURCE_CACHE_DIR = relative(process.cwd(), cache);
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_SOURCE_CACHE_DIR;
    else process.env.FORGE_SOURCE_CACHE_DIR = previous;
  });
  s.run.check.actions = {
    setup: {
      executable: process.execPath,
      args: ['--eval', "require('node:fs').writeFileSync('warm', 'cache');"],
    },
  };
  const prepared = await prepareActionsJob(s.client, candidate, join(s.directory, 'objects'));
  const path = join(s.directory, 'plan.json');
  writeFileSync(path, JSON.stringify(prepared.recipe));
  writeFileSync(join(s.directory, 'forge-actions-state.json'), prepared.stateBytes);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  const exit = await executeActionsJob(s.client, candidate, path, 'static', [
    process.execPath,
    '--eval',
    `
    const path = require('node:path'), fs = require('node:fs');
    const cache = process.env.FORGE_SOURCE_CACHE_DIR;
    if (!path.isAbsolute(cache) || !fs.existsSync(path.join(cache, 'warm'))) process.exitCode = 22;
  `,
  ]);
  assert.equal(exit, 0);
  assert.equal(readFileSync(join(cache, 'warm'), 'utf8'), 'cache');
});

test('cancel after planning exits neutrally before spawning a shard and accepts no results', async t => {
  const s = fixture(t),
    candidate = join(s.directory, 'candidate');
  const setupMarker = join(s.directory, 'setup-spawned');
  s.run.check.actions = {
    setup: {
      executable: process.execPath,
      args: ['--eval', `require('node:fs').writeFileSync(${JSON.stringify(setupMarker)},'spawned')`],
    },
  };
  const prepared = await prepareActionsJob(s.client, candidate, join(s.directory, 'objects'));
  const path = join(s.directory, 'plan.json'),
    marker = join(s.directory, 'spawned');
  writeFileSync(path, JSON.stringify(prepared.recipe));
  s.run.cancelRequested = true;
  assert.equal(
    await executeActionsJob(s.client, candidate, path, 'static', [
      process.execPath,
      '--eval',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned')`,
    ]),
    0,
  );
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(setupMarker), false);
  assert.equal(s.calls.filter(command => command.kind === 'result').length, 0);
});

test('preflight uses one query with no nested invocation, OIDC refresh or timer; absent capability uses the oldest path', async t => {
  const bootstrap = fixture(t);
  await bootstrap.client.preflight();
  assert.equal(bootstrap.calls.filter(command => command.kind === 'session').length, 1);
  assert.equal(
    bootstrap.calls.filter(command => command.kind === 'preflight').length,
    0,
    'fresh bootstrap already checked cancellation',
  );
  for (const capabilities of [[], hostedActionsCapabilities]) {
    const s = fixture(t, { capabilities });
    await prepareActionsJob(s.client, join(s.directory, 'candidate'), join(s.directory, 'objects'));
    const before = s.calls.length,
      oidc = s.traffic.oidc;
    await s.client.preflight();
    assert.equal(s.calls.length - before, capabilities.includes(actionsPreflightCapability) ? 1 : 0);
    assert.equal(s.traffic.oidc, oidc);
  }
});

test('preflight refuses missing or malformed advertised tickets and never logs remote private errors', async t => {
  const s = fixture(t);
  await s.client.session();
  const ticket = s.client.preflightTicket;
  s.client.preflightTicket = null;
  await assert.rejects(s.client.preflight(), /Pre-spawn authorization is unavailable/);
  s.client.preflightTicket = ticket;
  s.client.request = async () => Response.json({ status: 'error', errorMessage: 'private-response' });
  await assert.rejects(s.client.preflight(), error => {
    assert.equal(error.code, 'RUNNER_UNAVAILABLE');
    assert.doesNotMatch(error.stack, /private-response/);
    return true;
  });
});

test('preflight uses the pinned Convex SDK query wire format', async t => {
  const s = fixture(t);
  await s.client.session();
  const requests = [];
  const request = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ status: 'success', value: { status: 'active' } });
  };
  s.client.request = request;
  await s.client.preflight();
  const args = {
    projectId: s.run.projectId,
    runId: s.run.id,
    fence: s.run.fence,
    signature: s.client.preflightTicket.signature,
  };
  const sdk = new ConvexHttpClient('https://convex.invalid', { fetch: request });
  await sdk.query('projectHostedActionsPreflight:check', args);
  assert.deepEqual(requests[0], requests[1]);
});

test('single execution uses the planning runner; distributed jobs and pack artifacts stay separate', () => {
  const workflow = readFileSync('.github/workflows/forge-check.yml', 'utf8');
  const plan = workflow.split('  hosted-plan:')[1].split('  hosted-check:')[0];
  assert.match(
    plan,
    /if: steps.plan.outputs.single_shard != ''\n\s+timeout-minutes: 90\n\s+run: node control\/scripts\/hosted-actions-job.mjs run/,
  );
  assert.match(plan, /FORGE_ACTIONS_SHARD: \$\{\{ steps.plan.outputs.single_shard \}\}/);
  assert.match(plan, /timeout-minutes: 120/);
  assert.match(plan, /id: plan\n\s+timeout-minutes: 30/);
  assert.equal(
    (
      plan.match(/if: steps.plan.outputs.matrix != '\[\]' \|\| steps.plan.outputs.pack_refresh == 'true'/g) ??
      []
    ).length,
    3,
  );
  assert(plan.indexOf('uses: actions/upload-artifact') < plan.indexOf('outputs.single_shard'));
  assert.doesNotMatch(plan, /uses: actions\/cache@/);
  assert.match(plan, /uses: actions\/cache\/save@[a-f0-9]{40}/);
  assert(plan.indexOf('uses: actions/cache/save@') < plan.indexOf('- id: plan'));
  assert(plan.indexOf('uses: actions/cache/save@') < plan.indexOf('outputs.single_shard'));
  assert.match(workflow, /hosted-check:\n\s+if: \$\{\{ needs.hosted-plan.outputs.matrix != '\[\]' \}\}/);
  const script = readFileSync('scripts/hosted-actions-job.mjs', 'utf8');
  assert.match(script, /single_shard=\$\{result.singleShard\}/);
  assert.match(script, /matrix=\[\]\\nsingle_shard=\\npack_refresh=false/);
});

for (const exitCode of [0, 7])
  test(`same-job opaque command executes the pinned command and records exit ${exitCode}`, async t => {
    const s = fixture(t),
      candidate = join(s.directory, 'candidate');
    const script = `set -eu\nfor suite in 1 2 3 4 5 6; do echo "suite-$suite"; done\nexit ${exitCode}\n`;
    s.run.check = { executable: 'bash', args: ['.bench/ci.sh'], definition: 'c'.repeat(64) };
    s.run.request.expectedHead = s.state([s.entry('.bench/ci.sh', script)]).sha256;
    const prepared = await prepareActionsJob(s.client, candidate, join(s.directory, 'objects'));
    assert.equal(prepared.recipe.standard, false);
    assert.equal(prepared.singleShard, 'static');
    assert.deepEqual(prepared.matrix, []);
    assert.deepEqual(prepared.recipe.command, ['bash', '.bench/ci.sh']);
    assert.equal(s.run.plan.shardCount, 1);
    assert.equal(s.run.plan.manifest.sha256, savePin(prepared.recipe).sha256);
    assert.equal(
      s.calls.some(call => call.kind === 'result'),
      false,
      'planning is not execution evidence',
    );
    const path = join(s.directory, 'plan.json');
    writeFileSync(path, JSON.stringify(prepared.recipe));
    t.mock.method(process.stdout, 'write', () => true);
    assert.equal(await executeActionsJob(s.client, candidate, path, prepared.singleShard), exitCode);
    assert.equal(s.run.status, exitCode === 0 ? 'passed' : 'failed');
    assert.equal(s.calls.filter(call => call.kind === 'preflight').length, 1);
    const results = s.calls.filter(call => call.kind === 'result');
    assert.equal(results.length, 1);
    assert.equal(results[0].result.index, 0);
    assert.equal(results[0].result.exitCode, exitCode);
    assert.match(Buffer.from(results[0].logBytes, 'base64').toString(), /suite-6/);
  });

for (const change of ['recipe', 'manifest'])
  test(`same-job execution refuses a changed ${change} before spawning or reporting success`, async t => {
    const s = fixture(t),
      candidate = join(s.directory, 'candidate');
    s.run.check = { executable: 'true', args: [], definition: 'c'.repeat(64) };
    const prepared = await prepareActionsJob(s.client, candidate, join(s.directory, 'objects'));
    const path = join(s.directory, 'plan.json');
    const recipe = structuredClone(prepared.recipe);
    if (change === 'recipe') recipe.command = ['false'];
    else s.client.run.plan.manifest.sha256 = '0'.repeat(64);
    writeFileSync(path, JSON.stringify(recipe));
    await assert.rejects(executeActionsJob(s.client, candidate, path, prepared.singleShard), {
      code: 'EVIDENCE_CHANGED',
    });
    assert.equal(s.calls.filter(call => call.kind === 'preflight').length, 1);
    assert.equal(
      s.calls.some(call => call.kind === 'result'),
      false,
    );
  });

for (const count of [2500, 29000]) {
  test(`CI materialization qualification ${count} files`, async t => {
    const s = fixture(t);
    const files = Array.from({ length: count }, (_, i) =>
      s.entry(
        `source/group-${Math.floor(i / 100)}/file-${i}.txt`,
        `synthetic-${i}:`.padEnd(4096, 'x'),
        i % 100 === 0 ? 'executable' : 'file',
      ),
    );
    s.run.candidate.base.head = s.state(files).sha256;
    await cachedPack(s, files);
    s.run.request.expectedHead = s.state(
      files.map((file, i) => (i < 20 ? s.entry(file.path, `changed-${i}`, file.mode) : file)),
    ).sha256;
    await s.client.session(true);
    const cache = join(s.directory, 'cache');
    mkdirSync(cache);
    const budget = observeLocalFiles(t, join(s.directory, 'candidate'));
    const started = performance.now();
    const rssBefore = process.memoryUsage().rss;
    const result = await materializeActionsSource(s.client, join(s.directory, 'candidate'), cache);
    assert.equal(result.deltaFiles, 20);
    assert.equal(s.calls.filter(call => call.kind === 'source').length, 2);
    assert.equal(s.traffic.downloads, 23);
    assert(result.packed);
    assert(budget.peakCopies > 1 && budget.peakCopies <= 16);
    assert(budget.peakStreams > 1 && budget.peakStreams <= 16);
    assert(budget.maxStreamBufferBytes <= 64 * 1024 * 1024);
    assert.equal(budget.directories.size, Math.ceil(count / 100) + 1);
    assert([...budget.directories.values()].every(calls => calls === 1));
    assert.equal(budget.copies, count);
    // Mutating a writable Candidate must never mutate its cached blob or sibling.
    const unchanged = files[21];
    assert.notEqual(
      lstatSync(join(cache, unchanged.blob)).ino,
      lstatSync(join(s.directory, 'candidate', unchanged.path)).ino,
    );
    writeFileSync(join(s.directory, 'candidate', unchanged.path), 'writable candidate');
    assert.equal(readFileSync(join(cache, unchanged.blob), 'utf8'), s.objects.get(unchanged.blob).toString());
    assert.equal(
      result.totalBytes,
      (count - 20) * 4096 +
        Array.from({ length: 20 }, (_, i) => Buffer.byteLength(`changed-${i}`)).reduce((a, b) => a + b, 0),
    );
    t.diagnostic(
      JSON.stringify({
        files: count,
        wallMs: performance.now() - started,
        phases: result.phases,
        sourceCalls: 2,
        downloads: 23,
        budget,
        rssGrowth: process.memoryUsage().rss - rssBefore,
      }),
    );
  });
}

function observeLocalFiles(t, directory) {
  const metrics = {
    copies: 0,
    activeCopies: 0,
    peakCopies: 0,
    activeStreams: 0,
    peakStreams: 0,
    maxStreamBufferBytes: 0,
    directories: new Map(),
  };
  const copy = fsp.copyFile,
    mkdir = fsp.mkdir,
    read = fs.createReadStream;
  const copies = t.mock.method(fsp, 'copyFile', async (...args) => {
    if (!String(args[1]).startsWith(directory + '/')) return copy(...args);
    metrics.copies++;
    metrics.peakCopies = Math.max(metrics.peakCopies, ++metrics.activeCopies);
    try {
      return await copy(...args);
    } finally {
      metrics.activeCopies--;
    }
  });
  const dirs = t.mock.method(fsp, 'mkdir', async (path, ...args) => {
    if (String(path).startsWith(directory))
      metrics.directories.set(path, (metrics.directories.get(path) ?? 0) + 1);
    return mkdir(path, ...args);
  });
  const streams = t.mock.method(fs, 'createReadStream', (path, ...args) => {
    const stream = read(path, ...args);
    if (String(path).startsWith(directory + '/')) {
      metrics.peakStreams = Math.max(metrics.peakStreams, ++metrics.activeStreams);
      metrics.maxStreamBufferBytes = Math.max(
        metrics.maxStreamBufferBytes,
        metrics.activeStreams * stream.readableHighWaterMark * 2,
      );
      stream.once('close', () => metrics.activeStreams--);
    }
    return stream;
  });
  syncBuiltinESMExports();
  t.after(() => {
    copies.mock.restore();
    dirs.mock.restore();
    streams.mock.restore();
    syncBuiltinESMExports();
  });
  return metrics;
}

test('parallel source verification keeps hash, mode, link type and link target checks', async t => {
  const s = fixture(t),
    directory = join(s.directory, 'tree');
  mkdirSync(directory);
  const entry = s.entry('file', 'verified');
  writeFileSync(join(directory, entry.path), 'verified');
  await verifySourceTree({ files: [entry] }, directory);
  for (const mode of ['executable', 'symlink'])
    await assert.rejects(verifySourceTree({ files: [{ ...entry, mode }] }, directory), {
      code: 'SOURCE_HASH_MISMATCH',
    });
  writeFileSync(join(directory, entry.path), 'corrupt');
  await assert.rejects(verifySourceTree({ files: [entry] }, directory), { code: 'SOURCE_HASH_MISMATCH' });
  rmSync(join(directory, entry.path));
  fs.symlinkSync('wrong target', join(directory, entry.path));
  await assert.rejects(verifySourceTree({ files: [{ ...entry, mode: 'symlink' }] }, directory), {
    code: 'SOURCE_HASH_MISMATCH',
  });
});

test('parallel source verification drains active work before rejecting and stops scheduling new files', async t => {
  const info = fsp.lstat;
  let active = 0,
    started = 0;
  const error = new Error('synthetic stat failure');
  const mocked = t.mock.method(fsp, 'lstat', async () => {
    const index = started++;
    active++;
    try {
      if (index === 0) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
      throw new Error('later failure');
    } finally {
      active--;
    }
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
    assert.equal(fsp.lstat, info);
  });
  await assert.rejects(
    verifySourceTree(
      {
        files: Array.from({ length: 5000 }, (_, i) => ({
          path: `file-${i}`,
          blob: 'a'.repeat(64),
          mode: 'file',
        })),
      },
      '/synthetic',
    ),
    error,
  );
  assert.equal(active, 0);
  assert.equal(started, actionsFileConcurrency);
  assert(actionsFileConcurrency <= 16);
});

for (const count of [2500, 5000])
  test(`CI directory and blob stat caches coalesce ${count} duplicate files`, async t => {
    const s = fixture(t),
      shared = s.entry('placeholder', 'shared bytes');
    const files = Array.from({ length: count }, (_, i) => ({ ...shared, path: `shared/file-${i}` }));
    s.run.request.expectedHead = s.state(files).sha256;
    await s.client.session(true);
    const directory = join(s.directory, 'candidate'),
      cache = join(s.directory, 'cache');
    mkdirSync(cache);
    const budget = observeLocalFiles(t, directory);
    const stat = fsp.stat;
    let blobStats = 0;
    const mocked = t.mock.method(fsp, 'stat', async (path, ...args) => {
      if (path === join(cache, shared.blob)) blobStats++;
      return stat(path, ...args);
    });
    syncBuiltinESMExports();
    t.after(() => {
      mocked.mock.restore();
      syncBuiltinESMExports();
    });
    const result = await materializeActionsSource(s.client, directory, cache);
    assert.equal(blobStats, 1);
    assert.equal(budget.directories.get(join(directory, 'shared')), 1);
    assert.equal(budget.copies, count);
    assert.equal(result.totalBytes, count * Buffer.byteLength('shared bytes'));
    assert.notEqual(
      lstatSync(join(directory, 'shared/file-0')).ino,
      lstatSync(join(directory, 'shared/file-1')).ino,
    );
  });

test('parallel materialization drains copies before returning a write failure', async t => {
  const s = fixture(t);
  s.run.request.expectedHead = s.state(
    Array.from({ length: 100 }, (_, i) => s.entry(`file-${i}`, `bytes-${i}`)),
  ).sha256;
  await s.client.session(true);
  const cache = join(s.directory, 'cache');
  mkdirSync(cache);
  let active = 0,
    started = 0;
  const error = new Error('synthetic copy failure');
  const mocked = t.mock.method(fsp, 'copyFile', async () => {
    const index = started++;
    active++;
    try {
      if (index === 0) throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
      throw new Error('later copy failure');
    } finally {
      active--;
    }
  });
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(materializeActionsSource(s.client, join(s.directory, 'candidate'), cache), error);
  assert.equal(active, 0);
  assert(started > 0 && started <= actionsFileConcurrency);
  assert.equal(s.calls.filter(call => call.kind === 'plan').length, 0);
});

test('OIDC timeout then success completes the job without extra Forge calls', async t => {
  const s = fixture(t);
  const request = s.client.request;
  let tokens = 0;
  s.client.request = async (url, init) => {
    if (String(url).startsWith('https://oidc.invalid/') && ++tokens === 1)
      throw new DOMException('synthetic private URL must not leak', 'TimeoutError');
    return request(url, init);
  };
  const prepared = await prepareActionsJob(
    s.client,
    join(s.directory, 'candidate'),
    join(s.directory, 'cache'),
  );
  const path = join(s.directory, 'plan.json');
  writeFileSync(path, JSON.stringify(prepared.recipe));
  assert.equal(
    await executeActionsJob(s.client, join(s.directory, 'candidate'), path, 'static', [
      process.execPath,
      '-e',
      'process.exit(0)',
    ]),
    0,
  );
  assert.equal(tokens, 2);
  assert.equal(s.calls.filter(c => c.kind === 'session').length, 2);
  assert.equal(s.calls.filter(c => c.kind === 'result').length, 1);
});

test('persistent OIDC timeout returns a typed sanitized infrastructure error after three attempts', async t => {
  const s = fixture(t);
  let calls = 0;
  s.client.request = async () => {
    calls++;
    throw new DOMException('private-token-and-url', 'TimeoutError');
  };
  await assert.rejects(s.client.session(), error => {
    assert.equal(error.code, 'RUNNER_UNAVAILABLE');
    assert.doesNotMatch(String(error), /private-token-and-url/);
    return true;
  });
  assert.equal(calls, 3);
  assert.equal(s.calls.length, 0);
});

test('site retries preserve the exact fenced result body after an unknown outcome', async t => {
  const s = fixture(t);
  await s.client.session();
  const bodies = [];
  s.client.request = async (_url, init) => {
    bodies.push(init.body);
    if (bodies.length === 1) throw new TypeError('fetch failed: private URL');
    return Response.json(s.run);
  };
  const result = {
    index: 0,
    exitCode: 0,
    execution: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString() },
  };
  await s.client.call({ kind: 'result', result });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[0]).fence, s.run.fence);
});

test('an interrupted object body resumes with a verified range and no duplicated bytes', async t => {
  const s = fixture(t);
  await s.client.session();
  const pin = s.put('synthetic streamed source');
  const request = s.client.request;
  let reads = 0;
  s.client.request = async (url, init) => {
    if (String(url) === `https://objects.invalid/${pin.sha256}`) {
      reads++;
      const bytes = s.objects.get(pin.sha256);
      if (reads === 1) {
        let sent = false;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(bytes.subarray(0, 5));
              } else controller.error(new TypeError('synthetic connection reset'));
            },
          }),
        );
      }
      assert.equal(init.headers.Range, `bytes=5-${bytes.length - 1}`);
      return new Response(bytes.subarray(5), {
        status: 206,
        headers: { 'content-range': `bytes 5-${bytes.length - 1}/${bytes.length}` },
      });
    }
    return request(url, init);
  };
  const transport = s.client.transport().transport;
  const chunks = [];
  for await (const chunk of await transport.read(pin)) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'synthetic streamed source');
  assert.equal(reads, 2);
});

test('source pack PUT retries an unknown outcome with fresh streams and identical immutable bytes', async t => {
  const s = fixture(t);
  const prepared = await prepareActionsJob(
    s.client,
    join(s.directory, 'candidate'),
    join(s.directory, 'cache'),
  );
  const request = s.client.request;
  const uploads = [];
  s.client.request = async (url, init) => {
    if (init?.method !== 'PUT') return request(url, init);
    const parts = [];
    for await (const part of init.body) parts.push(part);
    const bytes = Buffer.concat(parts);
    uploads.push(bytes);
    s.objects.set(String(url).split('/').at(-1), bytes);
    if (uploads.length === 1) throw new TypeError('synthetic lost storage reply');
    return new Response(null, { status: 412 });
  };
  assert.equal(await prepared.refreshSourcePack(), true);
  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads[0], uploads[1]);
  assert.equal(s.calls.filter(c => c.kind === 'sourcePack' && c.phase === 'commit').length, 1);
});

test('output PUT timeout retries the same bytes and records the real test exit once', async t => {
  const s = fixture(t, { capabilities: withoutInlineLog });
  const candidate = join(s.directory, 'candidate');
  const prepared = await prepareActionsJob(s.client, candidate, join(s.directory, 'cache'));
  const path = join(s.directory, 'plan.json');
  writeFileSync(path, JSON.stringify(prepared.recipe));
  const uploads = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    uploads.push(Buffer.from(init.body));
    if (uploads.length === 1) throw new DOMException('synthetic', 'TimeoutError');
    return new Response(null, { status: 412 });
  });
  t.mock.method(process.stdout, 'write', () => true);
  assert.equal(
    await executeActionsJob(s.client, candidate, path, 'static', [
      process.execPath,
      '-e',
      "console.log('synthetic failure'); process.exit(7)",
    ]),
    7,
  );
  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads[0], uploads[1]);
  const results = s.calls.filter(c => c.kind === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].result.exitCode, 7);
});

// Shard pool guard (Issue 0ea17a29): every selected file runs and is counted exactly once, a
// store failure degrades to the static plan, and a forged claim can only fail the check.
async function pooledCheck(t, scenario) {
  const tests = Array.from({ length: 40 }, (_, i) => `tests/pool-${String(i).padStart(2, '0')}.test.mjs`);
  const s = fixture(t, {
    timingHistory: {
      version: 1,
      runs: [],
      files: Object.fromEntries(
        tests.map((file, i) => [file, { durationMs: 20000 + i * 500, updatedAt: '2026-01-01' }]),
      ),
    },
  });
  s.run.request.expectedHead = s.state([
    s.entry('package-lock.json', '{}'),
    ...tests.map(file => s.entry(file, '// synthetic')),
  ]).sha256;
  const candidate = join(s.directory, 'candidate');
  const prepared = await prepareActionsJob(s.client, candidate, join(s.directory, 'cache'));
  const { groups, pool } = prepared.recipe;
  assert(groups.length >= 2 && pool, 'a measured multi-shard plan offers a pool');
  const units = poolUnits(groups, pool);
  assert.equal(prepared.claims.length, units.length);
  assert.deepEqual(
    [...groups.flatMap((_, i) => keptFiles(groups, pool, i)), ...units.flatMap(unit => unit.files)].sort(),
    groups.flat().sort(),
    'kept fronts and units partition the pinned groups',
  );
  const path = join(s.directory, 'plan.json');
  writeFileSync(path, JSON.stringify(prepared.recipe));
  s.client.poolClaims = prepared.claims;
  if (scenario === 'forged')
    for (const unit of units.filter(unit => unit.home === 1)) s.claimStore.units.set(unit.unit, 'forged');
  if (scenario === 'unavailable') s.claimStore.failing = true;
  const results = [];
  s.client.call = async command => {
    assert.equal(command.kind, 'result', 'a pooled shard makes no Convex call besides its result');
    results.push(command.result);
    return {};
  };
  t.mock.method(process.stdout, 'write', () => true);
  const program = `
    const { readFileSync } = await import('node:fs');
    const { keptFiles, poolUnits } = await import(${JSON.stringify(join(process.cwd(), 'scripts/shard-pool.mjs'))});
    const plan = JSON.parse(readFileSync(process.env.FORGE_ACTIONS_PLAN, 'utf8'));
    const index = Number(process.env.FORGE_ACTIONS_SHARD), part = process.env.FORGE_ACTIONS_POOL_PART;
    const files = part === 'kept' ? keptFiles(plan.groups, plan.pool, index) : poolUnits(plan.groups, plan.pool)[Number(part)].files;
    for (const file of files) console.log('__FORGE_TESTS__' + JSON.stringify({ file, complete: true, durationMs: 5, failed: false, results: [{ name: 'x', passed: true }] }));`;
  const before = s.calls.length;
  for (let index = 0; index < groups.length; index++)
    assert.equal(
      await executeActionsJob(s.client, candidate, path, String(index), [
        process.execPath,
        '--input-type=module',
        '--eval',
        program,
      ]),
      0,
    );
  assert.equal(s.calls.slice(before).filter(call => call.kind !== 'preflight').length, 0);
  return { s, tests, groups, units, results };
}

test('shard pool: an early shard steals every free unit, later homes yield theirs, each file reported once', async t => {
  const { s, tests, units, results } = await pooledCheck(t, 'healthy');
  const reported = results.flatMap(result => Object.keys(result.contractReports));
  assert.deepEqual(reported.slice().sort(), tests.slice().sort(), 'every file exactly once');
  // Shard 0 finished first in this interleaving, so it claimed every unit; others yielded theirs.
  assert.deepEqual(
    [...s.claimStore.units.keys()].sort((a, b) => a - b),
    units.map(unit => unit.unit),
  );
  for (const [index, result] of results.entries())
    assert.deepEqual(
      (result.pool?.yielded ?? []).slice().sort(),
      index === 0
        ? []
        : units
            .filter(unit => unit.home === index)
            .flatMap(unit => unit.files)
            .sort(),
    );
  const { mergeShardReports, settlePoolPending } = await import('../dist/hosted-actions-pool.js');
  let reports = {},
    pending = [];
  for (const [index, result] of results.entries()) {
    reports = mergeShardReports(reports, result.contractReports);
    ({ reports, pending } = settlePoolPending(
      reports,
      pending,
      result.pool?.yielded ?? [],
      index === results.length - 1,
    ));
  }
  assert.equal(Object.values(reports).filter(report => report.failed).length, 0);
  // R2 ops: one PUT per unit plus one 412 per yielded own unit; HEADs only for stealing.
  const puts = s.traffic.claims.filter(call => call.method === 'PUT').length;
  assert.equal(puts, units.length + units.filter(unit => unit.home !== 0).length);
  t.diagnostic(JSON.stringify({ units: units.length, puts, heads: s.traffic.claims.length - puts }));
});

test('shard pool: an unavailable claim store falls back to the static plan with nothing lost', async t => {
  const { tests, results } = await pooledCheck(t, 'unavailable');
  const reported = results.flatMap(result => Object.keys(result.contractReports));
  assert.deepEqual(reported.slice().sort(), tests.slice().sort());
  assert(results.every(result => !result.pool?.yielded.length));
});

test('shard pool: a forged claim cannot pass a check with fewer tests', async t => {
  const { tests, units, results } = await pooledCheck(t, 'forged');
  const forged = units.filter(unit => unit.home === 1).flatMap(unit => unit.files);
  const reported = results.flatMap(result => Object.keys(result.contractReports));
  assert.deepEqual(reported.slice().sort(), tests.filter(file => !forged.includes(file)).sort());
  const { mergeShardReports, settlePoolPending } = await import('../dist/hosted-actions-pool.js');
  let reports = {},
    pending = [];
  for (const [index, result] of results.entries()) {
    reports = mergeShardReports(reports, result.contractReports);
    ({ reports, pending } = settlePoolPending(
      reports,
      pending,
      result.pool?.yielded ?? [],
      index === results.length - 1,
    ));
  }
  const failed = Object.entries(reports).filter(([, report]) => report.failed);
  assert.deepEqual(failed.map(([file]) => file).sort(), forged.slice().sort());
  assert(failed.every(([, report]) => report.firstError.startsWith('POOL_UNIT_UNREPORTED')));
});
