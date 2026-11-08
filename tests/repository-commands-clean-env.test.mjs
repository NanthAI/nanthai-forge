// SPDX-License-Identifier: Apache-2.0
// Repository-chosen commands Forge runs on the agent's machine outside a check (start-time dependency
// installs, local preflight) run in the clean check environment, and a repository's declaration of
// install scripts is a request the machine or the agent accepts, never a permission (eac76001).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/portable-hash.js';
import { sourceTree } from '../dist/source-tree.js';
import { preflightPlan, preflightRuntime, runPreflight } from '../dist/agent-preflight.js';
import { detectPackageManager } from '../dist/package-manager.js';
import { managerInstall } from '../dist/package-manager-install.js';
import { installScriptsNotice, npmInstaller, shareDependencies } from '../dist/shared-dependencies.js';

const SENTINEL = 'synthetic-agent-credential-sentinel';
function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-clean-commands-'));
  const names = ['XDG_STATE_HOME', 'FORGE_HEAVY_DIR', 'FORGE_AUTH_TOKEN', 'FORGE_CLIENT_SETTINGS', 'PATH'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.XDG_STATE_HOME = join(directory, 'state');
  process.env.FORGE_HEAVY_DIR = join(directory, 'heavy');
  // The agent's own process holds a credential; nothing Forge runs for the repository may see it.
  process.env.FORGE_AUTH_TOKEN = SENTINEL;
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}
/** A fake program on PATH that records what it can see of the environment, never a value of the credential. */
function recorder(directory, name) {
  const bin = join(directory, 'bin'),
    log = join(directory, `${name}.log`);
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, name),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo 10.4.1; exit 0; fi
echo "$1 token=\${FORGE_AUTH_TOKEN:+present} home=$HOME tmp=$TMPDIR userconfig=$npm_config_userconfig" >> ${JSON.stringify(log)}
case "$1" in install|ci) mkdir -p node_modules/dep ;; esac
`,
  );
  chmodSync(join(bin, name), 0o755);
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  return () => readFileSync(log, 'utf8').trim().split('\n');
}
const seen = line =>
  Object.fromEntries(
    line
      .split(' ')
      .slice(1)
      .map(pair => pair.split(/=(.*)/s).slice(0, 2)),
  );
function assertClean(line) {
  const env = seen(line);
  assert.equal(env.token, '', 'the agent credential is not passed');
  assert.notEqual(env.home, process.env.HOME, 'a private HOME, never the agent one');
  assert.ok(env.home && !existsSync(env.home), 'the private directories are removed afterwards');
  assert.ok(env.userconfig.startsWith(join(env.home, '..', '..')), 'npm reads a private user config');
  assert.notEqual(env.userconfig, join(process.env.HOME, '.npmrc'));
}

test('npm installs run in the clean environment: no agent credential, private HOME and npm config', async t => {
  const directory = scratch(t),
    calls = recorder(directory, 'npm');
  await npmInstaller(directory, { rebuild: ['native'] });
  const [ci, rebuild] = calls();
  assert.match(ci, /^ci /);
  assert.match(rebuild, /^rebuild /);
  assertClean(ci);
  assertClean(rebuild);
  assert.equal(seen(ci).home, seen(rebuild).home, 'one environment for the whole install');
});

test('pnpm, yarn and bun installs run in the same clean environment', async t => {
  const directory = scratch(t),
    calls = recorder(directory, 'pnpm');
  const root = join(directory, 'lane');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), '{"name":"x","packageManager":"pnpm@10.4.1"}');
  writeFileSync(join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  const pm = detectPackageManager(root).manager;
  await managerInstall(
    root,
    pm,
    { command: 'pnpm', prefix: [], version: '10.4.1' },
    { rebuild: ['esbuild'] },
  );
  const [install, rebuild] = calls();
  assert.match(install, /^install /);
  assertClean(install);
  assertClean(rebuild);
});

const scriptedLane = (directory, name, forgeJson) => {
  const root = join(directory, name);
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), '{"name":"x"}');
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/native': { version: '1.0.0', hasInstallScript: true } },
    }),
  );
  if (forgeJson) writeFileSync(join(root, 'forge.json'), JSON.stringify(forgeJson));
  return root;
};

test("a repository's request for install scripts is shown and needs the agent's or the machine's opt-in", async t => {
  const directory = scratch(t),
    calls = [];
  const install = async (stage, options) => {
    calls.push(options);
    mkdirSync(join(stage, 'node_modules'), { recursive: true });
  };
  const share = (root, extra = {}) =>
    shareDependencies(root, {
      install,
      enabled: true,
      cache: join(directory, 'deps'),
      heavy: false,
      ...extra,
    });
  const asks = { install: { scripts: true } };

  const unasked = await share(scriptedLane(directory, 'unasked', asks));
  assert.equal(calls.at(-1).runScripts, false, 'forge.json alone runs nothing');
  assert.deepEqual(unasked.requestedScripts, { source: 'forge.json', packages: 'all' });
  assert.equal(unasked.scripts, undefined);
  assert.equal(
    installScriptsNotice(unasked),
    'Skipped install scripts of 1 package. forge.json asks to run them; that is a request, not a permission. Run them with: npm rebuild (in the Lane), or start with {"installScripts":true}, or accept repository requests on this machine with nforge settings installScripts true.',
  );

  const started = await share(scriptedLane(directory, 'started', asks), { runScripts: true });
  assert.equal(calls.at(-1).runScripts, true);
  assert.deepEqual(started.scripts, { ran: 'all', because: 'start' });
  assert.equal(
    installScriptsNotice(started),
    'Ran all dependency install scripts in the clean install environment: start passed installScripts:true.',
  );
  assert.notEqual(started.path, unasked.path, 'a scripted install is cached apart');

  const settings = join(directory, 'client.json');
  writeFileSync(settings, JSON.stringify({ installScripts: true }));
  process.env.FORGE_CLIENT_SETTINGS = settings;
  const accepted = await share(scriptedLane(directory, 'accepted', asks));
  assert.equal(accepted.status, 'linked', 'the same scripted install, linked');
  assert.deepEqual(accepted.scripts, { ran: 'all', because: 'machine', source: 'forge.json' });
  assert.equal(
    installScriptsNotice(accepted),
    "node_modules links an install that ran all dependency install scripts in the clean install environment: this machine's installScripts setting accepts the request in forge.json.",
  );
  // The machine accepts requests; it does not invent one, and an explicit start flag still wins.
  const none = await share(scriptedLane(directory, 'none'));
  assert.equal(none.scripts, undefined);
  assert.equal(none.requestedScripts, undefined);
  const refused = await share(scriptedLane(directory, 'refused', asks), { runScripts: false });
  assert.equal(refused.scripts, undefined);
  assert.equal(refused.path, unasked.path);
});

const healthy = {
  ok: true,
  latencyMs: 1,
  fseventsdRssMb: null,
  fseventsdCpuPercent: null,
  reason: null,
  attempts: [],
};
test('local preflight runs declared static checks and the test runner in one clean environment', t => {
  const directory = scratch(t);
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy);
  const root = join(directory, 'lane'),
    out = join(directory, 'seen');
  mkdirSync(out);
  // Each command writes what it saw (never a credential value) to a file the test reads.
  const probe = name =>
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(join(out, name))},JSON.stringify({token:process.env.FORGE_AUTH_TOKEN!==undefined,home:process.env.HOME,userconfig:process.env.npm_config_userconfig}))`;
  const bytes = new Map([
    [
      'forge.json',
      JSON.stringify({
        preflight: {
          static: [{ name: 'probe', command: [process.execPath, '-e', probe('static.json')] }],
          tests: { glob: 'tests/*.test.cjs', command: [process.execPath, '-e', probe('runner.json')] },
        },
      }),
    ],
    ['src/a.js', 'module.exports = 1;\n'],
    ['tests/a.test.cjs', "require('../src/a.js');\n"],
  ]);
  for (const [path, body] of bytes) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const files = [...bytes].map(([path, body]) => ({ path, blob: digest(body), mode: 'file' }));
  const laneId = '33333333-3333-4333-8333-333333333333';
  const plan = preflightPlan(
    root,
    { paths: ['src/a.js', 'tests/a.test.cjs'], complete: true },
    { laneId, files },
  );
  assert.equal(plan.status, 'planned', plan.reason);
  assert.ok(plan.tests.length, 'the declared runner has a file to run');
  const receipt = runPreflight(root, laneId, digest(JSON.stringify(files)), plan, sourceTree(files));
  assert.equal(receipt.passed, true, JSON.stringify(receipt));
  const statics = JSON.parse(readFileSync(join(out, 'static.json'), 'utf8'));
  const runner = JSON.parse(readFileSync(join(out, 'runner.json'), 'utf8'));
  for (const view of [statics, runner]) {
    assert.equal(view.token, false, 'the agent credential is not passed');
    assert.notEqual(view.home, process.env.HOME);
    assert.ok(!existsSync(view.home), 'the private directories are removed when the run ends');
    assert.notEqual(view.userconfig, join(process.env.HOME, '.npmrc'));
  }
  assert.equal(statics.home, runner.home, 'one clean environment per run');
});
