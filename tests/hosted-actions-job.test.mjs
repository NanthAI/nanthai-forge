// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ActionsJobClient } from '../dist/hosted-actions-job-client.js';
import { prepareActionsJob } from '../dist/hosted-actions-job-plan.js';
import { executeActionsJob } from '../dist/hosted-actions-job-run.js';
import { savePin } from '../dist/hosted-save.js';
import { digest } from '../dist/hash.js';
import { hostedActionsRuntime } from '../dist/hosted-actions.js';
function fixture(t) {
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
  const calls = [];
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
    if (String(url).startsWith('https://oidc.invalid/'))
      return Response.json({
        value: `header.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 300 })).toString('base64url')}.signature`,
      });
    if (String(url).startsWith('https://objects.invalid/'))
      return new Response(objects.get(String(url).split('/').at(-1)));
    assert.equal(url, 'https://convex.invalid/checks/actions');
    const body = JSON.parse(init.body),
      command = body.command;
    calls.push(command);
    if (command.kind === 'session') return Response.json(run);
    if (command.kind === 'source')
      return Response.json(
        command.digests.map(sha256 => ({
          descriptor: {
            object: { sha256, size: objects.get(sha256).length },
            recipe: recipes.get(sha256) ?? null,
          },
          url: recipes.has(sha256) ? null : `https://objects.invalid/${sha256}`,
        })),
      );
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
  return { directory, objects, recipes, put, entry, state, files, run, calls, client };
}
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
  assert.match(workflow, /runs-on: ubuntu-latest/);
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
