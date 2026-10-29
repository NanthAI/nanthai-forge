// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ActionsJobClient } from '../dist/hosted-actions-job-client.js';
import { prepareActionsJob } from '../dist/hosted-actions-job-plan.js';
import { executeActionsJob } from '../dist/hosted-actions-job-run.js';
import { savePin } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';
import { hostedActionsRuntime } from '../dist/hosted-actions.js';
import { partitionTests, shardDuration } from '../scripts/test-shards.mjs';
function fixture(
  t,
  { sourceDelay = 0, downloadDelay = 0, timingHistory = { version: 1, files: {}, runs: [] } } = {},
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
  const calls = [],
    traffic = { active: 0, peak: 0, downloads: 0, oidc: 0 };
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
    if (String(url).startsWith('https://objects.invalid/')) {
      traffic.active++;
      traffic.peak = Math.max(traffic.peak, traffic.active);
      traffic.downloads++;
      if (downloadDelay) await new Promise(resolve => setTimeout(resolve, downloadDelay));
      traffic.active--;
      return new Response(objects.get(String(url).split('/').at(-1)));
    }
    assert.equal(url, 'https://convex.invalid/checks/actions');
    const body = JSON.parse(init.body),
      command = body.command;
    calls.push(command);
    if (command.kind === 'session')
      return Response.json(command.timings ? { run, timingHistory: JSON.stringify(timingHistory) } : run);
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
    if (command.kind === 'plan') {
      run.plan = {
        head: run.request.expectedHead,
        manifest: savePin(command.plan.recipe),
        selection: savePin(command.plan.recipe.selection),
        shardCount: command.plan.recipe.groups.length + 1,
      };
      return Response.json(run);
    }
    throw new Error(`Unexpected synthetic command ${command.kind}`);
  });
  return { directory, objects, recipes, put, entry, state, files, run, calls, client, traffic };
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
  await prepareActionsJob(s.client, join(s.directory, 'candidate'), join(s.directory, 'cache'));
  const sourceCalls = s.calls.filter(call => call.kind === 'source');
  assert.equal(sourceCalls.length, 16); // One manifest window and fifteen file windows.
  assert(sourceCalls.every(call => call.digests.length <= 400));
  assert.equal(s.traffic.downloads, 6002);
  assert(s.traffic.peak > 1 && s.traffic.peak <= 3);
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
      partitionTests(tests, 8, Object.keys(filesHistory).length ? durations : {}),
    );
    assert.equal(s.calls.filter(call => call.kind === 'session').length, 1);
    if (Object.keys(filesHistory).length) {
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
  assert.deepEqual(prepared.matrix, ['static']);
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
test('fixed supervisor records actual child exit, strips OIDC env and posts bounded output', async t => {
  const s = fixture(t),
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
test('workflow keeps the native plan branch and uses OIDC without GitHub secrets for hosted jobs', () => {
  const workflow = readFileSync(new URL('../.github/workflows/forge-check.yml', import.meta.url), 'utf8');
  assert.match(workflow, /inputs.deployment == '' && inputs.plan != '\[\]'/);
  assert.match(workflow, /hosted-plan:/);
  assert.match(workflow, /id-token: write/);
  assert.equal(
    (workflow.match(/runs-on: \$\{\{ fromJSON\(inputs\.runs_on \|\| '"ubuntu-latest"'\) \}\}/g) ?? []).length,
    2,
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
  test(`600 file reports (${flaky ? 'one flake' : 'clean'}) post exactly one existing result and add no source/session calls`, async t => {
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
    assert.equal(posted.filter(command => command.kind === 'output').length, 1);
    assert.equal(posted.length, 2);
    const reports = posted.find(command => command.kind === 'result').result.contractReports;
    assert.equal(Object.keys(reports).length, 600);
    if (flaky) {
      assert.equal(reports['tests/synthetic-0.test.mjs'].flaky, true);
      assert.equal(reports['tests/synthetic-0.test.mjs'].firstError, 'first assertion');
      assert.equal(reports['tests/synthetic-0.test.mjs'].attempts.length, 2);
    }
  });
