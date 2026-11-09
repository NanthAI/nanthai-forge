// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostname } from 'node:os';
import { childEnv } from '../scripts/child-env.mjs';
import { Worker } from 'node:worker_threads';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
  symlinkSync,
  copyFileSync,
  readdirSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeInstall } from '../dist/dependency-seal.js';
import { withCliRuntimeLock, cliProcessIdentity } from '../dist/cli-launcher.js';
import { cliUpdateRun } from '../dist/cli-update.js';
import { cliStartup, cliVersionCheck } from '../dist/cli-version.js';
import { updateCli as updateCliChecked } from '../dist/cli-update.js';
import { testReleaseSigner, trustedDist, withSignedReleases } from './release-trust-fixture.mjs';
import { publishCliBuild } from '../dist/cli-update-install.js';
import {
  cliBuildCommit,
  pruneCliBuilds,
  permitCliRetirement,
  selectCliBuild,
  stableCliRunner,
  withCliLock,
} from '../dist/cli-installation.js';
import { cliLandingCommand, waitForCliMeasurement } from '../dist/cli-measurement-hold.js';
import { migrateEditHookRunner } from '../dist/agent-install-hooks.js';

const a = 'a'.repeat(64),
  b = 'b'.repeat(64);
const address = { url: 'https://synthetic.convex.cloud', projectId: 'forge-source' };
/** Release signatures are required: every update these tests drive is signed with a test key. */
const updateCli = (installation, source, selected, dependencies, ...rest) =>
  updateCliChecked(
    installation,
    source,
    selected,
    withSignedReleases(dependencies, source.projectId),
    ...rest,
  );
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'forge-test-cli-update-')));
  t.after(() => removeInstall(directory));
  const settings = join(directory, 'client.json');
  writeFileSync(settings, JSON.stringify({ localHeavySlots: 0 }));
  const previousSettings = process.env.FORGE_CLIENT_SETTINGS;
  process.env.FORGE_CLIENT_SETTINGS = settings;
  t.after(() => {
    if (previousSettings === undefined) delete process.env.FORGE_CLIENT_SETTINGS;
    else process.env.FORGE_CLIENT_SETTINGS = previousSettings;
  });
  const installation = join(directory, 'forge-cli'),
    home = join(directory, 'home');
  const build = head => {
    const path = join(installation, 'builds', head);
    mkdirSync(join(path, 'dist'), { recursive: true });
    writeFileSync(join(path, '.commit'), head);
    writeFileSync(join(path, '.managed-cli'), '1');
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: '@nanthai/forge', type: 'module' }));
    writeFileSync(join(path, 'dist', 'cli-version.js'), '// synthetic controller capability');
    copyFileSync(new URL('../dist/cli-launcher.js', import.meta.url), join(path, 'dist', 'cli-launcher.js'));
    writeFileSync(join(path, 'dist', 'cli-entry.js'), '// complete');
    writeFileSync(join(path, 'dist', 'agent-edit-hook.js'), '// complete');
    return path;
  };
  const old = build(a);
  selectCliBuild(installation, old);
  for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
    mkdirSync(join(home, file.split('/')[0]), { recursive: true });
    writeFileSync(
      join(home, file),
      JSON.stringify({
        theme: 'synthetic',
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `'node' '${old}/dist/agent-edit-hook.js' '--auto' '--forge-first-write'`,
                },
                { type: 'command', command: 'keep-me' },
              ],
            },
          ],
        },
      }),
    );
  }
  return { directory, installation, home, old, build };
}

test('freshness has exactly one cheap read per process including concurrent callers and failures', async () => {
  let calls = 0;
  const check = cliVersionCheck(),
    current = async () => {
      calls++;
      return { head: b };
    };
  assert.deepEqual(
    await Promise.all(Array.from({ length: 1000 }, () => check(a, current))),
    Array(1000).fill(b),
  );
  assert.equal(calls, 1);
  const failed = cliVersionCheck();
  const unavailable = async () => {
    calls++;
    throw new Error('offline');
  };
  await assert.rejects(failed(a, unavailable), /offline/);
  await assert.rejects(failed(a, unavailable), /offline/);
  assert.equal(calls, 2);
});

test('update then prune keeps both installed hook paths valid and preserves other settings', t => {
  const f = fixture(t),
    next = f.build(b);
  assert.equal(
    stableCliRunner(join(f.old, 'dist', 'agent-edit-hook.js')),
    join(f.installation, 'current', 'dist', 'agent-edit-hook.js'),
  );
  withCliLock(f.installation, () => {
    selectCliBuild(f.installation, next);
    migrateEditHookRunner(join(f.installation, 'current', 'dist', 'agent-edit-hook.js'), f.home);
    permitCliRetirement(f.installation);
    // Pruning takes its own brief fence; nesting it inside the lock fails fast, never waits.
    assert.throws(() => pruneCliBuilds(f.installation, () => [], 0), { code: 'CLI_RUNTIME_LOCK_REENTERED' });
  });
  assert.deepEqual(pruneCliBuilds(f.installation), [a]);
  assert.equal(existsSync(f.old), false);
  for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
    const config = JSON.parse(readFileSync(join(f.home, file)));
    assert.equal(config.theme, 'synthetic');
    const hooks = config.hooks.PreToolUse[0].hooks;
    assert.equal(hooks[1].command, 'keep-me');
    assert.ok(hooks[0].command.includes(join(f.installation, 'current', 'dist', 'agent-edit-hook.js')));
    assert.ok(existsSync(join(f.installation, 'current', 'dist', 'agent-edit-hook.js')));
  }
});

test('a live process retains lazy-load bytes; only a dead lease permits retirement', t => {
  const f = fixture(t);
  mkdirSync(join(f.old, '.users'));
  writeFileSync(join(f.old, '.users', 'live'), JSON.stringify({ pid: process.pid }));
  selectCliBuild(f.installation, f.build(b));
  permitCliRetirement(f.installation);
  assert.deepEqual(pruneCliBuilds(f.installation), []);
  assert.ok(existsSync(join(f.old, 'dist', 'agent-edit-hook.js')));
  rmSync(join(f.old, '.users', 'live'));
  assert.deepEqual(pruneCliBuilds(f.installation), [a]);
});

test('malformed second hook file leaves first unchanged and preserves old runtime', t => {
  const f = fixture(t),
    first = readFileSync(join(f.home, '.claude/settings.json'), 'utf8');
  writeFileSync(join(f.home, '.codex/hooks.json'), '{broken');
  selectCliBuild(f.installation, f.build(b));
  assert.throws(() =>
    migrateEditHookRunner(join(f.installation, 'current', 'dist', 'agent-edit-hook.js'), f.home),
  );
  assert.equal(readFileSync(join(f.home, '.claude/settings.json'), 'utf8'), first);
  assert.ok(existsSync(f.old));
  assert.deepEqual(pruneCliBuilds(f.installation), [], 'process exit cannot prune after failed migration');
});

test('build failure never selects a half-installed current; exact source selected with one call', async t => {
  const f = fixture(t);
  let calls = 0;
  const dependencies = {
    source: {
      current: async () => {
        calls++;
        return { head: b, projectId: address.projectId };
      },
      checkout: async stage => {
        writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: '@nanthai/forge' }));
        writeFileSync(join(stage, 'package-lock.json'), '{}');
      },
    },
    run: async () => {
      throw new Error('synthetic install failure');
    },
    migrate: () => assert.fail('cannot migrate an incomplete build'),
  };
  await assert.rejects(updateCli(f.installation, address, undefined, dependencies), {
    code: 'CLI_UPDATE_DEPENDENCIES_FAILED',
  });
  assert.equal(calls, 1);
  assert.equal(realpathSync(join(f.installation, 'current')), f.old);
  assert.equal(cliBuildCommit(join(f.installation, 'current')), a);
});

test('freeze and concurrent updater refuse explicitly without any release read', async t => {
  const f = fixture(t);
  const dependencies = { source: { current: async () => assert.fail('unexpected read') } };
  writeFileSync(join(f.installation, '.freeze'), 'measurement');
  await assert.rejects(updateCli(f.installation, address, undefined, dependencies), {
    code: 'CLI_UPDATE_FROZEN',
  });
  rmSync(join(f.installation, '.freeze'));
  mkdirSync(join(f.installation, 'update-lock', '1'), { recursive: true });
  writeFileSync(join(f.installation, 'update-lock', '1', 'pid'), String(process.pid));
  await assert.rejects(updateCli(f.installation, address, undefined, dependencies), {
    code: 'CLI_UPDATE_BUSY',
  });
  assert.equal(realpathSync(join(f.installation, 'current')), f.old);
});

test('no-op update does not prune retained builds or rewrite hooks', async t => {
  const f = fixture(t);
  f.build(b);
  const result = await updateCli(
    f.installation,
    address,
    { head: a, projectId: address.projectId },
    { source: {}, migrate: () => assert.fail('no migration') },
  );
  assert.equal(result.status, 'current');
  assert.ok(existsSync(join(f.installation, 'builds', b)));
});

test('legacy build retirement preserves observed users and refuses to guess on inspection failure', t => {
  const f = fixture(t);
  rmSync(join(f.old, '.managed-cli'));
  selectCliBuild(f.installation, f.build(b));
  permitCliRetirement(f.installation);
  assert.deepEqual(
    pruneCliBuilds(f.installation, () => [join(f.old, 'dist', 'cli-entry.js')]),
    [],
  );
  assert.deepEqual(
    pruneCliBuilds(f.installation, () => {
      throw new Error('unsupported');
    }),
    [],
  );
  assert.deepEqual(
    pruneCliBuilds(f.installation, () => []),
    [a],
  );
});

test('a managed CLI without a verifiable release refuses before command dispatch with exact recovery', async t => {
  const f = fixture(t);
  await assert.rejects(cliStartup(['init-native', join(f.directory, 'should-not-exist')], f.old), error => {
    assert.equal(error.code, 'CLI_UPDATE_SOURCE_REQUIRED');
    assert.equal(error.recovery.command, `nforge update '${process.cwd()}' --directory '${f.installation}'`);
    return true;
  });
  assert.equal(existsSync(join(f.directory, 'should-not-exist')), false);
});

test('successful updater builds and smoke-checks before selection, then migrates and prunes', async t => {
  const f = fixture(t);
  const steps = [];
  const dependencies = {
    source: {
      current: async () => ({ head: b, projectId: address.projectId }),
      checkout: async stage => {
        steps.push('checkout');
        writeFileSync(
          join(stage, 'package.json'),
          JSON.stringify({ name: '@nanthai/forge', testIdentity: f.directory }),
        );
        writeFileSync(join(stage, 'package-lock.json'), '{}');
      },
    },
    run: async (cwd, args, home) => {
      assert.equal(realpathSync(join(f.installation, 'current')), f.old);
      if (args[1] === 'ci') {
        steps.push('dependencies');
        assert.ok(args.includes('--ignore-scripts'));
        mkdirSync(join(cwd, 'node_modules'));
      } else if (args[1] === 'run') {
        steps.push('build');
        mkdirSync(join(cwd, 'dist'));
        writeFileSync(join(cwd, 'dist', 'cli-version.js'), '// synthetic controller capability');
        copyFileSync(
          new URL('../dist/cli-launcher.js', import.meta.url),
          join(cwd, 'dist', 'cli-launcher.js'),
        );
        writeFileSync(join(cwd, 'dist', 'cli-entry.js'), '// complete');
        writeFileSync(join(cwd, 'dist', 'agent-edit-hook.js'), '// complete');
      } else {
        steps.push('smoke');
        assert.ok(home.startsWith(cwd + '/.smoke-home-'));
      }
    },
    migrate: runner => {
      steps.push('migrate');
      migrateEditHookRunner(runner, f.home);
    },
  };
  const result = await updateCli(f.installation, address, undefined, dependencies);
  assert.deepEqual(steps, ['checkout', 'dependencies', 'build', 'smoke', 'migrate']);
  assert.equal(result.status, 'updated');
  assert.equal(result.cliCommit, b);
  assert.equal(result.undo, `nforge update --directory '${f.installation}' --state ${a}`);
  // The replaced build is the one retained previous build (canary rollback target): it is exempt
  // from pruning while it is `previous`, and is not marked retired.
  assert.deepEqual(result.removed, []);
  assert.equal(existsSync(join(f.old, '.retired')), false);
  assert.equal(realpathSync(join(f.installation, 'previous')), f.old);
  assert.equal(cliBuildCommit(join(f.installation, 'current')), b);
  assert.deepEqual(
    pruneCliBuilds(f.installation, () => [], 60_000),
    [],
  );
  // Once another build replaces it as previous, the old one retires after the grace and is removed.
  const c = 'c'.repeat(64),
    third = f.build(c);
  publishCliBuild({
    installation: f.installation,
    address,
    head: c,
    build: third,
    expectedCurrent: b,
    migrate: () => {},
  });
  assert.equal(realpathSync(join(f.installation, 'previous')), join(f.installation, 'builds', b));
  assert.ok(existsSync(join(f.old, '.retired')));
  const past = new Date(Date.now() - 120_000);
  utimesSync(join(f.old, '.retired'), past, past);
  assert.deepEqual(
    pruneCliBuilds(f.installation, () => [], 60_000),
    [a],
  );
  assert.equal(existsSync(f.old), false);
});

async function releaseFixture(t, f, head, status) {
  const calls = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(new URL('../scripts/package-cli-release-worker.mjs', import.meta.url), {
    workerData: {
      head,
      projectId: address.projectId,
      calls: calls.buffer,
      status,
      signer: testReleaseSigner(),
    },
  });
  t.after(() => worker.terminate());
  const url = await new Promise((done, reject) => {
    worker.once('message', done);
    worker.once('error', reject);
  });
  writeFileSync(join(f.installation, 'source.json'), JSON.stringify({ url, projectId: address.projectId }));
  const previous = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-cli-test-token';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = previous;
  });
  return calls;
}

test('a one-release-behind installed process under a measurement hold runs on the held build', async t => {
  const f = fixture(t),
    calls = await releaseFixture(t, f, b);
  writeFileSync(join(f.installation, '.freeze'), 'synthetic measurement');
  assert.equal(
    await cliStartup(['init-native', join(f.directory, 'unused')], f.old, cliVersionCheck()),
    true,
  );
  assert.equal(Atomics.load(calls, 0), 1);
  assert.equal(cliBuildCommit(join(f.installation, 'current')), a);
  // Only an explicit historical rollback, which must restore main before a write, still refuses.
  writeFileSync(join(f.installation, 'rollback.json'), JSON.stringify({ head: a }));
  await assert.rejects(
    cliStartup(['init-native', join(f.directory, 'never-created')], f.old, cliVersionCheck()),
    error => {
      assert.equal(error.code, 'CLI_UPDATE_FROZEN');
      assert.ok(error.message.includes(`nforge update --directory '${f.installation}'`));
      return true;
    },
  );
  assert.equal(existsSync(join(f.directory, 'never-created')), false);
  assert.equal(cliBuildCommit(join(f.installation, 'current')), a);
});

test('a current installed process reuses its freshness receipt with zero idle calls', async t => {
  const f = fixture(t),
    calls = await releaseFixture(t, f, a),
    check = cliVersionCheck();
  assert.equal(await cliStartup(['--help'], f.old, check), true);
  assert.equal(Atomics.load(calls, 0), 0);
  assert.equal(await cliStartup(['--version'], f.old, check), true);
  assert.equal(await cliStartup(['init-native', join(f.directory, 'unused')], f.old, check), true);
  assert.equal(await cliStartup(['init-native', join(f.directory, 'unused')], f.old, check), true);
  await new Promise(done => setImmediate(done));
  assert.equal(Atomics.load(calls, 0), 1);
});

test('installed help and targeted argument errors make zero release or work calls; valid work stays gated', async t => {
  const f = fixture(t),
    calls = await releaseFixture(t, f, a),
    check = cliVersionCheck();
  const { agentCli } = await import('../dist/agent-cli.js');
  const { heavyCli } = await import('../dist/heavy-slots.js');
  const { hostedPullCli } = await import('../dist/hosted-pull-cli.js');
  const { clientCacheRoot } = await import('../dist/root-paths.js');
  const root = join(f.directory, 'checkout'),
    unaddressed = join(f.directory, 'unaddressed');
  mkdirSync(root);
  mkdirSync(unaddressed);
  mkdirSync(join(clientCacheRoot(root), 'agent'), { recursive: true });
  writeFileSync(
    join(clientCacheRoot(root), 'agent/address.json'),
    JSON.stringify({ url: 'https://fixture.invalid', projectId: 'project' }),
  );
  t.mock.method(process.stdout, 'write', () => true);
  const invoke = async (args, gate) => {
    assert.equal(await cliStartup(args, f.old, check), true);
    const before = gate ?? (() => cliStartup(args, f.old, check, { validated: true }));
    if (args[0] === 'agent') return agentCli(args.slice(1), { beforeDispatch: before });
    if (args[0] === 'heavy') return heavyCli(args.slice(1), before);
    if (args[0] === 'pull') return hostedPullCli(args.slice(1), before);
  };
  for (const args of [
    ['agent', root, '--help'],
    ['agent', root, 'lanes', '--help'],
    ['heavy'],
    ['heavy', '--help'],
    ['heavy', '-h'],
    ['heavy', '--status'],
    ['pull', '--help'],
  ])
    await invoke(args);
  for (const args of [
    ['agent', unaddressed, 'planning', '{}'],
    ['agent', root, 'lanes', '{"limit":0}'],
    ['agent', root, 'friction', '{"title":3}'],
    ['agent', root, 'friction', '{'],
    ['heavy', '--unknown'],
    ['heavy', '--status', 'extra'],
    ['pull', root, 'extra'],
  ])
    await assert.rejects(invoke(args), error =>
      ['BAD_ARGUMENT', 'FORGE_ROOT_UNAVAILABLE'].includes(error.code),
    );
  assert.equal(Atomics.load(calls, 0), 0);
  let gates = 0;
  const stopAfterFreshness = async () => {
    gates++;
    assert.equal(await cliStartup(['agent', root, 'lanes'], f.old, check, { validated: true }), true);
    return false; // A redispatched process handles the valid command instead.
  };
  await invoke(['agent', root, 'lanes', '{}'], stopAfterFreshness);
  const output = join(f.directory, 'never-executed');
  await invoke(
    ['heavy', process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1], "ran")', output],
    stopAfterFreshness,
  );
  assert.equal(gates, 2);
  assert.equal(Atomics.load(calls, 0), 1);
  assert.equal(existsSync(output), false);
});

test('freshness redispatch preserves stdin already consumed by local argument validation', async t => {
  const f = fixture(t);
  await releaseFixture(t, f, b);
  // A write installs in the foreground (and re-runs itself) only after a failed background install.
  writeFileSync(
    join(f.installation, 'update-failed.json'),
    JSON.stringify({ code: 'CLI_UPDATE_BUILD_FAILED' }),
  );
  const next = f.build(b),
    output = join(f.directory, 'replayed-input');
  writeFileSync(
    join(next, 'dist/cli-entry.js'),
    `import { readFileSync, writeFileSync } from 'node:fs';
if (process.env.FORGE_CLI_CANARY) { process.stdout.write('nforge version synthetic\\n'); process.exit(0); }
writeFileSync(${JSON.stringify(output)}, readFileSync(0));`,
  );
  const payload = JSON.stringify({ title: "Synthetic quote's", detail: 'first\nsecond', area: 'checks' });
  const code = `
    import { readFileSync } from 'node:fs';
    const { cliStartup } = await import(${JSON.stringify(trustedDist().url('cli-version.js'))});
    const stdin = readFileSync(0, 'utf8');
    const run = await cliStartup(['agent', ${JSON.stringify(f.directory)}, 'friction', '--command-file', '-'], ${JSON.stringify(f.old)}, undefined, { validated: true, stdin });
    process.stdout.write(JSON.stringify({ run }));
  `;
  const reply = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    input: payload,
    encoding: 'utf8',
    env: childEnv({
      extra: {
        HOME: f.home,
        XDG_CONFIG_HOME: join(f.home, '.config'),
        FORGE_CLIENT_SETTINGS: process.env.FORGE_CLIENT_SETTINGS,
        FORGE_AUTH_TOKEN: 'synthetic-cli-test-token',
      },
    }),
  });
  assert.equal(reply.status, 0, reply.stderr);
  assert.deepEqual(JSON.parse(reply.stdout), { run: false });
  assert.equal(readFileSync(output, 'utf8'), payload);
});

test('canonical path aliases never allow pruning the selected current build', t => {
  const f = fixture(t);
  const next = f.build(b);
  selectCliBuild(f.installation, next);
  permitCliRetirement(f.installation);
  const alias = join(f.directory, 'installation-alias');
  symlinkSync(f.installation, alias, 'dir');
  assert.deepEqual(
    pruneCliBuilds(alias, () => []),
    [a],
  );
  assert.equal(realpathSync(join(f.installation, 'current')), next);
  assert.ok(existsSync(join(next, 'dist', 'cli-entry.js')));
});

test('measurement landing waits on local removal before making the one version read', async t => {
  const f = fixture(t),
    calls = await releaseFixture(t, f, a);
  const hold = join(f.installation, '.freeze');
  writeFileSync(hold, 'measurement');
  assert.equal(await cliStartup(['agent', '.', 'land'], f.old, cliVersionCheck()), true);
  const pending = cliStartup(['agent', '.', 'land'], f.old, cliVersionCheck(), { validated: true });
  await new Promise(done => setImmediate(done));
  assert.equal(Atomics.load(calls, 0), 0);
  rmSync(hold);
  assert.equal(await pending, true);
  assert.equal(Atomics.load(calls, 0), 1);
  assert.equal(cliLandingCommand(['agent', '.', 'status', '{"message":"land"}']), false);
});

test('cancelling a measurement hold releases the watcher without dispatching or removing the hold', async t => {
  const f = fixture(t),
    controller = new AbortController();
  writeFileSync(join(f.installation, '.freeze'), 'measurement');
  const pending = waitForCliMeasurement(f.installation, controller.signal);
  controller.abort();
  await assert.rejects(pending, { code: 'CLI_MEASUREMENT_WAIT_CANCELLED' });
  assert.ok(existsSync(join(f.installation, '.freeze')));
});

test('unleased legacy processes launched through current protect every possible old runtime', t => {
  const f = fixture(t);
  rmSync(join(f.old, '.managed-cli'));
  selectCliBuild(f.installation, f.build(b));
  permitCliRetirement(f.installation);
  assert.deepEqual(
    pruneCliBuilds(f.installation, () => [
      { pid: 123456789, path: join(f.installation, 'current', 'dist', 'cli-entry.js') },
    ]),
    [],
  );
  assert.ok(existsSync(f.old));
  assert.deepEqual(
    pruneCliBuilds(f.installation, () => []),
    [a],
  );
});

test('native and hosted agent receipt envelopes name the executing CLI build', async t => {
  const f = fixture(t);
  const { initNative } = await import('../dist/native-work.js');
  const { AgentWorkflow } = await import('../dist/agent-workflow.js');
  const root = join(f.directory, 'native');
  mkdirSync(root);
  writeFileSync(join(root, 'source.txt'), 'synthetic');
  initNative(root);
  const response = await new AgentWorkflow(root).dispatch({ action: 'status' });
  assert.equal(response.cliCommit, cliBuildCommit());
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const hosted = agentFixture(t);
  assert.equal((await hosted.transport().dispatch('capabilities', {})).cliCommit, cliBuildCommit());
});

test('a failing release service gets exactly one HTTP attempt and cached typed refusal', async t => {
  const f = fixture(t),
    calls = await releaseFixture(t, f, b, 503),
    check = cliVersionCheck();
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      cliStartup(['init-native', join(f.directory, 'never-created')], f.old, check),
      error => {
        assert.equal(error.code, 'CLI_UPDATE_REQUIRED');
        assert.equal(error.recovery.command, `nforge update --directory '${f.installation}'`);
        return true;
      },
    );
  assert.equal(Atomics.load(calls, 0), 1);
  assert.equal(existsSync(join(f.directory, 'never-created')), false);
});

test('missing authentication gives an executable updater sign-in recovery without running the command', async t => {
  const f = fixture(t);
  writeFileSync(join(f.installation, 'source.json'), JSON.stringify(address));
  const previous = process.env.FORGE_AUTH_TOKEN;
  delete process.env.FORGE_AUTH_TOKEN;
  t.after(() => {
    if (previous !== undefined) process.env.FORGE_AUTH_TOKEN = previous;
  });
  await assert.rejects(
    cliStartup(['init-native', join(f.directory, 'never-created')], f.old, cliVersionCheck()),
    error => {
      assert.equal(error.code, 'CLI_UPDATE_REQUIRED');
      assert.equal(error.recovery.command, `nforge update --directory '${f.installation}' --login`);
      return true;
    },
  );
  assert.equal(existsSync(join(f.directory, 'never-created')), false);
});

function launcherEnv(f) {
  return childEnv({
    allow: ['FORGE_CLIENT_SETTINGS', 'XDG_CONFIG_HOME'],
    extra: {
      HOME: f.home,
      USERPROFILE: f.home,
      FORGE_TEST_MODE: '1',
      FORGE_AUTH_TOKEN: 'synthetic-launcher-token',
    },
  });
}
function controllerEntry(root, text = 'main-ran') {
  const startup = trustedDist().url('cli-version.js');
  writeFileSync(
    join(root, 'dist', 'cli-entry.js'),
    `import { cliStartup } from ${JSON.stringify(startup)};
if (await cliStartup(process.argv.slice(2), ${JSON.stringify(root)})) process.stdout.write(${JSON.stringify(text + '\n')});
`,
  );
}
function installLauncher(f, manager) {
  selectCliBuild(f.installation, manager, 'manager');
  copyFileSync(new URL('../dist/cli-launcher.js', import.meta.url), join(f.installation, 'launcher.mjs'));
}

test('stable launcher refuses a gate-less historical runtime instead of executing its old entry', async t => {
  const f = fixture(t),
    main = f.build(b),
    calls = await releaseFixture(t, f, b);
  controllerEntry(main);
  installLauncher(f, main);
  rmSync(join(f.old, 'dist', 'cli-version.js'));
  writeFileSync(join(f.old, 'dist', 'cli-entry.js'), 'process.stdout.write("OLD-CODE-RAN");');
  writeFileSync(join(f.installation, 'rollback.json'), JSON.stringify({ head: a }));
  writeFileSync(join(f.installation, '.freeze'), 'measurement');
  const reply = spawnSync(process.execPath, [join(f.installation, 'launcher.mjs'), '--version'], {
    env: launcherEnv(f),
    encoding: 'utf8',
  });
  assert.equal(reply.status, 1, reply.stderr);
  assert.equal(reply.stdout, '');
  assert.equal(JSON.parse(reply.stderr).error.code, 'CLI_UPDATE_FROZEN');
  assert.equal(Atomics.load(calls, 0), 1);
});

test('historical selection restores a complete main build before dispatch, with one release query', async t => {
  const f = fixture(t),
    main = f.build(b),
    calls = await releaseFixture(t, f, b);
  controllerEntry(main);
  installLauncher(f, main);
  rmSync(join(f.old, 'dist', 'cli-version.js'));
  writeFileSync(join(f.old, 'dist', 'cli-entry.js'), 'process.stdout.write("OLD-CODE-RAN");');
  writeFileSync(join(f.installation, 'rollback.json'), JSON.stringify({ head: a }));
  const reply = spawnSync(process.execPath, [join(f.installation, 'launcher.mjs'), '--version'], {
    env: launcherEnv(f),
    encoding: 'utf8',
  });
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(reply.stdout, 'main-ran\n');
  assert.equal(Atomics.load(calls, 0), 1);
  assert.equal(cliBuildCommit(join(f.installation, 'current')), b);
  assert.equal(realpathSync(join(f.installation, 'manager')), main);
  assert.equal(existsSync(join(f.installation, 'rollback.json')), false);
  assert.equal(
    realpathSync(join(f.installation, 'previous')),
    f.old,
    'historical build is the retained previous',
  );
});

test('bootstrap leases the manager before its first imported module can race retirement', t => {
  const f = fixture(t),
    manager = f.build(b),
    next = f.build('c'.repeat(64));
  selectCliBuild(f.installation, manager);
  installLauncher(f, manager);
  const module = pathToFileURL(fileURLToPath(new URL('../dist/cli-installation.js', import.meta.url))).href;
  writeFileSync(join(manager, 'dist', 'lazy.js'), 'export const value = "preserved";');
  writeFileSync(
    join(manager, 'dist', 'cli-entry.js'),
    `import assert from 'node:assert/strict';
import { selectCliBuild, permitCliRetirement, pruneCliBuilds } from ${JSON.stringify(module)};
const root=${JSON.stringify(f.installation)}, next=${JSON.stringify(next)};
selectCliBuild(root,next); selectCliBuild(root,next,'manager'); permitCliRetirement(root);
assert.deepEqual(pruneCliBuilds(root,()=>[]), [${JSON.stringify(a)}]);
assert.equal((await import('./lazy.js')).value, 'preserved');
process.stdout.write('lease-before-import');`,
  );
  const reply = spawnSync(process.execPath, [join(f.installation, 'launcher.mjs')], {
    env: launcherEnv(f),
    encoding: 'utf8',
  });
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(reply.stdout, 'lease-before-import');
  assert.ok(existsSync(manager));
  assert.deepEqual(
    pruneCliBuilds(f.installation, () => []),
    [b],
  );
});

test('detached workers protect managed runtime bytes even without a CLI lease', t => {
  const f = fixture(t),
    next = f.build(b);
  selectCliBuild(f.installation, next);
  permitCliRetirement(f.installation);
  assert.deepEqual(
    pruneCliBuilds(f.installation, () => [
      { pid: 123456789, path: join(f.old, 'dist', 'check-controller-worker.js') },
    ]),
    [],
  );
  assert.deepEqual(
    pruneCliBuilds(f.installation, () => []),
    [a],
  );
});

test('runtime lock publishes complete owner metadata and recovers only a dead holder', t => {
  const f = fixture(t),
    lock = join(f.installation, 'runtime.lock');
  withCliRuntimeLock(f.installation, () => {
    const owner = JSON.parse(readFileSync(lock));
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.startTime, cliProcessIdentity().startTime);
    // Re-entry from the holding process is reported at once (it could only time out waiting).
    assert.throws(() => withCliRuntimeLock(f.installation, () => assert.fail(), 10_000), {
      code: 'CLI_RUNTIME_LOCK_REENTERED',
    });
    assert.equal(JSON.parse(readFileSync(lock)).pid, process.pid);
  });
  writeFileSync(lock, JSON.stringify({ pid: 2147483647, host: hostname(), startTime: 'dead' }));
  assert.equal(
    withCliRuntimeLock(f.installation, () => 'recovered'),
    'recovered',
  );
  assert.equal(existsSync(lock), false);
  assert.deepEqual(
    readdirSync(f.installation).filter(name => name.endsWith('.pending')),
    [],
  );
});

test('a newer concurrent current is preserved rather than replaced from an earlier release read', async t => {
  const f = fixture(t),
    next = f.build(b),
    newer = f.build('c'.repeat(64));
  selectCliBuild(f.installation, newer);
  const dependencies = { source: {}, migrate: () => assert.fail('no migration on a stale selection') };
  await assert.rejects(
    updateCli(f.installation, address, { head: b, projectId: address.projectId }, dependencies, {
      expectedCurrent: a,
    }),
    { code: 'CLI_UPDATE_CHANGED' },
  );
  assert.equal(realpathSync(join(f.installation, 'current')), newer);
  assert.ok(existsSync(next));
});

test('busy runtime bookkeeping makes installed first-write hooks fail open', t => {
  const f = fixture(t);
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  for (const file of readdirSync(dist).filter(
    name => name.startsWith('agent-edit-hook') && name.endsWith('.js'),
  ))
    copyFileSync(join(dist, file), join(f.old, 'dist', file));
  withCliRuntimeLock(f.installation, () => {
    const reply = spawnSync(
      process.execPath,
      [join(f.old, 'dist', 'agent-edit-hook.js'), '--auto', '--forge-first-write'],
      { input: '{}', env: launcherEnv(f), encoding: 'utf8' },
    );
    assert.equal(reply.status, 0, reply.stderr);
    const output = JSON.parse(reply.stdout);
    assert.equal(output.hookSpecificOutput?.permissionDecision, undefined);
    assert.ok(reply.stderr.includes('edit-hook-fail-open'));
  });
});

test('explicit rollback preserves the main controller even when the older target has its own gate', async t => {
  const f = fixture(t),
    main = f.build(b),
    calls = await releaseFixture(t, f, b);
  controllerEntry(main);
  controllerEntry(f.old, 'OLDER-CONTROLLER-RAN');
  selectCliBuild(f.installation, main);
  installLauncher(f, main);
  const selectedAddress = JSON.parse(readFileSync(join(f.installation, 'source.json')));
  const result = await updateCli(
    f.installation,
    selectedAddress,
    { head: a, projectId: address.projectId },
    {
      source: {},
      migrate: runner => migrateEditHookRunner(runner, f.home),
    },
    { rollback: true },
  );
  assert.equal(result.cliCommit, a);
  assert.equal(realpathSync(join(f.installation, 'manager')), main);
  assert.ok(existsSync(main));
  const reply = spawnSync(process.execPath, [join(f.installation, 'launcher.mjs'), '--version'], {
    env: launcherEnv(f),
    encoding: 'utf8',
  });
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(reply.stdout, 'main-ran\n');
  assert.equal(Atomics.load(calls, 0), 1);
  assert.equal(cliBuildCommit(join(f.installation, 'current')), b);
});

test('an already-installed main repairs an older controller without rebuilding or no-op garbage collection', async t => {
  const f = fixture(t),
    main = f.build(b);
  installLauncher(f, f.old);
  selectCliBuild(f.installation, main);
  const result = await updateCli(
    f.installation,
    address,
    { head: b, projectId: address.projectId },
    { source: {}, run: () => assert.fail('no rebuild'), migrate: () => assert.fail('no migration') },
  );
  assert.equal(result.status, 'current');
  assert.equal(realpathSync(join(f.installation, 'manager')), main);
  assert.ok(existsSync(f.old), 'no-op repair never collects a retired build');
});

// --- Forced update is cheap and invisible (Issue 458a476b) -------------------------------------

/** Run the stable launcher asynchronously; resolves with status, stdout and stderr. */
function launch(f, args = ['--version'], onStderr = () => {}) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(f.installation, 'launcher.mjs'), ...args], {
      env: launcherEnv(f),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => {
      stderr += chunk;
      onStderr(stderr);
    });
    child.once('error', reject);
    child.once('exit', status => done({ status, stdout, stderr }));
  });
}
/** Old installed controller `a`, prestaged main `b` whose entry prints one JSON document. */
async function pendingUpdate(t, f) {
  const calls = await releaseFixture(t, f, b);
  controllerEntry(f.old, 'old-ran');
  installLauncher(f, f.old);
  const main = f.build(b);
  const startup = trustedDist().url('cli-version.js');
  writeFileSync(
    join(main, 'dist', 'cli-entry.js'),
    `import { cliStartup } from ${JSON.stringify(startup)};
if (await cliStartup(process.argv.slice(2), ${JSON.stringify(main)})) process.stdout.write(JSON.stringify({ ok: true, ran: process.argv.slice(2) }) + '\\n');
`,
  );
  return { calls, main };
}
const refusals = /CLI_UPDATE_REQUIRED|CLI_UPDATE_SOURCE_REQUIRED|CLI_UPDATE_BUSY|CLI_RUNTIME_BUSY/;

test('a write after a failed background install installs in the foreground: one JSON document, runs once', async t => {
  const f = fixture(t),
    { main } = await pendingUpdate(t, f);
  writeFileSync(
    join(f.installation, 'update-failed.json'),
    JSON.stringify({ code: 'CLI_UPDATE_BUILD_FAILED' }),
  );
  const reply = await launch(f, ['save', '--json']);
  assert.equal(reply.status, 0, reply.stderr);
  assert.deepEqual(JSON.parse(reply.stdout), { ok: true, ran: ['save', '--json'] });
  assert.equal(reply.stdout.trim().split('\n').length, 1);
  assert.match(reply.stderr, /behind main bbbbbbbb; installing it, then running your command/);
  assert.match(reply.stderr, /Forge CLI selected b{64}\./);
  assert.doesNotMatch(reply.stderr, /Usage|usage:|nforge \w+ <git-worktree-root>|vite|tsc/);
  assert.doesNotMatch(reply.stderr, refusals);
  assert.equal(cliBuildCommit(join(f.installation, 'current')), b);
  assert.ok(existsSync(main));
  assert.equal(existsSync(join(f.installation, 'update-failed.json')), false, 'success clears the mark');
});

test('incident replay 2a0557b6: two parallel writes during an update both run at once on the working build, never waiting', async t => {
  const f = fixture(t),
    { calls } = await pendingUpdate(t, f);
  // A live updater (this process) holds the update lock, as a detached updater in its canary does.
  const held = join(f.installation, 'update-lock', '1');
  mkdirSync(held, { recursive: true });
  writeFileSync(join(held, 'pid'), String(process.pid));
  const started = Date.now();
  const [one, two] = await Promise.all([launch(f, ['save', '--one']), launch(f, ['save', '--two'])]);
  for (const reply of [one, two]) {
    assert.equal(reply.status, 0, reply.stderr);
    assert.equal(reply.stdout, 'old-ran\n');
    assert.match(reply.stderr, /main bbbbbbbb is installing \(already running\); this write ran on aaaaaaaa/);
    assert.doesNotMatch(reply.stderr, /waiting for it/);
    assert.doesNotMatch(reply.stderr, refusals);
  }
  // The lock was never released: both returned while the updater still ran.
  assert.ok(existsSync(held));
  assert.ok(Date.now() - started < 20_000);
  assert.equal(cliBuildCommit(join(f.installation, 'current')), a);
  assert.equal(Atomics.load(calls, 0), 2, 'one release read per command, no added calls');
  rmSync(join(f.installation, 'update-lock'), { recursive: true, force: true });
});

test('a runtime-lock holder is waited for by commands and the updater, but never by hooks', async t => {
  const f = fixture(t);
  mkdirSync(f.installation, { recursive: true });
  const module = pathToFileURL(fileURLToPath(new URL('../dist/cli-launcher.js', import.meta.url))).href;
  const holder = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { withCliRuntimeLock } from ${JSON.stringify(module)};
withCliRuntimeLock(${JSON.stringify(f.installation)}, () => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600); });`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.after(() => holder.kill());
  await new Promise(done => holder.stdout.once('data', done));
  assert.throws(() => withCliRuntimeLock(f.installation, () => assert.fail()), { code: 'CLI_RUNTIME_BUSY' });
  assert.equal(
    withCliRuntimeLock(f.installation, () => 'ran after the holder finished', 10_000),
    'ran after the holder finished',
  );
  assert.equal(existsSync(join(f.installation, 'runtime.lock')), false);
});

test('a concurrent updater is waited for and the waiter continues from what it installed', async t => {
  const f = fixture(t),
    newest = f.build(b);
  const held = join(f.installation, 'update-lock', '1');
  mkdirSync(held, { recursive: true });
  writeFileSync(join(held, 'pid'), String(process.pid));
  const dependencies = {
    source: { current: async () => ({ head: b, projectId: address.projectId }) },
    migrate: () => {},
  };
  const waiting = updateCli(
    f.installation,
    address,
    { head: b, projectId: address.projectId },
    dependencies,
    {
      lockWaitMs: 10_000,
    },
  );
  setTimeout(() => {
    selectCliBuild(f.installation, newest);
    rmSync(join(f.installation, 'update-lock'), { recursive: true, force: true });
  }, 300);
  const result = await waiting;
  assert.equal(result.status, 'current');
  assert.equal(result.cliCommit, b);
  // Without a wait budget the same situation still refuses explicitly.
  mkdirSync(held, { recursive: true });
  writeFileSync(join(held, 'pid'), String(process.pid));
  await assert.rejects(updateCli(f.installation, address, undefined, dependencies), {
    code: 'CLI_UPDATE_BUSY',
  });
});

test('update build output never reaches stdout and appears on stderr only when a step fails', t => {
  const f = fixture(t);
  const module = pathToFileURL(fileURLToPath(new URL('../dist/cli-update.js', import.meta.url))).href;
  const noisy =
    'process.stdout.write("tsc listing\\n"); process.stderr.write("vite chunk\\n"); process.stdout.write("Usage: nforge help\\n");';
  const run = body =>
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { cliUpdateRun } from ${JSON.stringify(module)};
try { await cliUpdateRun(${JSON.stringify(f.directory)}, [process.execPath, '-e', ${JSON.stringify(body)}]); } catch (error) { process.exitCode = 7; process.stderr.write('code=' + error.code + '\\n'); }`,
      ],
      { env: launcherEnv(f), encoding: 'utf8' },
    );
  const ok = run(noisy);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '');
  assert.equal(ok.stderr, '');
  const failed = run(`${noisy} process.exit(3)`);
  assert.equal(failed.status, 7);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /vite chunk/);
  assert.match(failed.stderr, /code=CLI_UPDATE_BUILD_FAILED/);
});

test('a forced update is never queued behind machine-wide heavy slots', async t => {
  const f = fixture(t),
    slots = join(f.directory, 'slots'),
    cache = join(f.directory, 'cache');
  writeFileSync(join(f.directory, 'client.json'), JSON.stringify({ localHeavySlots: 1 }));
  mkdirSync(join(slots, '1'), { recursive: true });
  writeFileSync(join(slots, '1', 'pid'), String(process.pid));
  const previous = { slots: process.env.FORGE_HEAVY_DIR, cache: process.env.XDG_CACHE_HOME };
  process.env.FORGE_HEAVY_DIR = slots;
  process.env.XDG_CACHE_HOME = cache;
  t.after(() => {
    for (const [name, value] of [
      ['FORGE_HEAVY_DIR', previous.slots],
      ['XDG_CACHE_HOME', previous.cache],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  const dependencies = {
    source: {
      current: async () => ({ head: b, projectId: address.projectId }),
      checkout: async stage => {
        writeFileSync(
          join(stage, 'package.json'),
          JSON.stringify({ name: '@nanthai/forge', testIdentity: f.directory }),
        );
        writeFileSync(join(stage, 'package-lock.json'), '{}');
      },
    },
    run: async (cwd, args) => {
      if (args[1] === 'ci') mkdirSync(join(cwd, 'node_modules'));
      else if (args[1] === 'run') {
        mkdirSync(join(cwd, 'dist'));
        for (const name of ['cli-version.js', 'cli-launcher.js', 'cli-entry.js', 'agent-edit-hook.js'])
          writeFileSync(join(cwd, 'dist', name), '// synthetic');
      }
    },
    migrate: () => {},
  };
  const result = await Promise.race([
    updateCli(f.installation, address, undefined, dependencies),
    new Promise((_, reject) => setTimeout(() => reject(new Error('queued behind heavy slots')), 20_000)),
  ]);
  assert.equal(result.status, 'updated');
  assert.equal(readFileSync(join(slots, '1', 'pid'), 'utf8'), String(process.pid), 'foreign slot untouched');
});

// Concurrency during an update (7af26482): many agents share one installed CLI.
function gatedEntry(root, name) {
  const startup = trustedDist().url('cli-version.js');
  writeFileSync(
    join(root, 'dist', 'cli-entry.js'),
    `import { cliStartup } from ${JSON.stringify(startup)};
if (await cliStartup(process.argv.slice(2), ${JSON.stringify(root)}, undefined, { validated: true }))
  process.stdout.write(JSON.stringify({ build: ${JSON.stringify(name)}, ran: process.argv.slice(2) }) + '\\n');
`,
  );
}
function holdUpdate(f) {
  const held = join(f.installation, 'update-lock', '1');
  mkdirSync(held, { recursive: true });
  writeFileSync(join(held, 'pid'), String(process.pid));
  return () => rmSync(join(f.installation, 'update-lock'), { recursive: true, force: true });
}
async function until(condition, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise(done => setTimeout(done, 25));
  }
}

test('12 concurrent calls during an update: reads and writes run on the current build at once, none refused or waiting, one release read each', async t => {
  const f = fixture(t),
    calls = await releaseFixture(t, f, b),
    main = f.build(b),
    d = f.directory;
  gatedEntry(f.old, 'current');
  gatedEntry(main, 'main');
  installLauncher(f, f.old);
  const release = holdUpdate(f);
  const reads = [
    ['agent', d, 'status'],
    ['agent', d, 'planning', '{}'],
    ['agent', d, 'wait', '{}'],
    ['agent', d, 'peers'],
    ['status'],
    ['wait', 'synthetic'],
  ];
  const writes = [
    ['agent', d, 'save'],
    ['agent', d, 'land'],
    ['agent', d, 'start'],
    ['agent', d, 'put-planning-item'],
    ['agent', d, 'comment-planning-item'],
    ['land', d],
  ];
  // All finish while the install is still running: no command waits for it or its canary.
  const all = [...reads, ...writes];
  const replies = await Promise.all(all.map(args => launch(f, args)));
  replies.forEach((reply, index) => {
    const kind = index < reads.length ? 'read' : 'write';
    assert.equal(reply.status, 0, reply.stderr);
    assert.deepEqual(JSON.parse(reply.stdout), { build: 'current', ran: all[index] });
    assert.equal(reply.stdout.trim().split('\n').length, 1);
    assert.match(
      reply.stderr,
      new RegExp(`main bbbbbbbb is installing \\(already running\\); this ${kind} ran on aaaaaaaa`),
    );
    assert.doesNotMatch(reply.stderr, /waiting for it/);
    assert.doesNotMatch(reply.stderr, refusals);
  });
  assert.equal(cliBuildCommit(join(f.installation, 'current')), a);
  // One release read per CLI call; running on the current build adds none.
  assert.equal(Atomics.load(calls, 0), all.length);
  release();
  // Once the updater has switched, the next write runs on main.
  const { publishCliBuild } = await import('../dist/cli-update-install.js');
  publishCliBuild({
    installation: f.installation,
    address: readCliSourceFile(f),
    head: b,
    build: main,
    expectedCurrent: a,
    migrate: () => {},
  });
  const next = await launch(f, ['agent', d, 'save']);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).build, 'main');
  assert.ok(existsSync(f.old), 'replaced build stays during the retirement grace');
});
function readCliSourceFile(f) {
  return JSON.parse(readFileSync(join(f.installation, 'source.json'), 'utf8'));
}

test('a read with no updater running starts one detached install and returns at once', async t => {
  const f = fixture(t),
    calls = await releaseFixture(t, f, b),
    main = f.build(b);
  gatedEntry(f.old, 'current');
  gatedEntry(main, 'main');
  installLauncher(f, f.old);
  const reply = await launch(f, ['agent', f.directory, 'status']);
  assert.equal(reply.status, 0, reply.stderr);
  assert.deepEqual(JSON.parse(reply.stdout), { build: 'current', ran: ['agent', f.directory, 'status'] });
  assert.match(reply.stderr, /main bbbbbbbb is installing; this read ran on aaaaaaaa/);
  await until(
    () =>
      cliBuildCommit(join(f.installation, 'current')) === b &&
      !existsSync(join(f.installation, 'update-lock', '1')),
    'the background install',
  );
  assert.equal(realpathSync(join(f.installation, 'manager')), main);
  // The read's own check plus the updater's single read; the updater takes its lock first.
  assert.equal(Atomics.load(calls, 0), 2);
  const next = await launch(f, ['agent', f.directory, 'save']);
  assert.equal(next.status, 0, next.stderr);
  assert.equal(JSON.parse(next.stdout).build, 'main');
  // A late background updater for a head already selected finishes with zero release reads.
  const { cliUpdateCli } = await import('../dist/cli-update.js');
  const before = Atomics.load(calls, 0);
  const late = await cliUpdateCli(['--background', '--release-head', b, '--directory', f.installation]);
  assert.equal(late.status, 'current');
  assert.equal(Atomics.load(calls, 0), before);
});

test('a failed background install is not retried by every read within the retry window', async t => {
  const f = fixture(t);
  await releaseFixture(t, f, b);
  gatedEntry(f.old, 'current');
  gatedEntry(f.build(b), 'main');
  installLauncher(f, f.old);
  writeFileSync(
    join(f.installation, 'update-failed.json'),
    JSON.stringify({ code: 'CLI_UPDATE_BUILD_FAILED' }),
  );
  const reply = await launch(f, ['status']);
  assert.equal(reply.status, 0, reply.stderr);
  assert.match(
    reply.stderr,
    /main bbbbbbbb last install failed .*update\.log\); the next write retries it; this read ran on aaaaaaaa/,
  );
  assert.equal(existsSync(join(f.installation, 'update.log')), false, 'no background updater started');
  // After the retry window a read starts one again.
  const past = new Date(Date.now() - 11 * 60_000);
  utimesSync(join(f.installation, 'update-failed.json'), past, past);
  const later = await launch(f, ['status']);
  assert.match(later.stderr, /main bbbbbbbb is installing; this read ran on aaaaaaaa/);
  await until(
    () =>
      cliBuildCommit(join(f.installation, 'current')) === b &&
      !existsSync(join(f.installation, 'update-lock', '1')),
    'the background install',
  );
  assert.equal(existsSync(join(f.installation, 'update-failed.json')), false, 'success clears the mark');
});

test('an updater killed mid-install leaves the previous build selected and working; the next update cleans up', async t => {
  const f = fixture(t),
    cache = join(f.directory, 'cache');
  await releaseFixture(t, f, a);
  gatedEntry(f.old, 'current');
  installLauncher(f, f.old);
  const module = pathToFileURL(fileURLToPath(new URL('../dist/cli-update.js', import.meta.url))).href;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { updateCli } from ${JSON.stringify(module)};
import { withSignedReleases } from ${JSON.stringify(new URL('./release-trust-fixture.mjs', import.meta.url).href)};
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
setInterval(() => {}, 1000);
const release = { head: ${JSON.stringify(b)}, projectId: ${JSON.stringify(address.projectId)} };
await updateCli(${JSON.stringify(f.installation)}, ${JSON.stringify(readCliSourceFile(f))}, release, withSignedReleases({
  source: {
    current: async () => release,
    checkout: async stage => {
      writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: '@nanthai/forge' }));
      writeFileSync(join(stage, 'package-lock.json'), '{}');
    },
  },
  run: async (cwd, args) => {
    if (args[1] === 'ci') return mkdirSync(join(cwd, 'node_modules'));
    mkdirSync(join(cwd, 'dist'), { recursive: true });
    writeFileSync(join(cwd, 'dist', 'cli-entry.js'), '// half-built');
    process.stdout.write('building\\n');
    await new Promise(() => {});
  },
  migrate: () => {},
}, release.projectId), { expectedCurrent: ${JSON.stringify(a)} });`,
    ],
    { env: { ...launcherEnv(f), XDG_CACHE_HOME: cache }, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.after(() => child.kill('SIGKILL'));
  await new Promise((done, reject) => {
    child.stdout.once('data', done);
    child.once('exit', code => reject(new Error(`updater exited (${code}) before building`)));
  });
  child.kill('SIGKILL');
  await new Promise(done => child.once('exit', done));
  const stages = () =>
    readdirSync(join(f.installation, 'builds')).filter(name => name.startsWith('.install-'));
  assert.equal(stages().length, 1, 'the crash left its unselected stage');
  assert.equal(cliBuildCommit(join(f.installation, 'current')), a);
  const reply = await launch(f, ['agent', f.directory, 'save']);
  assert.equal(reply.status, 0, reply.stderr);
  assert.equal(JSON.parse(reply.stdout).build, 'current');
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = cache;
  t.after(() => {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous;
  });
  const result = await updateCli(
    f.installation,
    readCliSourceFile(f),
    { head: b, projectId: address.projectId },
    {
      source: {
        current: async () => ({ head: b, projectId: address.projectId }),
        checkout: async stage => {
          writeFileSync(join(stage, 'package.json'), JSON.stringify({ name: '@nanthai/forge' }));
          writeFileSync(join(stage, 'package-lock.json'), '{}');
        },
      },
      run: async (cwd, args) => {
        if (args[1] === 'ci') return mkdirSync(join(cwd, 'node_modules'));
        if (args[1] !== 'run') return;
        mkdirSync(join(cwd, 'dist'));
        for (const name of ['cli-version.js', 'cli-entry.js', 'agent-edit-hook.js'])
          writeFileSync(join(cwd, 'dist', name), '// synthetic');
        copyFileSync(
          new URL('../dist/cli-launcher.js', import.meta.url),
          join(cwd, 'dist', 'cli-launcher.js'),
        );
      },
      migrate: () => {},
    },
    { expectedCurrent: a },
  );
  assert.equal(result.status, 'updated');
  assert.equal(cliBuildCommit(join(f.installation, 'current')), b);
  assert.deepEqual(stages(), []);
});

test('the switch is atomic: launches racing repeated selections always run one complete build', async t => {
  const f = fixture(t),
    other = f.build(b);
  writeFileSync(join(f.old, 'dist', 'cli-entry.js'), 'process.stdout.write("A");');
  writeFileSync(join(other, 'dist', 'cli-entry.js'), 'process.stdout.write("B");');
  installLauncher(f, f.old);
  let finished = false;
  const replies = Promise.all(
    Array.from({ length: 12 }, () => launch(f, ['agent', f.directory, 'save'])),
  ).finally(() => (finished = true));
  for (let flip = 0; !finished; flip++) {
    const build = flip % 2 ? f.old : other;
    selectCliBuild(f.installation, build);
    selectCliBuild(f.installation, build, 'manager');
    await new Promise(done => setTimeout(done, 1));
  }
  for (const reply of await replies) {
    assert.equal(reply.status, 0, reply.stderr);
    assert.ok(['A', 'B'].includes(reply.stdout), reply.stdout);
  }
  assert.ok(!readdirSync(f.installation).some(name => /^(current|manager)-/.test(name)));
});

test('pruning holds the runtime lock only for its final fence, never during process inspection', t => {
  const f = fixture(t),
    next = f.build(b);
  selectCliBuild(f.installation, next);
  installLauncher(f, next);
  permitCliRetirement(f.installation);
  let during;
  const removed = pruneCliBuilds(
    f.installation,
    () => {
      // A CLI starting while the process table is read gets the lock at once.
      during = withCliRuntimeLock(f.installation, () => 'started', 0);
      return [];
    },
    0,
  );
  assert.equal(during, 'started');
  assert.deepEqual(removed, [a]);
  assert.equal(existsSync(f.old), false);
  assert.ok(!readdirSync(join(f.installation, 'builds')).some(name => name.startsWith('.retiring-')));
});

test('a build claimed after inspection is kept by the prune fence', t => {
  const f = fixture(t),
    next = f.build(b);
  selectCliBuild(f.installation, next);
  installLauncher(f, next);
  permitCliRetirement(f.installation);
  const removed = pruneCliBuilds(
    f.installation,
    () => {
      mkdirSync(join(f.old, '.users'), { recursive: true });
      writeFileSync(join(f.old, '.users', String(process.pid)), JSON.stringify(cliProcessIdentity()));
      return [];
    },
    0,
  );
  assert.deepEqual(removed, []);
  assert.ok(existsSync(join(f.old, 'dist', 'cli-entry.js')));
});

test('read-only classification covers agent reads and top-level waits; everything else is a write', async () => {
  const { cliReadOnlyCommand } = await import('../dist/cli-version.js');
  for (const args of [
    ['agent', '.', 'status'],
    ['x', '.', 'planning', '{}'],
    ['agent', '.', 'wait', '{}'],
    ['agent', '.', 'show'],
    ['agent', '.', 'diff'],
    ['status', '.'],
    ['wait', 'id'],
    ['heavy', 'npm', 'test'],
  ])
    assert.equal(cliReadOnlyCommand(args), true, args.join(' '));
  for (const args of [
    ['agent', '.', 'save'],
    ['agent', '.', 'land', '--save'],
    ['agent', '.', 'start'],
    ['agent', '.', 'put-planning-item'],
    ['agent', '.', 'comment-planning-item'],
    ['agent', '.', 'abandon'],
    ['land', '.'],
    ['pull', '.'],
    ['init-native', '.'],
    [],
  ])
    assert.equal(cliReadOnlyCommand(args), false, args.join(' '));
});

test('pre-switch hook sees an installed-but-not-active build; a failing check keeps the previous build', async t => {
  const f = fixture(t),
    main = f.build(b);
  let seen;
  const dependencies = {
    source: { current: async () => ({ head: b, projectId: address.projectId }) },
    migrate: () => {},
    preSwitch: build => {
      seen = { build, current: cliBuildCommit(join(f.installation, 'current')) };
      throw Object.assign(new Error('canary failed'), { code: 'CLI_CANARY_FAILED' });
    },
  };
  await assert.rejects(updateCli(f.installation, address, undefined, dependencies), {
    code: 'CLI_CANARY_FAILED',
  });
  assert.deepEqual(seen, { build: main, current: a });
  assert.equal(cliBuildCommit(join(f.installation, 'current')), a);
  assert.ok(existsSync(join(main, '.managed-cli')), 'installed build stays for the next attempt');
  dependencies.preSwitch = () => {};
  const result = await updateCli(f.installation, address, undefined, dependencies);
  assert.equal(result.status, 'updated');
  assert.equal(cliBuildCommit(join(f.installation, 'current')), b);
});
