// SPDX-License-Identifier: Apache-2.0
// The bench harness carries no machine paths (Issue 8c9b84fc): BENCH_ROOT is required, and the
// CLI build, its dependencies and the measurement hold come from the product installation.
// Synthetic folders only: no network, no Forge, no GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { benchRoot } from '../scripts/bench-t3code/bench-root.mjs';
import {
  benchCli,
  builderInstallations,
  freezePath,
  installationOfBuild,
  launcherInstallation,
  pathInstallation,
  productCli,
} from '../scripts/bench-t3code/cli-install.mjs';
import { cliDonor } from '../scripts/bench-t3code/pin.mjs';
import {
  BENCH_CHECK,
  FORGE_RUNNER,
  benchCheckDigest,
  checkSettingsState,
} from '../scripts/bench-t3code/env.mjs';

const HARNESS = resolve(import.meta.dirname, '../scripts/bench-t3code');
const HEAD = 'e'.repeat(64);

/** A product installation as `nforge update` lays it out: DIR/builds/HEAD selected by DIR/current. */
function installation() {
  const home = mkdtempSync(join(tmpdir(), 'bench-cli-home-'));
  const dir = join(home, 'install');
  const build = join(dir, 'builds', HEAD);
  mkdirSync(join(build, 'dist'), { recursive: true });
  mkdirSync(join(build, 'node_modules'));
  writeFileSync(join(build, 'dist', 'cli-entry.js'), '');
  writeFileSync(join(build, '.commit'), HEAD + '\n');
  symlinkSync(build, join(dir, 'current'));
  writeFileSync(join(dir, 'launcher.mjs'), '');
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'nforge'), `#!/bin/sh\nexec '/usr/local/bin/node' '${dir}/launcher.mjs' "$@"\n`);
  return { home, dir, build, bin };
}

test('BENCH_ROOT is required and absolute; there is no default folder', () => {
  assert.throws(() => benchRoot({}), /BENCH_ROOT_REQUIRED/);
  assert.throws(() => benchRoot({ BENCH_ROOT: '' }), /BENCH_ROOT_REQUIRED/);
  assert.throws(() => benchRoot({ BENCH_ROOT: 'rel/bench' }), /BENCH_ROOT_NOT_ABSOLUTE/);
  assert.equal(benchRoot({ BENCH_ROOT: '/x/bench/../b' }), '/x/b');
});

test('no bench script falls back to a machine path (guard for the whole class)', () => {
  for (const name of readdirSync(HARNESS).filter(n => n.endsWith('.mjs'))) {
    const text = readFileSync(join(HARNESS, name), 'utf8');
    if (name !== 'bench-root.mjs')
      assert.doesNotMatch(text, /process\.env\.BENCH_ROOT/, `${name}: use bench-root.mjs`);
    assert.doesNotMatch(text, /homedir\(\),\s*'NanthAI\//, `${name}: machine path under the home folder`);
    assert.doesNotMatch(text, /forge-cli\/current|forge-phase5\/agents/, `${name}: lead-side tool path`);
  }
});

test('entry points refuse without BENCH_ROOT (exit 2) and create nothing', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bench-noroot-'));
  const env = { ...process.env };
  delete env.BENCH_ROOT;
  for (const args of [
    ['setup.mjs', '--dry'],
    ['teardown.mjs', '--dry'],
    ['plan.mjs', 'check'],
    ['summarize.mjs'],
    ['pin.mjs'],
  ]) {
    const r = spawnSync(process.execPath, [join(HARNESS, args[0]), ...args.slice(1)], {
      cwd,
      env,
      encoding: 'utf8',
    });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /BENCH_ROOT_REQUIRED/, args[0]);
  }
  assert.deepEqual(readdirSync(cwd), []);
});

test('the CLI build comes from the product installation the PATH launcher enters', () => {
  const i = installation();
  const cli = productCli({ explicit: undefined, config: null, pathEnv: i.bin, home: i.home });
  assert.equal(cli.build, execFileSync('realpath', [i.build], { encoding: 'utf8' }).trim());
  assert.equal(cli.installation, execFileSync('realpath', [i.dir], { encoding: 'utf8' }).trim());
  assert.equal(cli.via, 'nforge on PATH');
  assert.equal(cliDonor({ pathEnv: i.bin, home: i.home }), cli.build);
  assert.equal(freezePath(cli), join(cli.installation, '.freeze'));
});

test('FORGE_CLI_HOME and config.forge.cli select the CLI; neither is silently replaced', () => {
  const i = installation();
  const other = installation();
  const viaHome = productCli({ explicit: i.dir, pathEnv: other.bin, home: other.home });
  assert.equal(viaHome.via, 'FORGE_CLI_HOME installation');
  assert.match(viaHome.build, new RegExp(`${HEAD}$`));
  const viaBuild = productCli({ explicit: i.build, pathEnv: other.bin, home: other.home });
  assert.equal(viaBuild.via, 'FORGE_CLI_HOME build');
  assert.equal(viaBuild.installation, viaHome.installation, 'a builds/HEAD build knows its installation');
  const viaConfig = productCli({
    explicit: undefined,
    config: { forge: { cli: join(i.dir, 'current', 'dist', 'cli-entry.js') } },
    pathEnv: other.bin,
    home: other.home,
  });
  assert.equal(viaConfig.installation, viaHome.installation);
  assert.throws(
    () =>
      productCli({
        explicit: undefined,
        config: { forge: { cli: join(i.home, 'gone', 'dist', 'cli-entry.js') } },
        pathEnv: other.bin,
        home: other.home,
      }),
    /BENCH_CLI_NOT_INSTALLED: config\.forge\.cli/,
  );
  assert.throws(() => productCli({ explicit: join(i.home, 'nothing') }), /BENCH_CLI_NOT_INSTALLED/);
});

test("the bench hold never lands on the builders' installation (2e1f5fbd)", () => {
  const builders = installation();
  const bench = installation();
  const benchConfig = { forge: { cli: join(bench.dir, 'current', 'dist', 'cli-entry.js') } };
  const real = p => execFileSync('realpath', [p], { encoding: 'utf8' }).trim();
  assert.deepEqual(builderInstallations({ pathEnv: builders.bin, home: builders.home }), [
    real(builders.dir),
  ]);
  // Bench on its own installation: its hold is there, not in the builders'.
  const own = benchCli({ explicit: '', config: benchConfig, pathEnv: builders.bin, home: builders.home });
  assert.equal(freezePath(own), join(real(bench.dir), '.freeze'));
  // config.forge.cli or FORGE_CLI_HOME on the builders' installation: refused.
  assert.throws(
    () =>
      benchCli({
        explicit: '',
        config: { forge: { cli: join(builders.dir, 'current', 'dist', 'cli-entry.js') } },
        pathEnv: builders.bin,
        home: builders.home,
      }),
    /BENCH_CLI_SHARED: .*setup --live --only bench-cli/,
  );
  assert.throws(
    () => benchCli({ explicit: builders.dir, config: null, pathEnv: builders.bin, home: builders.home }),
    /BENCH_CLI_SHARED/,
  );
  // The hold and the agents' CLI must be one installation.
  assert.throws(
    () => benchCli({ explicit: builders.dir, config: benchConfig, pathEnv: bench.bin, home: bench.home }),
    /BENCH_CLI_MISMATCH/,
  );
});

test('no installation anywhere names the install command; a bare build has no measurement hold', () => {
  const empty = mkdtempSync(join(tmpdir(), 'bench-cli-none-'));
  assert.throws(
    () => productCli({ explicit: undefined, config: null, pathEnv: empty, home: empty }),
    /BENCH_CLI_NOT_INSTALLED: .*nforge update FORGE_CHECKOUT/,
  );
  const bare = join(empty, 'build');
  mkdirSync(join(bare, 'dist'), { recursive: true });
  writeFileSync(join(bare, 'dist', 'cli-entry.js'), '');
  const cli = productCli({ explicit: bare });
  assert.equal(cli.installation, null);
  assert.equal(installationOfBuild(bare), null);
  assert.throws(() => freezePath(cli), /BENCH_CLI_NO_INSTALLATION/);
});

test('launcher parsing follows the product shim, including quoted paths, and ignores other files', () => {
  assert.equal(
    launcherInstallation(`#!/bin/sh\nexec '/n/node' '/a b/inst/launcher.mjs' "$@"\n`),
    '/a b/inst',
  );
  assert.equal(
    launcherInstallation(`#!/bin/sh\nexec '/n/node' '/it'\\''s/inst/launcher.mjs' "$@"\n`),
    "/it's/inst",
  );
  assert.equal(launcherInstallation('#!/usr/bin/env node\nconsole.log(1)\n'), null);
  const dir = mkdtempSync(join(tmpdir(), 'bench-cli-path-'));
  writeFileSync(join(dir, 'nforge'), '#!/bin/sh\nexec /somewhere/else "$@"\n');
  assert.equal(pathInstallation(dir), null);
  assert.equal(existsSync(join(dir, 'current')), false);
});

const settings = over => ({
  definitions: [{ checkId: 'c', name: 'verify', definition: benchCheckDigest(), version: 1 }],
  runner: { digest: 'r', configuration: { provider: 'github-actions' } },
  actions: { repository: FORGE_RUNNER.repository, runsOn: FORGE_RUNNER.runsOn },
  checkCallbackConfigured: true,
  agentLandsOnPass: true,
  ...over,
});

test('forge-check: the bench check is bash .bench/ci.sh, compared by its recorded definition digest', () => {
  assert.deepEqual(BENCH_CHECK.args, ['.bench/ci.sh']);
  assert.equal(BENCH_CHECK.executable, 'bash');
  assert.match(benchCheckDigest(), /^[0-9a-f]{64}$/);
  assert.deepEqual(checkSettingsState(settings({})), { done: true, missing: [] });
  assert.deepEqual(
    checkSettingsState(settings({ definitions: [], runner: null, actions: null, agentLandsOnPass: false }))
      .missing,
    ['check', 'runner', 'acceptance'],
  );
  const foreign = checkSettingsState(
    settings({ definitions: [{ name: 'verify', definition: 'f'.repeat(64) }] }),
  );
  assert.equal(foreign.done, false);
  assert.match(foreign.problems.join(), /does not overwrite a check it did not define/);
  const runner = checkSettingsState(
    settings({ actions: { repository: 'me/other', runsOn: 'ubuntu-latest' } }),
  );
  assert.match(runner.problems.join(), /needs NanthAI\/nanthai-forge/);
  const key = checkSettingsState(settings({ checkCallbackConfigured: false }));
  assert.match(key.problems.join(), /hosted check key/);
});

test('forge-check digest is the one Forge records for that command (no drift from hostedCheckDefinition)', async () => {
  const { hostedCheckDefinition } = await import('../dist/hosted-check.js');
  const recorded = hostedCheckDefinition(
    BENCH_CHECK,
    '00000000-0000-4000-8000-000000000000',
    '2026-11-07T00:00:00.000Z',
  );
  assert.equal(recorded.definition, benchCheckDigest());
});
