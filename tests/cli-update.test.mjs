// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { testDeploymentOrigin } from './trusted-origin.mjs';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostname } from 'node:os';
import { childEnv } from '../scripts/child-env.mjs';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
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
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeInstall } from '../dist/dependency-seal.js';
import { dependencyKey } from '../dist/shared-dependencies.js';
import { withCliRuntimeLock, cliProcessIdentity } from '../dist/cli-launcher.js';
import { cliUpdateRunning, launcherElsewhere } from '../dist/cli-update.js';
import { cliStartup, cliVersionCheck } from '../dist/cli-version.js';
import { signCliRelease } from '../dist/cli-release-trust.js';
import { updateCli as updateCliChecked } from '../dist/cli-update.js';
import {
  testReleasePem,
  testReleaseSigner,
  trustedDist,
  withSignedReleases,
} from './release-trust-fixture.mjs';
import { publishCliBuild } from '../dist/cli-update-install.js';
import {
  cliBuildCommit,
  cliBuildIdentity,
  pruneCliBuilds,
  permitCliRetirement,
  reconcileRetiredOwnerServices,
  selectCliBuild,
  stableSelection,
  stageStableSelection,
  stableCliRunner,
  withCliLock,
} from '../dist/cli-installation.js';
import { cliLandingCommand, waitForCliMeasurement } from '../dist/cli-measurement-hold.js';
import { migrateEditHookRunner } from '../dist/agent-install-hooks.js';
import { processAlive, processIdentity } from '../dist/local-process.js';
import { eventually } from './mcp-lifecycle-fixture.mjs';

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

test("a second installation (a bench CLI home) never takes over the first one's hooks or launcher (2e1f5fbd)", t => {
  const f = fixture(t);
  const second = join(f.directory, 'bench-cli');
  const benchBuild = join(second, 'builds', b);
  mkdirSync(join(benchBuild, 'dist'), { recursive: true });
  writeFileSync(join(benchBuild, '.commit'), b);
  writeFileSync(join(benchBuild, 'dist', 'agent-edit-hook.js'), '// complete');
  selectCliBuild(second, benchBuild);
  const before = ['.claude/settings.json', '.codex/hooks.json'].map(file =>
    readFileSync(join(f.home, file), 'utf8'),
  );
  assert.deepEqual(migrateEditHookRunner(join(second, 'current', 'dist', 'agent-edit-hook.js'), f.home), []);
  assert.deepEqual(
    ['.claude/settings.json', '.codex/hooks.json'].map(file => readFileSync(join(f.home, file), 'utf8')),
    before,
  );
  // The default launcher enters the first installation: an update of the second keeps it.
  for (const dir of [f.installation, second]) writeFileSync(join(dir, 'launcher.mjs'), '');
  const bin = join(f.directory, 'bin', 'nforge');
  mkdirSync(join(f.directory, 'bin'));
  writeFileSync(bin, `#!/bin/sh\nexec '/usr/local/bin/node' '${f.installation}/launcher.mjs' "$@"\n`);
  assert.equal(launcherElsewhere(bin, second), f.installation);
  assert.equal(launcherElsewhere(bin, f.installation), null, 'its own launcher is rewritten');
  assert.equal(launcherElsewhere(join(f.directory, 'bin', 'absent'), second), null, 'no launcher yet');
  rmSync(join(f.installation, 'launcher.mjs'));
  assert.equal(launcherElsewhere(bin, second), null, 'a launcher of a removed installation is replaced');
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

test('a background updater outliving its deleted installation never recreates it', async t => {
  const f = fixture(t);
  const dependencies = { source: { current: async () => assert.fail('unexpected read') } };
  // A detached updater reads source.json, then its installation is deleted (a test's cleanup, an
  // uninstall) before it creates builds/: it fails instead of recreating the whole tree.
  rmSync(f.installation, { recursive: true, force: true });
  await assert.rejects(updateCli(f.installation, address, undefined, dependencies, { installed: true }), {
    code: 'ENOENT',
  });
  assert.equal(existsSync(f.installation), false, 'the deleted installation stays deleted');
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

async function releaseFixture(t, f, head, status, cliRelease) {
  // [0] release reads, [1] agent capability reads (refused by the synthetic service).
  const calls = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(new URL('../scripts/package-cli-release-worker.mjs', import.meta.url), {
    workerData: {
      head,
      projectId: address.projectId,
      calls: calls.buffer,
      status,
      cliRelease,
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
  testDeploymentOrigin(url);
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
  // Print-only commands never read the release (e.g. 381c62df: --version cost a network read per call).
  assert.equal(Atomics.load(calls, 0), 0);
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

test('valid agent work reads capabilities alongside the release check, once; argument errors read nothing', async t => {
  const f = fixture(t),
    calls = await releaseFixture(t, f, a),
    check = cliVersionCheck();
  const { agentCli } = await import('../dist/agent-cli.js');
  const { clientCacheRoot } = await import('../dist/root-paths.js');
  const root = join(f.directory, 'served');
  mkdirSync(join(clientCacheRoot(root), 'agent'), { recursive: true });
  // The synthetic release service also answers (and refuses) this project's capability read.
  const { url } = JSON.parse(readFileSync(join(f.installation, 'source.json'), 'utf8'));
  writeFileSync(
    join(clientCacheRoot(root), 'agent/address.json'),
    JSON.stringify({ url, projectId: 'project' }),
  );
  t.mock.method(process.stdout, 'write', () => true);
  const gate = args => () => cliStartup(args, f.old, check, { validated: true });
  for (const args of [
    ['agent', root, 'start', '{}'],
    ['agent', root, 'planning', '{"limit":"x"}'],
  ])
    await assert.rejects(agentCli(args.slice(1), { beforeDispatch: gate(args) }), { code: 'BAD_ARGUMENT' });
  assert.deepEqual([...calls], [0, 0]);
  // The capability read is on the network before the release check runs: this gate waits for it.
  let seen = -1;
  const waitForEarlyRead = async () => {
    for (let i = 0; i < 500 && Atomics.load(calls, 1) === 0; i++)
      await new Promise(done => setTimeout(done, 10));
    seen = Atomics.load(calls, 1);
    assert.equal(await gate(['agent', root, 'planning'])(), true);
    return false; // A redispatched process handles the valid command instead.
  };
  await agentCli([root, 'planning', '{}'], { beforeDispatch: waitForEarlyRead });
  assert.equal(seen, 1);
  assert.deepEqual([...calls], [1, 1]);
  // Past the gate, dispatch takes that same read: one capability call for the whole command.
  await assert.rejects(
    agentCli([root, 'planning', '{}'], { beforeDispatch: gate(['agent', root, 'planning']) }),
  );
  assert.deepEqual([...calls], [1, 2]);
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
        FORGE_DEPLOYMENT_URL: JSON.parse(readFileSync(join(f.installation, 'source.json'), 'utf8')).url,
        FORGE_DEPLOYMENT_URL: JSON.parse(readFileSync(join(f.installation, 'source.json'), 'utf8')).url,
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

test('hosted agent receipt envelopes name the executing CLI build', async t => {
  const { agentFixture } = await import('./hosted-agent-fixture.mjs');
  const hosted = agentFixture(t);
  const receipt = await hosted.transport().dispatch('capabilities', {});
  const { cliChannel, cliVersion } = cliBuildIdentity();
  assert.equal(receipt.cliCommit, cliBuildCommit());
  assert.equal(receipt.cliChannel, cliChannel);
  assert.equal(receipt.cliVersion, cliVersion);
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

function stableFixtureBuild(build, cliVersion = '0.3.1', cliProtocolVersion = 1) {
  writeFileSync(
    join(build, 'package.json'),
    JSON.stringify({
      name: '@nanthai/forge',
      type: 'module',
      version: cliVersion,
      forge: { cliProtocolVersion },
    }),
  );
  writeFileSync(join(build, 'dist', 'cli-stable.js'), '// stable-capable build');
}

test('stable starts one release check after dispatch has finished, then keeps foreground reads free of discovery', async t => {
  const f = fixture(t);
  const calls = await releaseFixture(t, f, b, undefined, {
    channel: 'main',
    stableHead: a,
    minimumCliVersion: '0.3.1',
    minimumProtocolVersion: 1,
  });
  stableFixtureBuild(f.old);
  writeFileSync(join(f.installation, 'stable-selection.json'), '{}');
  installLauncher(f, f.old);
  writeFileSync(
    join(f.old, 'dist', 'cli-entry.js'),
    `import { once } from 'node:events';
import { cliStartup } from ${JSON.stringify(trustedDist().url('cli-version.js'))};
if (await cliStartup(process.argv.slice(2), ${JSON.stringify(f.old)}, undefined, { validated: true })) {
  process.stdout.write('dispatch-in-progress');
  await once(process.stdin, 'data');
  process.stdin.pause();
  process.stdout.write('-finished');
}
`,
  );
  const run = spawn(process.execPath, [join(f.installation, 'launcher.mjs'), 'queue', 'list'], {
    env: launcherEnv(f),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => run.kill());
  let stdout = '';
  const dispatched = new Promise(done => {
    run.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.includes('dispatch-in-progress')) done();
    });
  });
  const exited = new Promise((done, reject) => {
    run.once('error', reject);
    run.once('close', done);
  });
  await Promise.race([
    dispatched,
    exited.then(status => assert.fail(`Stable command exited before dispatch (${status}).`)),
  ]);
  assert.equal(Atomics.load(calls, 0), 0);
  assert.equal(existsSync(join(f.installation, 'update.log')), false);
  const observed = Atomics.waitAsync(calls, 0, 0, 20_000);
  run.stdin.end('finish');
  assert.equal(await exited, 0);
  assert.equal(stdout, 'dispatch-in-progress-finished');
  assert.equal(await observed.value, 'ok');
  const { cliUpdateCli } = await import('../dist/cli-update.js');
  await cliUpdateCli(['--background', '--directory', f.installation]);
  assert.equal(Atomics.load(calls, 0), 1);
  assert.equal(cliBuildCommit(join(f.installation, 'current')), a);
});

test('stable checks the cached CLI and protocol floors with one stderr line, while version and auth show the exact pin', t => {
  const f = fixture(t);
  stableFixtureBuild(f.old);
  installLauncher(f, f.old);
  // Run the real CLI entry and its chunks at the installed path.
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  for (const name of readdirSync(dist).filter(name => /^cli-(entry|bundle-).*\.js$/.test(name))) {
    copyFileSync(join(dist, name), join(f.old, 'dist', name));
  }
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(f.old, 'node_modules'), 'dir');
  writeFileSync(
    join(f.directory, 'client.json'),
    JSON.stringify({ localHeavySlots: 0, firstWriteHooks: false }),
  );
  writeFileSync(join(f.installation, 'stable-selection.json'), JSON.stringify({ pin: a }));
  const fixtureNow = Date.parse('2026-11-20T12:00:00Z');
  const clock = join(f.directory, 'clock.mjs');
  writeFileSync(clock, `Date.now = () => ${fixtureNow};\n`);
  const cache = (minimumCliVersion, minimumProtocolVersion) =>
    writeFileSync(
      join(f.installation, 'stable-release.json'),
      JSON.stringify({
        checkedAt: fixtureNow,
        metadata: { channel: 'main', minimumCliVersion, minimumProtocolVersion },
      }),
    );
  const run = (...args) =>
    spawnSync(process.execPath, ['--import', clock, join(f.installation, 'launcher.mjs'), ...args], {
      cwd: f.directory,
      env: {
        ...launcherEnv(f),
        FORGE_AUTH_TOKEN: '',
        XDG_CONFIG_HOME: join(f.home, '.config'),
        XDG_CACHE_HOME: join(f.home, '.cache'),
        XDG_STATE_HOME: join(f.home, '.state'),
      },
      encoding: 'utf8',
    });
  cache('0.3.0', 1);
  const allowed = run('settings');
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stderr, '');
  for (const floor of [
    ['0.3.2', 1],
    ['0.3.1', 2],
  ]) {
    cache(...floor);
    const denied = run('settings');
    assert.equal(denied.status, 1);
    assert.equal(denied.stdout, '');
    assert.equal(denied.stderr.trim().split('\n').length, 1);
    const { error } = JSON.parse(denied.stderr);
    assert.equal(error.code, 'CLI_UPGRADE_REQUIRED');
    assert.match(error.message, /nforge update .* --unpin/);
  }
  const version = run('--version');
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, `nforge version 0.3.1 (channel stable, pin ${a}, build ${a})\n`);
  const auth = run('auth', 'status', '--json', 'cliVersion,cliChannel,cliPin,cliCommit');
  assert.equal(auth.status, 1, auth.stderr); // No test credentials.
  assert.deepEqual(JSON.parse(auth.stdout), {
    cliVersion: '0.3.1',
    cliChannel: 'stable',
    cliPin: a,
    cliCommit: a,
  });
});

test('interrupted pin publication keeps the launcher and pin on the same State', t => {
  const f = fixture(t);
  const next = f.build(b);
  stableFixtureBuild(f.old);
  stableFixtureBuild(next);
  controllerEntry(f.old, 'original pin');
  controllerEntry(next, 'new pin');
  installLauncher(f, next);
  writeFileSync(join(f.installation, 'stable-selection.json'), JSON.stringify({ pin: a }));
  stageStableSelection(f.installation, b, { pin: b });
  const run = () =>
    spawnSync(process.execPath, [join(f.installation, 'launcher.mjs'), '--version'], {
      env: launcherEnv(f),
      encoding: 'utf8',
    });
  assert.deepEqual(stableSelection(f.installation), { pin: a });
  assert.equal(run().stdout, 'original pin\n');
  selectCliBuild(f.installation, next);
  assert.deepEqual(stableSelection(f.installation), { pin: b });
  assert.equal(run().stdout, 'new pin\n');
});

test('changing a stable pin rechecks a same-State signature and unpinning respects the release-number floor', async t => {
  const f = fixture(t);
  stableFixtureBuild(f.old);
  installLauncher(f, f.old);
  writeFileSync(join(f.installation, 'stable-selection.json'), '{}');
  let signatures = [];
  const dependencies = {
    source: {
      current: async () => ({
        schema: 2,
        projectId: address.projectId,
        snapshotId: 'synthetic',
        sourceRevision: 1,
        authority: { mode: 'server', epoch: 1 },
        channel: 'main',
        head: b,
        receipt: { id: 'synthetic', kind: 'server', previousHead: null, previousReceiptId: null },
        cliRelease: { channel: 'main', stableHead: a },
      }),
      signatures: async () => signatures,
    },
    releaseCheck: { alert: async () => undefined },
  };
  const pin = stable => updateCli(f.installation, address, undefined, dependencies, { stable });
  await assert.rejects(pin({ pin: a }), error => error.code === 'CLI_CANARY_FAILED');
  assert.deepEqual(stableSelection(f.installation), {});
  signatures = [signCliRelease(testReleasePem, address.projectId, a, 1)];
  assert.equal((await pin({ pin: a })).cliCommit, a);
  writeFileSync(join(f.installation, 'stable-release-number.json'), JSON.stringify({ release: 2, head: b }));
  await assert.rejects(pin({}), error => error.code === 'CLI_CANARY_FAILED');
  assert.deepEqual(stableSelection(f.installation), { pin: a });
});

test('two stable CI installs select the same signed pin bytes after main and stable move', async t => {
  const installs = [fixture(t), fixture(t)];
  const pin = 'c'.repeat(64);
  const selectedPayloads = [];
  for (const [index, f] of installs.entries()) {
    const checkout = [];
    const minimum = { minimumCliVersion: '0.3.1', minimumProtocolVersion: 1 };
    const observed = {
      schema: 2,
      projectId: address.projectId,
      snapshotId: 'synthetic',
      sourceRevision: index,
      authority: { mode: 'server', epoch: 1 },
      channel: 'main',
      head: index ? b : a,
      receipt: { id: 'synthetic', kind: 'server', previousHead: null, previousReceiptId: null },
      cliRelease: { channel: 'main', stableHead: index ? a : b, ...minimum },
    };
    const dependencies = {
      source: {
        current: async () => observed,
        signatures: async head =>
          head === pin ? [signCliRelease(testReleasePem, address.projectId, pin, 1)] : [],
        checkout: async (stage, release) => {
          checkout.push(release.head);
          writeFileSync(
            join(stage, 'package.json'),
            JSON.stringify({
              name: '@nanthai/forge',
              type: 'module',
              version: '0.3.1',
              forge: { cliProtocolVersion: 1 },
            }),
          );
          writeFileSync(join(stage, 'package-lock.json'), '{}');
          writeFileSync(join(stage, 'source.txt'), 'immutable signed fixture bytes\n');
        },
      },
      run: async (stage, args) => {
        if (args[1] === 'ci') return mkdirSync(join(stage, 'node_modules'));
        if (args[1] !== 'run') return;
        mkdirSync(join(stage, 'dist'));
        stableFixtureBuild(stage);
        copyFileSync(
          new URL('../dist/cli-launcher.js', import.meta.url),
          join(stage, 'dist', 'cli-launcher.js'),
        );
        for (const file of ['cli-version.js', 'cli-entry.js', 'agent-edit-hook.js'])
          writeFileSync(join(stage, 'dist', file), readFileSync(join(stage, 'source.txt')));
      },
      migrate: () => {},
    };
    const result = await updateCli(f.installation, address, undefined, dependencies, { stable: { pin } });
    assert.equal(result.cliCommit, pin);
    assert.deepEqual(checkout, [pin]);
    assert.deepEqual(stableSelection(f.installation), { pin });
    assert.equal((await updateCli(f.installation, address, undefined, dependencies)).cliCommit, pin);
    assert.deepEqual(checkout, [pin]);
    selectedPayloads.push(readFileSync(join(f.installation, 'current', 'dist', 'cli-entry.js')));
    observed.cliRelease.minimumProtocolVersion = 2;
    await assert.rejects(
      updateCli(f.installation, address, undefined, dependencies),
      error => error.code === 'CLI_UPGRADE_REQUIRED',
    );
    delete observed.cliRelease;
    await assert.rejects(
      updateCli(f.installation, address, undefined, dependencies),
      error => error.code === 'CLI_UPGRADE_REQUIRED',
    );
    assert.equal(cliBuildCommit(join(f.installation, 'current')), pin);
    assert.deepEqual(stableSelection(f.installation), { pin });
  }
  assert.deepEqual(selectedPayloads[0], selectedPayloads[1]);
});

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
  const reply = spawnSync(process.execPath, [join(f.installation, 'launcher.mjs'), 'queue', 'list'], {
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
  const reply = spawnSync(process.execPath, [join(f.installation, 'launcher.mjs'), 'queue', 'list'], {
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

for (const legacyUpdater of [false, true])
  test(
    legacyUpdater
      ? 'the newly selected runtime reconciles orphaned services after a swap performed by an old updater'
      : 'release swap stops orphaned owner services from its old build while preserving other detached work',
    { skip: !['darwin', 'linux'].includes(process.platform), timeout: 10000 },
    async t => {
      const f = fixture(t),
        other = join(f.directory, 'other-installation', 'builds', a),
        next = f.build(b);
      mkdirSync(join(other, 'dist'), { recursive: true });
      writeFileSync(join(other, '.managed-cli'), '1');
      const worker = `
      import { writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => {
        writeFileSync(import.meta.filename + '.stopped', '');
        process.exit(0);
      });
      writeFileSync(import.meta.filename + '.ready', '');
      setInterval(() => {}, 60000);
    `;
      const workers = [
        { path: join(f.old, 'dist', 'auto-exchange.js'), args: [] },
        { path: join(f.old, 'dist', 'cli.js'), args: ['host', f.directory, '--sync-agent'] },
        { path: join(f.old, 'dist', 'check-controller-worker.js'), args: [] },
        { path: join(other, 'dist', 'auto-exchange.js'), args: [] },
        { path: join(next, 'dist', 'auto-exchange.js'), args: [] },
      ];
      for (const { path } of workers) writeFileSync(path, worker);
      const parent = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { spawn } from 'node:child_process';
         const pids = ${JSON.stringify(workers)}.map(({ path, args }) => {
           const child = spawn(process.execPath, [path, ...args], { detached: true, stdio: 'ignore' });
           child.unref();
           return child.pid;
         });
         process.send(pids, () => process.disconnect());`,
        ],
        { env: childEnv(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
      );
      const exited = once(parent, 'exit');
      const pids = (await once(parent, 'message'))[0];
      const identities = pids.map(pid => processIdentity(pid));
      t.after(() => {
        for (const identity of identities) if (processAlive(identity)) process.kill(identity.pid, 'SIGKILL');
      });
      assert.deepEqual(await exited, [0, null]);
      await eventually(
        'all fixture workers installed their signal handler',
        () => workers.every(({ path }) => existsSync(path + '.ready')),
        Boolean,
      );
      if (legacyUpdater) {
        // The old updater publishes these pins but cannot execute a new runtime's cleanup.
        selectCliBuild(f.installation, f.old, 'previous');
        selectCliBuild(f.installation, next);
        permitCliRetirement(f.installation);
        assert.equal(reconcileRetiredOwnerServices(f.installation, next), 2);
        assert.equal(reconcileRetiredOwnerServices(f.installation, next), 0);
      } else {
        const result = publishCliBuild({
          installation: f.installation,
          build: next,
          head: b,
          expectedCurrent: a,
          address,
          migrate: () => {},
        });
        assert.equal(result.stoppedRetiredWorkers, 2);
      }
      await eventually(
        'both old owner services exited',
        () => identities.slice(0, 2).every(identity => !processAlive(identity)),
        Boolean,
      );
      assert.deepEqual(
        workers.map(({ path }) => existsSync(path + '.stopped')),
        [true, true, false, false, false],
      );
      assert.deepEqual(identities.slice(2).map(processAlive), [true, true, true]);
    },
  );

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
  const hookEntry = readFileSync(join(dist, 'agent-edit-hook.js'), 'utf8');
  // Friction 33ed19ae: installed hooks use the Vite-bundled dist/agent-edit-hook*.js closure. Plain `tsc`
  // overwrites dist/agent-edit-hook.js with unbundled imports like `../scripts/main-module.mjs`, which fails
  // inside a standalone installation dir even though the landing check (running build:core) passes.
  const external = [...hookEntry.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)]
    .map(match => match[1])
    .filter(spec => !spec.startsWith('node:') && !/^\.\/agent-edit-hook-.+\.js$/.test(spec));
  assert.deepEqual(
    external,
    [],
    `dist/agent-edit-hook.js is not the bundled hook (plain tsc overwrote it?); run npm run build:core`,
  );
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
  const reply = spawnSync(process.execPath, [join(f.installation, 'launcher.mjs'), 'queue', 'list'], {
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

test('an update waits for a heavy lease without blocking an updater already inside heavy', async t => {
  const f = fixture(t),
    slots = join(f.directory, 'slots'),
    cache = join(f.directory, 'cache');
  writeFileSync(join(f.directory, 'client.json'), JSON.stringify({ localHeavySlots: 1 }));
  mkdirSync(join(slots, '1'), { recursive: true });
  writeFileSync(join(slots, '1', 'pid'), String(process.pid));
  const previous = {
    FORGE_HEAVY_DIR: process.env.FORGE_HEAVY_DIR,
    FORGE_HEAVY_PARENT: process.env.FORGE_HEAVY_PARENT,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  };
  process.env.FORGE_HEAVY_DIR = slots;
  process.env.XDG_CACHE_HOME = cache;
  delete process.env.FORGE_HEAVY_PARENT;
  t.after(() => {
    for (const [name, value] of Object.entries(previous))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  let builds = 0;
  let cacheHolder;
  const dependencies = {
    source: {
      current: async () => ({ head: b, projectId: address.projectId }),
      checkout: async stage => {
        writeFileSync(
          join(stage, 'package.json'),
          JSON.stringify({ name: '@nanthai/forge', testIdentity: f.directory }),
        );
        writeFileSync(join(stage, 'package-lock.json'), '{}');
        // An older client can hold this cache entry while waiting for the same heavy slot.
        cacheHolder = join(cache, 'forge', 'deps', `npm-${dependencyKey(stage)}.lock`, '1', 'pid');
        mkdirSync(join(cacheHolder, '..'), { recursive: true });
        writeFileSync(cacheHolder, String(process.pid));
      },
    },
    run: async (cwd, args, _home, build) => {
      if (args[1] === 'ci') {
        assert.ok(cwd.startsWith(join(f.installation, 'builds', '.install-')), 'local install on contention');
        mkdirSync(join(cwd, 'node_modules'));
      } else if (args[1] === 'run') {
        builds++;
        assert.match(build.env.GOMAXPROCS, /^[1-9][0-9]*$/);
        assert.equal(build.env.FORGE_HEAVY_PARENT, process.env.FORGE_HEAVY_PARENT);
        assert.equal(readFileSync(join(slots, '1', 'pid'), 'utf8'), String(process.pid));
        mkdirSync(join(cwd, 'dist'));
        for (const name of ['cli-version.js', 'cli-launcher.js', 'cli-entry.js', 'agent-edit-hook.js'])
          writeFileSync(join(cwd, 'dist', name), '// synthetic');
      }
    },
    migrate: () => {},
  };
  const pending = updateCli(f.installation, address, undefined, dependencies);
  try {
    await until(() => readdirSync(slots).some(name => name.startsWith('q-')), 'update heavy ticket');
    assert.equal(builds, 0);
    process.env.FORGE_HEAVY_PARENT = JSON.stringify({
      directory: slots,
      slot: '1',
      pid: process.pid,
    });
    const nested = await updateCli(f.installation, address, undefined, dependencies);
    assert.equal(nested.status, 'updated');
    assert.equal(readFileSync(cacheHolder, 'utf8'), String(process.pid), 'legacy cache lock retained');
    assert.equal(readFileSync(join(slots, '1', 'pid'), 'utf8'), String(process.pid), 'outer lease retained');
  } finally {
    rmSync(join(slots, '1'), { recursive: true, force: true });
    await pending;
  }
  assert.equal((await pending).cliCommit, b);
  assert.equal(builds, 1);
  assert.equal(existsSync(join(slots, '1')), false);
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
test('incident 203c1ce5: a wait running when the update switches and prunes keeps its build and finishes with its own result', async t => {
  const f = fixture(t),
    main = f.build(b);
  await releaseFixture(t, f, b);
  const flag = join(f.directory, 'go'),
    startup = trustedDist().url('cli-version.js');
  writeFileSync(
    join(f.old, 'dist', 'late-module.js'),
    "export const late = 'lazy bytes of the old build';\n",
  );
  writeFileSync(
    join(f.old, 'dist', 'cli-entry.js'),
    `import { existsSync } from 'node:fs';
import { cliStartup } from ${JSON.stringify(startup)};
if (await cliStartup(process.argv.slice(2), ${JSON.stringify(f.old)}, undefined, { validated: true })) {
  process.stdout.write('waiting\\n');
  while (!existsSync(${JSON.stringify(flag)})) await new Promise(done => setTimeout(done, 25)); // test-signal: allow the spawned old-build entry has no event to wait on but the test's go-ahead file
  const { late } = await import('./late-module.js');
  process.stdout.write(JSON.stringify({ status: 'terminal', late }) + '\\n');
}
`,
  );
  gatedEntry(main, 'main');
  installLauncher(f, f.old);
  // stdin closed, no TTY: how an agent harness starts a background wait.
  const child = spawn(
    process.execPath,
    [join(f.installation, 'launcher.mjs'), 'agent', f.directory, 'wait', '{}'],
    {
      env: launcherEnv(f),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  child.stdout.on('data', chunk => (stdout += chunk));
  const finished = new Promise(done => child.once('exit', (status, signal) => done({ status, signal })));
  await until(() => stdout.includes('waiting'), 'the wait to start on the old build');
  // The update switches to main and tries to retire the old build while the wait is still running.
  publishCliBuild({
    installation: f.installation,
    address: readCliSourceFile(f),
    head: b,
    build: main,
    expectedCurrent: a,
    migrate: () => {},
  });
  permitCliRetirement(f.installation);
  assert.deepEqual(pruneCliBuilds(f.installation), [], 'the running wait holds its build');
  writeFileSync(flag, '');
  assert.deepEqual(await finished, { status: 0, signal: null });
  assert.match(stdout, /"status":"terminal","late":"lazy bytes of the old build"/);
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
  const mark = join(f.installation, 'update-failed.json');
  writeFileSync(mark, JSON.stringify({ code: 'CLI_UPDATE_BUILD_FAILED' }));
  const stampedAt = statSync(mark).mtimeMs;
  const reply = await launch(f, ['status']);
  assert.equal(reply.status, 0, reply.stderr);
  assert.match(
    reply.stderr,
    /main bbbbbbbb last install failed .*update\.log\); the next write retries it; this read ran on aaaaaaaa/,
  );
  assert.equal(existsSync(join(f.installation, 'update.log')), false, 'no background updater started');
  // After the retry window a read starts one again.
  const past = new Date(stampedAt - 11 * 60_000);
  utimesSync(mark, past, past);
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

test('each installed build keeps one private compile cache, and caches of removed builds go', t => {
  const f = fixture(t);
  const cache = join(f.installation, 'compile-cache');
  mkdirSync(join(cache, b), { recursive: true });
  const launcher = pathToFileURL(fileURLToPath(new URL('../dist/cli-launcher.js', import.meta.url))).href;
  const run = build =>
    spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { enableCliCompileCache } = await import(${JSON.stringify(launcher)});
         enableCliCompileCache(process.argv[1], process.argv[2]);
         process.stdout.write((await import('node:module')).getCompileCacheDir() ?? '');`,
        f.installation,
        build,
      ],
      { encoding: 'utf8', env: childEnv() },
    );
  const result = run(f.old);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith(join(cache, a)), 'the selected build compiles into its own cache');
  assert.equal((statSync(join(cache, a)).mode & 0o777).toString(8), '700');
  assert.deepEqual(readdirSync(cache), [a], 'the cache of a build that no longer exists is removed');
  rmSync(cache, { recursive: true, force: true });
  writeFileSync(cache, 'not a directory');
  const blocked = run(f.old);
  assert.equal(blocked.status, 0, 'a cache failure never stops the command');
  assert.equal(blocked.stdout, '', 'and the command runs uncached');
});

test('SM-C M15: the update lock is live for its recorded process and not for a reused pid', async t => {
  const installation = mkdtempSync(join(tmpdir(), 'forge-update-lock-'));
  t.after(() => rmSync(installation, { recursive: true, force: true }));
  const slot = join(installation, 'update-lock', '1');
  mkdirSync(slot, { recursive: true });
  const { processStartTime } = await import('../dist/local-process.js');
  const start = processStartTime(process.pid);
  assert.ok(start);
  writeFileSync(join(slot, 'pid'), String(process.pid));
  writeFileSync(join(slot, 'start'), start);
  assert.equal(cliUpdateRunning(installation), true, 'the recorded updater is running');
  // The pid is alive but now belongs to another process: the updater that held the lock is gone.
  writeFileSync(join(slot, 'start'), 'Thu Jan  1 00:00:00 1970');
  assert.equal(cliUpdateRunning(installation), false, 'a reused pid is not the updater');
  // A legacy slot (pid only) stays conservative.
  rmSync(join(slot, 'start'));
  assert.equal(cliUpdateRunning(installation), true);
});
