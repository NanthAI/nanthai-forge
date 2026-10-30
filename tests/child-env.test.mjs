// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { childEnv } from '../scripts/child-env.mjs';
import { checkWorkerEnv, checkServiceEnv } from '../dist/worker-environment.js';
import { nativeGitRunner } from '../dist/native-git-runner.js';
import { nativeGitBatch } from '../dist/native-git-batch.js';
import { gitCommand } from '../dist/work-git-command.js';
import { wakeGithubPush } from '../dist/github-auto-push.js';
import { wakePostAccept } from '../dist/post-accept-main.js';
import { waitPushAudit } from '../dist/push-audit-wait.js';
import { startPresenceWorker } from '../dist/presence-worker-start.js';
import { launchDetachedCheck } from '../dist/check-controller.js';
import { watcherRuntime } from '../dist/local-watcher-runtime.js';
import { openBrowser } from '../dist/auth-cli.js';
import { hostCli } from '../dist/host-command.js';
import { scheduleIntegrationPreview } from '../dist/integration-preview-auto.js';
import { initNative } from '../dist/native-work.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { updateHostState } from '../dist/host-binding.js';
import { releaseChild } from '../dist/maintainer-release-child.js';
import { releaseCommand } from '../dist/maintainer-release-stages.js';
import { runActionsCheck } from '../scripts/github-actions-check.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';

const secretNames = [
  'UNRELATED_TOKEN',
  'UNRELATED_KEY',
  'UNRELATED_SECRET',
  'CONVEX_DEPLOY_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'LC_UNRELATED_TOKEN',
  'LC_PRIVATE_KEY',
  'LC_OTHER_SECRET',
];
function plant(t, names = secretNames) {
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = 'fake-test-secret';
  t.after(() => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}
function clean(env) {
  assert.ok(env, 'spawn must provide an environment');
  for (const name of secretNames) assert.equal(env[name], undefined, `${name} must not reach this child`);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.PATH, process.env.PATH);
}
function capture(t) {
  plant(t);
  const calls = [];
  for (const method of ['spawn', 'fork'])
    t.mock.method(childProcess, method, (...args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.unref = () => {};
      child.ref = () => {};
      child.kill = () => true;
      child.send = () => {};
      child.exitCode = null;
      child.signalCode = null;
      calls.push({ args, options: args.at(-1), child });
      process.nextTick(() => child.emit('spawn'));
      return child;
    });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return calls;
}
function stub(t, data) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-child-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return {
    root: directory,
    directory,
    native: true,
    load: () => data,
    readRecords: () => undefined,
    page: name => ({ records: data[name] ?? [] }),
    select: (name, id) => data[name]?.find(item => item.id === id),
    revision: () => 0,
  };
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-env-owner-'));
  writeFileSync(join(root, 'a.txt'), 'base');
  const initial = initNative(root);
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { root, initial, workflow: new AgentWorkflow(root) };
}
function bind(store) {
  updateHostState(store, state => {
    state.binding = {
      operationId: randomUUID(),
      projectId: 'fake-project',
      deployment: 'http://127.0.0.1:1',
      projectUrl: 'https://example.invalid/project',
      backupId: 'fake-backup',
      name: 'Synthetic',
      visibility: 'private',
    };
  });
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('child env drops unknown credentials and Node loaders; exact allow-list and extras preserve selected values', () => {
  const source = Object.fromEntries(secretNames.map(name => [name, 'fake-test-secret']));
  Object.assign(source, {
    PATH: '/fake/bin',
    HOME: '/fake/home',
    LANG: 'C',
    LC_CTYPE: 'C',
    NODE_OPTIONS: '--require fake-loader',
    FORGE_UNKNOWN: 'fake',
  });
  const env = childEnv({ source });
  for (const name of secretNames) assert.equal(env[name], undefined);
  assert.deepEqual(env, { PATH: '/fake/bin', HOME: '/fake/home', LANG: 'C', LC_CTYPE: 'C' });
  assert.equal(childEnv({ source, allow: ['OPENAI_API_KEY'] }).OPENAI_API_KEY, 'fake-test-secret');
  assert.equal(
    childEnv({ source, extra: { PATH: '/other', GH_TOKEN: 'fake-selected', HOME: undefined } }).HOME,
    undefined,
  );
  assert.equal(source.HOME, '/fake/home');
});
test('check controller keeps declared inputs and selected Modal names without unrelated credentials', t => {
  plant(t, [...secretNames, 'DECLARED_INPUT', 'PROJECT_MODAL_ID', 'PROJECT_MODAL_SECRET']);
  const env = checkWorkerEnv([{ env: ['DECLARED_INPUT'], credentials: ['UNRELATED_TOKEN'] }], {
    kind: 'env',
    tokenId: 'PROJECT_MODAL_ID',
    tokenSecret: 'PROJECT_MODAL_SECRET',
  });
  assert.equal(env.DECLARED_INPUT, 'fake-test-secret');
  assert.equal(env.UNRELATED_TOKEN, 'fake-test-secret');
  assert.equal(env.PROJECT_MODAL_SECRET, 'fake-test-secret');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CONVEX_DEPLOY_KEY, undefined);
});
test('all shared native Git runners keep controlled GIT settings and drop planted secrets', t => {
  plant(t);
  const env = gitCommand('/fake', ['status']).env;
  clean(env);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_AUTHOR_NAME, 'NanthAi Forge');
});
test('detached GitHub auto-push drops unrelated secrets while preserving gh authentication', t => {
  const calls = capture(t);
  plant(t, ['GH_TOKEN']);
  const store = stub(t, {
    autonomyPolicy: {
      ...policyPreset('trusted'),
      githubMirror: { repo: 'fake/repo', autoPush: true, laneRefs: false },
    },
    channelMoves: [{ id: 'a', channel: 'main', status: 'accepted', head: 'h', viewId: 'v' }],
    runs: [{ status: 'passed', head: 'h', viewId: 'v' }],
  });
  wakeGithubPush(store);
  assert.equal(calls.length, 1);
  clean(calls[0].options.env);
  assert.equal(calls[0].options.env.GH_TOKEN, 'fake-test-secret');
  assert.equal(calls[0].options.env.FORGE_CHECK_QUEUE_DIR, process.env.FORGE_CHECK_QUEUE_DIR);
});
test('detached post-accept audit drops unrelated secrets and keeps its full-check setting', async t => {
  const calls = capture(t);
  wakePostAccept(stub(t, { channelMoves: [{ postAccept: { checkId: 'verify' } }], checks: [] }));
  // Cooperative selected observation publishes the wake asynchronously.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  clean(calls[0].options.env);
  assert.equal(calls[0].options.env.FORGE_CHECK_FULL, '1');
});
test('detached audit waiter supplies a filtered child environment', async t => {
  const calls = capture(t);
  const pending = waitPushAudit(stub(t, { checks: [], runs: [] }), undefined, 2000);
  assert.equal(calls.length, 1);
  clean(calls[0].options.env);
  calls[0].child.exitCode = 0;
  await pending;
});
test('detached presence owner drops unrelated credentials', t => {
  const calls = capture(t);
  const snapshotNames = [
    'FORGE_AUTO_SNAPSHOT_DEBOUNCE_MS',
    'FORGE_AUTO_SNAPSHOT_INTERVAL_MS',
    'FORGE_AUTO_SNAPSHOT_MAX_WAIT_MS',
  ];
  plant(t, snapshotNames);
  const store = stub(t, { checks: [] });
  writeFileSync(join(store.directory, 'work.json'), '{}');
  const old = process.argv[1];
  process.argv[1] = '/fake/cli.js';
  try {
    startPresenceWorker(store);
  } finally {
    process.argv[1] = old;
  }
  assert.equal(calls.length, 1);
  clean(calls[0].options.env);
  for (const name of snapshotNames) assert.equal(calls[0].options.env[name], process.env[name]);
});
test('detached selected check preserves only its declared credential', async t => {
  const calls = capture(t);
  plant(t, ['CHECK_TOKEN']);
  const store = stub(t, {});
  const run = {
    id: randomUUID(),
    viewId: randomUUID(),
    head: 'fake-head',
    check: { definition: 'fake-definition', credentials: ['CHECK_TOKEN'] },
    environment: { fingerprint: 'fake-environment' },
    runner: { pid: process.pid, host: 'fake-host' },
  };
  await launchDetachedCheck(store, run);
  assert.equal(calls.length, 1);
  clean(calls[0].options.env);
  assert.equal(calls[0].options.env.CHECK_TOKEN, 'fake-test-secret');
});
test('local watcher fork receives no unrelated credentials', t => {
  const calls = capture(t);
  watcherRuntime.createWorker();
  assert.equal(calls.length, 1);
  clean(calls[0].options.env);
  assert.deepEqual(calls[0].options.execArgv, []);
});
test('browser opener drops Forge and provider credentials', t => {
  const calls = capture(t);
  plant(t, ['FORGE_AUTH_TOKEN', 'GH_TOKEN']);
  openBrowser('https://example.invalid/device');
  clean(calls[0].options.env);
  assert.equal(calls[0].options.env.FORGE_AUTH_TOKEN, undefined);
  assert.equal(calls[0].options.env.GH_TOKEN, undefined);
});
test('detached integration preview retains declared static inputs and drops unrelated secrets', async t => {
  const calls = capture(t);
  const { workflow, initial } = await fixture(t);
  const store = workflow.work.store;
  await workflow.dispatch({ action: 'start', outcome: 'synthetic preview' });
  store.locked(() => {
    const data = store.load();
    data.autonomyPolicy = { ...policyPreset('trusted'), integrationPreview: { auto: true } };
    data.channelMoves.push({
      id: randomUUID(),
      channel: 'main',
      viewId: randomUUID(),
      head: initial.head,
      previous: null,
      at: new Date().toISOString(),
      status: 'accepted',
      provenance: 'user-declared-local',
    });
    data.revision++;
    store.save(data);
  });
  // A retained request permits the main-only preview path too.
  writeFileSync(join(store.directory, 'integration-preview-request.json'), '{"token":"old","at":0}');
  scheduleIntegrationPreview(store);
  await tick();
  const call = calls.find(call => call.args[1]?.[0]?.endsWith('/integration-preview-worker.js'));
  assert.ok(call);
  clean(call.options.env);
});
test('detached host backfill drops unrelated secrets and keeps Forge authentication', async t => {
  const calls = capture(t);
  plant(t, ['FORGE_AUTH_TOKEN']);
  const { root } = await fixture(t);
  await hostCli([root], async () => ({ historyBackfilling: true, operationId: randomUUID() }));
  const call = calls.find(call => call.args[1]?.includes('--backfill'));
  assert.ok(call);
  clean(call.options.env);
  assert.equal(call.options.env.FORGE_AUTH_TOKEN, 'fake-test-secret');
});

test('release stage worker launch and ordinary command both drop planted unrelated secrets', t => {
  plant(t);
  const options = [];
  t.mock.method(childProcess, 'spawnSync', (_command, _args, opts) => {
    options.push(opts);
    return { status: 0, signal: null };
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const directory = mkdtempSync(join(tmpdir(), 'forge-release-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  releaseChild(
    { node: process.execPath, stages: [{ name: 'package', attempts: [{ id: randomUUID(), directory }] }] },
    'package',
    directory,
  );
  releaseCommand(process.execPath, ['--version'], directory);
  assert.equal(options.length, 2);
  for (const option of options) clean(option.env);
});
test('Actions check launcher drops unrelated credentials from its runner environment', t => {
  plant(t);
  const directory = mkdtempSync(join(tmpdir(), 'forge-actions-env-'));
  const plan = join(directory, 'plan.json');
  writeFileSync(plan, JSON.stringify({ standard: false, command: [process.execPath, '--version'] }));
  const previous = {
    FORGE_ACTIONS_PLAN: process.env.FORGE_ACTIONS_PLAN,
    FORGE_ACTIONS_SHARD: process.env.FORGE_ACTIONS_SHARD,
  };
  process.env.FORGE_ACTIONS_PLAN = plan;
  process.env.FORGE_ACTIONS_SHARD = 'static';
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  let launches = 0;
  runActionsCheck(
    (_executable, _args, { env }) => {
      launches++;
      for (const name of secretNames) assert.equal(env[name], undefined);
      assert.equal(env.NODE_OPTIONS, '--max-old-space-size=3072');
    },
    { install: false },
  );
  assert.equal(launches, 1);
});
test('fixed Modal supervisor drops planted secrets before starting a project command', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-modal-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  mkdirSync(join(directory, 'modal-check'));
  copyFileSync(
    new URL('../scripts/modal-check/worker.mjs', import.meta.url),
    join(directory, 'modal-check', 'worker.mjs'),
  );
  copyFileSync(new URL('../scripts/child-env.mjs', import.meta.url), join(directory, 'child-env.mjs'));
  const env = {
    ...process.env,
    FORGE_MODAL_COMMAND: JSON.stringify({
      command: [
        process.execPath,
        '-e',
        `if(${JSON.stringify(secretNames)}.some(name => process.env[name] !== undefined)) process.exit(19);`,
      ],
      artifacts: [],
    }),
  };
  for (const name of secretNames) env[name] = 'fake-test-secret';
  const result = childProcess.spawnSync(process.execPath, [join(directory, 'modal-check', 'worker.mjs')], {
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /__FORGE_USAGE__/);
});

test('detached native Git export and batch subprocesses exclude planted credentials', async t => {
  const calls = capture(t);
  const runner = nativeGitRunner();
  t.after(() => runner.close());
  const command = runner.git('/fake', ['status']);
  clean(calls[0].options.env);
  assert.equal(calls[0].options.env.GIT_CONFIG_NOSYSTEM, '1');
  calls[0].child.emit('close', 0, null);
  await command;
  const batch = nativeGitBatch('/fake', ['mktree'], () => {});
  clean(calls[1].options.env);
  const completion = batch.finish();
  calls[1].child.emit('close', 0, null);
  calls[1].child.stdout.end();
  await completion;
});

test('owner drivers give GitHub credentials only to a selected Actions backend or mirror', t => {
  plant(t, ['GH_TOKEN', 'PROJECT_MODAL_ID', 'PROJECT_MODAL_SECRET']);
  const policy = policyPreset('trusted');
  assert.equal(checkServiceEnv([], policy).GH_TOKEN, undefined);
  assert.equal(
    checkServiceEnv([], { ...policy, checks: { runner: 'github-actions' } }).GH_TOKEN,
    'fake-test-secret',
  );
  const modal = checkServiceEnv([], {
    ...policy,
    checks: {
      runner: 'modal',
      credentialsRef: { kind: 'env', tokenId: 'PROJECT_MODAL_ID', tokenSecret: 'PROJECT_MODAL_SECRET' },
    },
  });
  assert.equal(modal.GH_TOKEN, undefined);
  assert.equal(modal.PROJECT_MODAL_SECRET, 'fake-test-secret');
});

test('Windows lookup keeps Path and ComSpec, filters credentials case-insensitively and avoids duplicate overrides', () => {
  const env = childEnv({
    platform: 'win32',
    source: {
      Path: 'fake-path',
      ComSpec: 'fake-shell',
      SystemRoot: 'fake-root',
      OpenAI_API_KEY: 'fake-test-secret',
      Gh_Token: 'fake-selected',
      HOME: 'fake-old-home',
    },
    allow: ['GH_TOKEN'],
    extra: { PATH: 'fake-selected-path', home: 'fake-new-home' },
  });
  assert.equal(env.ComSpec, 'fake-shell');
  assert.equal(env.SystemRoot, 'fake-root');
  assert.equal(env.OpenAI_API_KEY, undefined);
  assert.equal(env.Gh_Token, 'fake-selected');
  assert.equal(env.PATH, 'fake-selected-path');
  assert.equal(env.Path, undefined);
  assert.equal(env.home, 'fake-new-home');
  assert.equal(env.HOME, undefined);
});
