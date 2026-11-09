// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { childEnv } from '../scripts/child-env.mjs';
import {
  CANDIDATE_USER,
  candidateAccessNotes,
  candidateIsolation,
  homePaths,
  toolchainReadable,
  toolchainState,
} from '../dist/candidate-user.js';
import { STATE_ROOT, gitSafeConfig, mountPlan } from '../scripts/candidate-sandbox-plan.mjs';
import { hostedCheckOutputSettled, providerVerdict } from '../dist/hosted-check-verdict.js';
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
test('check controller keeps declared inputs without resolving retired Modal credentials', t => {
  plant(t, [...secretNames, 'DECLARED_INPUT', 'PROJECT_MODAL_ID', 'PROJECT_MODAL_SECRET']);
  const env = checkWorkerEnv([{ env: ['DECLARED_INPUT'], credentials: ['UNRELATED_TOKEN'] }]);
  assert.equal(env.DECLARED_INPUT, 'fake-test-secret');
  assert.equal(env.UNRELATED_TOKEN, 'fake-test-secret');
  assert.equal(env.PROJECT_MODAL_SECRET, undefined);
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
      // A configured (non-Forge) command gets no Forge suite settings such as the heap cap.
      assert.equal(env.NODE_OPTIONS, undefined);
    },
    { install: false },
  );
  assert.equal(launches, 1);
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
  assert.equal(modal.PROJECT_MODAL_SECRET, undefined);
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

// The Candidate user launcher and the provider verdict (Issue 432164bf).
/** A fake runner: records commands; `fail` names commands that exit non-zero. */
function runner(fail = () => false) {
  const calls = [];
  return {
    calls,
    run: (command, args) => {
      calls.push([command, ...args]);
      return { status: fail([command, ...args].join(' ')) ? 1 : 0 };
    },
  };
}
const linux = (fake, env = { HOME: '/srv/ci-home' }) =>
  candidateIsolation({ env, platform: 'linux', run: fake.run });

test('the Candidate user falls back to the runner user, with a reason, wherever it cannot isolate', () => {
  assert.deepEqual(
    candidateIsolation({ env: { FORGE_CANDIDATE_USER: 'off' }, platform: 'linux' }).mode,
    'shared',
  );
  assert.match(candidateIsolation({ env: {}, platform: 'darwin' }).reason, /darwin runner/);
  for (const [fails, reason] of [
    ['sudo -n true', /no passwordless sudo/],
    ['command -v unshare', /unshare, setpriv or mount is missing/],
    ['useradd', /could not create the forge-check user/],
    ['candidate-sandbox.mjs', /self-test failed/],
  ]) {
    const fake = runner(line => line.includes(fails) || (fails === 'useradd' && line.startsWith('id ')));
    const isolation = linux(fake);
    assert.equal(isolation.mode, 'shared', fails);
    assert.match(isolation.reason, reason);
  }
});

test('an existing user is reused; a missing one is created without a home directory', () => {
  const existing = runner();
  assert.equal(linux(existing).mode, 'user');
  assert.ok(!existing.calls.some(call => call.includes('useradd')));
  const missing = runner(line => line.startsWith('id '));
  assert.equal(linux(missing).user, CANDIDATE_USER);
  const add = missing.calls.find(call => call.includes('useradd'));
  assert.ok(add.includes('--no-create-home') && add.includes('--system'), add.join(' '));
  // The account home is the runner's home path, which the sandbox turns into the Candidate's own
  // folder: code reading the password database (os.userInfo().homedir) finds a real, writable home.
  assert.equal(add[add.indexOf('--home-dir') + 1], '/srv/ci-home');
  const moved = existing.calls.find(call => call.includes('usermod'));
  assert.deepEqual(moved.slice(-3), ['--home', '/srv/ci-home', CANDIDATE_USER]);
  const homeless = runner(line => line.startsWith('id '));
  linux(homeless, { HOME: '/' });
  const none = homeless.calls.find(call => call.includes('useradd'));
  assert.equal(none[none.indexOf('--home-dir') + 1], '/nonexistent');
  const stuck = runner(line => line.includes('usermod'));
  assert.match(linux(stuck).reason, /could not set up the forge-check user/);
});

test('a launch passes exactly the child env and the allow-listed paths, moving ownership once', t => {
  const isolation = linux(runner());
  assert.equal(isolation.mode, 'user');
  const argv = isolation.command(['npm', 'test'], { PATH: '/usr/bin', CI: 'true' }, '/work/candidate', {
    writable: ['/work/candidate', '/srv/ci-home/.npm'],
    readable: ['/work/control'],
  });
  const spec = argv.at(-1);
  t.after(() => rmSync(spec, { force: true }));
  assert.deepEqual(argv.slice(0, 8), [
    'sudo',
    '-n',
    '--',
    'unshare',
    '--mount',
    '--propagation',
    'private',
    '--',
  ]);
  assert.match(argv.at(-2), /scripts\/candidate-sandbox\.mjs$/);
  assert.equal(statSync(spec).mode & 0o777, 0o600, 'the spec is private to the runner user');
  const written = JSON.parse(readFileSync(spec, 'utf8'));
  assert.deepEqual(written.env, {
    PATH: '/usr/bin',
    CI: 'true',
    USER: CANDIDATE_USER,
    LOGNAME: CANDIDATE_USER,
  });
  assert.deepEqual(written.argv, ['npm', 'test']);
  assert.equal(written.home, '/srv/ci-home');
  assert.deepEqual(written.readable, ['/work/control']);
  assert.deepEqual(written.chown, ['/work/candidate', '/srv/ci-home/.npm']);
  // A later part of the same job (a pooled unit) reuses the ownership already moved.
  const again = isolation.command(['npm', 'test'], {}, '/work/candidate', {
    writable: ['/work/candidate', '/work/junit-2'],
    readable: [],
  });
  t.after(() => rmSync(again.at(-1), { force: true }));
  assert.deepEqual(JSON.parse(readFileSync(again.at(-1), 'utf8')).chown, ['/work/junit-2']);
});

test('toolchain folders under the home are readable; data homes and other paths are not', t => {
  const home = mkdtempSync(join(tmpdir(), 'forge-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const dir of ['.cargo/bin', '.rustup', 'go/bin', 'sdk/jdk', '.pub-cache'])
    mkdirSync(join(home, dir), { recursive: true });
  const env = {
    HOME: home,
    PATH: [join(home, '.cargo/bin'), '/usr/bin', join(home, 'missing')].join(':'),
    JAVA_HOME: join(home, 'sdk/jdk'),
    GOPATH: join(home, 'go'),
    CARGO_HOME: join(home, '.cargo'),
    // A data home the Candidate writes (its own fresh one), never bound read-only from the runner.
    PUB_CACHE: join(home, '.pub-cache'),
  };
  assert.deepEqual(toolchainReadable(env), [
    join(home, '.cargo/bin'),
    join(home, '.rustup'),
    join(home, 'sdk/jdk'),
  ]);
  assert.deepEqual(toolchainReadable({ ...env, HOME: '' }), []);
  assert.deepEqual(homePaths(['~/.npm', '~', '/opt/x'], '/srv/ci-home'), [
    '/srv/ci-home/.npm',
    '/srv/ci-home',
    '/opt/x',
  ]);
});

// Toolchains in the Candidate sandbox (Issues f325cede, 1f67da41, 868ebd92, 68632a64).
/** Runs a mount plan against a model of the namespace: read-only binds refuse writes (EROFS), the
 * runner's real paths are never written, and only the fresh home and copies are the Candidate's. */
function simulate({ home, real, files, ...lists }) {
  const realPath = path => (path.startsWith(`${home}/`) ? join(real, path.slice(home.length)) : path);
  const exists = path =>
    path === home || files.has(path) || [...files].some(file => file.startsWith(`${path}/`));
  const isDirectory = path => exists(path) && !files.has(path);
  const steps = mountPlan({ home, real, exists, isDirectory, ...lists });
  const mounts = [];
  const candidateOwned = new Set([home]);
  const at = path =>
    mounts
      .filter(m => path === m.path || path.startsWith(`${m.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
  for (const step of steps) {
    if (step.step === 'mkdir' || step.step === 'touch') {
      const mount = at(step.path);
      if (mount?.ro) throw Object.assign(new Error(`EROFS ${step.path}`), { code: 'EROFS' });
      assert.ok(step.path.startsWith(`${home}/`) && !mount, `${step.path} is created only in the fresh home`);
      if (step.step === 'mkdir') candidateOwned.add(step.path);
    } else if (step.step === 'copy') {
      assert.ok(step.store.startsWith(`${STATE_ROOT}/`), step.store);
      assert.ok(exists(step.source), step.source);
    } else if (step.step === 'bind') {
      // Writable sources are the Candidate's own lists or its private copies, never a toolchain.
      mounts.push({ path: step.path, source: step.source, ro: false });
    } else {
      const mount = mounts.find(m => m.path === step.path);
      mount.ro = true;
    }
  }
  return { steps, mounts, realPath };
}

test('a toolchain folder nested in another one is never written to (CMake: EROFS chown)', () => {
  const home = '/h',
    real = '/r';
  const ninja = `${home}/work/_temp/61b2`,
    cmake = `${ninja}/cmake-3.31.6-linux-x86_64/bin`;
  const files = new Set([
    `${real}/work/_temp/61b2/ninja`,
    `${real}/work/_temp/61b2/cmake-3.31.6-linux-x86_64/bin/cmake`,
    `${real}/work/_temp/61b2/cmake-3.31.6-linux-x86_64/share/cmake-3.31/Modules/CMake.cmake`,
    `${real}/.hex/packages/x`,
    `${real}/work/repo/repo/CMakeLists.txt`,
  ]);
  const { steps, mounts } = simulate({
    home,
    real,
    files,
    writable: [`${home}/work/repo/repo`],
    readable: [cmake, ninja, `${home}/missing/bin`],
  });
  // The parent is bound read-only once; the nested PATH entry is already visible through it.
  assert.deepEqual(
    mounts.map(m => [m.path, m.ro]),
    [
      [`${home}/work/repo/repo`, false],
      [ninja, true],
    ],
  );
  assert.ok(!steps.some(step => step.path === cmake), 'no step touches the nested entry');
});

test('Elixir: install roots are readable and the Mix home is a private copy', t => {
  const home = mkdtempSync(join(tmpdir(), 'forge-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const beam = join(home, 'work/_temp/.setup-beam');
  for (const dir of [
    'otp/bin',
    'otp/erts-15.2/bin',
    'elixir/bin',
    'elixir/lib',
    '.mix/escripts',
    '.mix/archives',
  ])
    mkdirSync(join(dir.startsWith('.mix') ? home : beam, dir), { recursive: true });
  const env = {
    HOME: home,
    RUNNER_TEMP: join(home, 'work/_temp'),
    PATH: [join(beam, 'otp/bin'), join(beam, 'elixir/bin'), join(home, '.mix/escripts'), '/usr/bin'].join(
      ':',
    ),
    INSTALL_DIR_FOR_OTP: join(beam, 'otp'),
    INSTALL_DIR_FOR_ELIXIR: join(beam, 'elixir'),
  };
  const readable = toolchainReadable(env);
  // Without the install roots only otp/bin is bound, and bin/erl cannot reach erts-*/bin/erlexec.
  assert.ok(
    readable.includes(join(beam, 'otp')) && readable.includes(join(beam, 'elixir')),
    readable.join(' '),
  );
  assert.deepEqual(toolchainState(env, ['elixir']), { copies: [join(home, '.mix')], gitSafe: [] });
  assert.deepEqual(
    toolchainState(env, ['go']),
    { copies: [], gitSafe: [] },
    'undeclared tools change nothing',
  );
  const real = '/r';
  const rel = path => join(real, path.slice(home.length));
  const files = new Set([
    rel(join(beam, 'otp/erts-15.2/bin/erlexec')),
    rel(join(beam, 'otp/bin/erl')),
    rel(join(beam, 'elixir/lib/elixir.app')),
    rel(join(beam, 'elixir/bin/elixir')),
    rel(join(home, '.mix/archives/hex-2.2.1')),
    rel(join(home, '.mix/escripts/x')),
  ]);
  const { steps, mounts } = simulate({ home, real, files, readable, copies: [join(home, '.mix')] });
  assert.ok(mounts.some(m => m.path === join(beam, 'otp') && m.ro));
  const mix = mounts.find(m => m.path === join(home, '.mix'));
  assert.ok(mix && !mix.ro && mix.source.startsWith(`${STATE_ROOT}/`), 'the Mix home is a writable copy');
  assert.ok(!mounts.some(m => m.path === join(home, '.mix/escripts')), 'escripts come with the copy');
  assert.deepEqual(steps.find(step => step.step === 'copy').source, rel(join(home, '.mix')));
});

test('Ruby and Flutter: the toolchain writes go to private copies, the install stays read-only', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-tools-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cache = join(root, 'toolcache'),
    home = join(root, 'home');
  const ruby = join(cache, 'Ruby/3.4.7/x64'),
    flutter = join(cache, 'flutter/stable-3.35.7-x64/flutter');
  for (const dir of [
    `${ruby}/bin`,
    `${ruby}/lib/ruby/gems/3.4.0/gems`,
    `${flutter}/bin/cache/dart-sdk/bin`,
    // Release archives ship the tool's sources but not its .dart_tool, which its first pub get writes.
    `${flutter}/packages/flutter_tools/lib`,
    `${flutter}/.git`,
    home,
  ])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(ruby, 'bin/ruby'), '');
  writeFileSync(join(flutter, 'bin/flutter'), '');
  // A system Ruby later on PATH, and one outside every install area, are never copied.
  const system = join(root, 'usr');
  mkdirSync(join(system, 'bin'), { recursive: true });
  writeFileSync(join(system, 'bin/ruby'), '');
  mkdirSync(join(system, 'lib/ruby/gems'), { recursive: true });
  const env = {
    HOME: home,
    RUNNER_TOOL_CACHE: cache,
    PATH: [
      join(flutter, 'bin/cache/dart-sdk/bin'),
      join(flutter, 'bin'),
      join(ruby, 'bin'),
      join(system, 'bin'),
    ].join(':'),
  };
  assert.deepEqual(toolchainState(env, ['ruby', 'flutter']), {
    copies: [
      join(flutter, 'bin/cache'),
      join(flutter, 'packages/flutter_tools'),
      join(ruby, 'bin'),
      join(ruby, 'lib/ruby/gems'),
    ].sort(),
    gitSafe: [flutter],
  });
  assert.deepEqual(toolchainState({ ...env, PATH: join(system, 'bin') }, ['ruby']), {
    copies: [],
    gitSafe: [],
  });
  const files = new Set([
    join(ruby, 'bin/ruby'),
    join(ruby, 'lib/ruby/gems/3.4.0/gems/x'),
    join(flutter, 'bin/flutter'),
    join(flutter, 'bin/cache/dart-sdk/bin/dart'),
    join(flutter, 'packages/flutter_tools/lib/executable.dart'),
  ]);
  const copies = toolchainState(env, ['ruby', 'flutter']).copies;
  const { steps, mounts } = simulate({ home, real: '/r', files, copies });
  for (const path of copies) {
    const mount = mounts.find(m => m.path === path);
    assert.ok(mount && !mount.ro && mount.source.startsWith(`${STATE_ROOT}/`), path);
  }
  assert.ok(
    steps.every(step => step.step === 'copy' || step.step === 'bind'),
    'nothing is created, chowned or remounted in the toolchain',
  );
  assert.equal(gitSafeConfig(home, [flutter]), `[safe]\n\tdirectory = ${flutter}\n`);
});

test('guard: the Candidate never gets the real home, a toolchain or a system folder writable', t => {
  const home = '/srv/ci-home',
    real = '/var/lib/forge-check/1/real';
  const files = new Set([
    `${real}/.ssh/id`,
    `${real}/.mix/archives/hex`,
    '/opt/hostedtoolcache/x',
    '/usr/bin/ruby',
  ]);
  const steps = mountPlan({
    home,
    real,
    writable: [],
    readable: [],
    copies: ['/', home, '/srv', STATE_ROOT, `${STATE_ROOT}/x`, `${home}/.mix`, '/usr/bin'],
    exists: path => path === home || [...files].some(file => file === path || file.startsWith(`${path}/`)),
    isDirectory: path => ![...files].includes(path),
  });
  // Only the declared folder is copied; `/`, the home, its parents and the state root never are.
  assert.deepEqual(
    steps.filter(step => step.step === 'copy').map(step => step.source),
    ['/usr/bin', `${real}/.mix`],
  );
  for (const step of steps.filter(step => step.step === 'bind'))
    assert.ok(step.source.startsWith(`${STATE_ROOT}/`), `${step.path} is writable only as a copy`);
  assert.equal(gitSafeConfig(home, ['/', '/srv', home, '/a"b']), null);
  // The supervisor never lists a toolchain copy for chown: the original keeps its owner.
  const isolation = linux(runner());
  const argv = isolation.command(['true'], {}, '/work/candidate', {
    writable: ['/work/candidate'],
    readable: ['/srv/ci-home/.cargo/bin'],
    copies: ['/opt/hostedtoolcache/Ruby/3.4.7/x64/bin'],
    gitSafe: ['/opt/hostedtoolcache/flutter/x/flutter'],
  });
  t.after(() => rmSync(argv.at(-1), { force: true }));
  const spec = JSON.parse(readFileSync(argv.at(-1), 'utf8'));
  assert.deepEqual(spec.chown, ['/work/candidate']);
  assert.deepEqual(spec.copies, ['/opt/hostedtoolcache/Ruby/3.4.7/x64/bin']);
  assert.deepEqual(spec.gitSafe, ['/opt/hostedtoolcache/flutter/x/flutter']);
});

test('a failed Candidate command names the path and the user it could not use', () => {
  const env = {
    HOME: '/srv/ci-home',
    RUNNER_TEMP: '/srv/ci-home/work/_temp',
    RUNNER_TOOL_CACHE: '/opt/hostedtoolcache',
  };
  const notes = candidateAccessNotes({
    user: CANDIDATE_USER,
    env,
    paths: { writable: ['/srv/ci-home/work/r/r'], readable: ['/srv/ci-home/work/_temp/.setup-beam/otp/bin'] },
    exists: path => path.includes('erts-15'),
  });
  notes.accept(
    'Bundler::OperationNotPermittedError: There was an error while trying to write to `/opt/hostedtoolcache/Ruby/3.4.7/x64/lib/ruby/gems/3.4.0/cache`. Underlying OS system call raised an EPERM error.\n',
  );
  notes.accept(
    '/srv/ci-home/work/_temp/.setup-beam/otp/bin/erl: 57: exec: /srv/ci-home/work/_temp/.setup-beam/otp/erts-15.2/bin/erlexec: not fo',
  );
  notes.accept("und\nEACCES: permission denied, open '/srv/ci-home/work/r/r/out.txt'\n");
  const lines = notes.notes();
  assert.deepEqual(lines, [
    'Forge: $RUNNER_TOOL_CACHE/Ruby/3.4.7/x64/lib/ruby/gems/3.4.0/cache is not writable for the Candidate user forge-check: it belongs to the runner (a toolchain or a system folder), which project code may read but not change.',
    "Forge: $RUNNER_TEMP/.setup-beam/otp/erts-15.2/bin/erlexec exists for the runner but is not visible to the Candidate user forge-check: only the checkout, restored caches and toolchain folders of the runner's home are.",
  ]);
  // The Candidate's own checkout is its business, and the readable bin folder is visible.
});

test("a pass needs the CI provider's success; any other conclusion never passes", () => {
  assert.deepEqual(providerVerdict('success'), { status: 'passed' });
  assert.equal(providerVerdict('cancelled').status, 'cancelled');
  for (const conclusion of ['failure', 'timed_out', 'action_required', 'neutral', 'skipped', null]) {
    const verdict = providerVerdict(conclusion);
    assert.equal(verdict.status, 'runner-unavailable', String(conclusion));
    assert.match(verdict.reason, /only with the provider's success/);
  }
  assert.equal(hostedCheckOutputSettled({ status: 'running', actions: { verdictPending: true } }), true);
  assert.equal(hostedCheckOutputSettled({ status: 'running', actions: {} }), false);
});
