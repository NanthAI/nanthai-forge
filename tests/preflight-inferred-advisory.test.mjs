// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveAgentDefaults } from '../dist/agent-parallel-defaults.js';
import { finishGates } from '../dist/agent-default-gates.js';
import {
  preflightPlan,
  preflightRuntime,
  readPreflightReceipt,
  runPreflight,
  PREFLIGHT_SECONDS_PER_PACKAGE_COMMAND,
} from '../dist/agent-preflight.js';
import { rememberHostedCheck, hostedCheckSeconds } from '../dist/preflight-hosted-timing.js';
import { learnFromLanding } from '../dist/preflight-learned.js';
import { missingToolchain } from '../dist/preflight-toolchain.js';

// d95d9b41: with no declared runner, preflight=require made Forge's own inferred package commands
// mandatory, so a local failure for environment reasons (test data CI fetches, a missing toolchain)
// refused a landing whose hosted check passed, and a Gradle build was priced as one 4 s test file.
const healthy = {
  ok: true,
  latencyMs: 1,
  fseventsdRssMb: null,
  fseventsdCpuPercent: null,
  reason: null,
  attempts: [],
};
test.beforeEach(t => t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy));

const lane = { laneId: '22222222-2222-4222-8222-222222222222', head: 'c'.repeat(64) };
const require = effectiveAgentDefaults({});
const code = value => error => error.code === value || error.data?.code === value;
const changed = paths => ({ unacknowledgedOverlaps: { items: [] }, changedPaths: { paths, complete: true } });

function repo(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-inferred-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return { root, dir };
}
/** A PATH holding only these fake programs (shell scripts with the given exit codes). */
function fakePath(t, dir, programs) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const [name, exit] of Object.entries(programs)) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexit ${exit}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const previous = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    process.env.PATH = previous;
  });
}

const cargo = {
  'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nresolver = "2"\n',
  'crates/jiter/Cargo.toml': '[package]\nname = "jiter"\nversion = "0.1.0"\n',
  'crates/jiter/build.rs': 'fn main() {}\n',
  'crates/jiter/src/lib.rs': '',
};

test('an inferred cargo command that fails (missing CI test data) is reported, never required', t => {
  const { root, dir } = repo(t, cargo);
  const advice = changed(['crates/jiter/build.rs']);
  const plan = preflightPlan(root, advice.changedPaths);
  assert.equal(plan.status, 'planned');
  assert.deepEqual(plan.tests, ['package:.:cargo test -p jiter']);
  assert.match(plan.advisory, /never required/);
  // Before a run: advised, not PREFLIGHT_REQUIRED, under the default require policy.
  const before = finishGates(root, require, lane, advice);
  assert.equal(before.preflight.status, 'advised');
  assert.match(before.preflight.reason, /Declare preflight\.tests in forge\.json/);
  // cargo exits 101 (the json-cases corpus CI fetches is absent): a failed run, still not a refusal.
  fakePath(t, dir, { cargo: 101 });
  const receipt = runPreflight(root, lane.laneId, lane.head, plan);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.exitCode, 101);
  assert.equal(receipt.environment, undefined);
  const after = finishGates(root, require, lane, advice);
  assert.equal(after.preflight.status, 'advised');
  assert.deepEqual(after.preflight.lastRun, { passed: false, exitCode: 101, at: receipt.at });
});

test('a declared runner that fails is still required', t => {
  const { root } = repo(t, {
    ...cargo,
    'forge.json': JSON.stringify({
      preflight: {
        tests: { glob: 'crates/*/tests/*.rs', command: [process.execPath, '-e', 'process.exit(1)'] },
      },
    }),
    'crates/jiter/tests/cases.rs': '',
  });
  const advice = changed(['crates/jiter/tests/cases.rs']);
  const plan = preflightPlan(root, advice.changedPaths);
  assert.equal(plan.advisory, undefined);
  assert.throws(() => finishGates(root, require, lane, advice), code('PREFLIGHT_REQUIRED'));
  const receipt = runPreflight(root, lane.laneId, lane.head, plan);
  assert.equal(receipt.passed, false);
  assert.throws(
    () => finishGates(root, require, lane, advice),
    error => code('PREFLIGHT_REQUIRED')(error) && error.message.includes('Its last run failed.'),
  );
});

test('a missing toolchain is an environment result, not a failed run', t => {
  const { root, dir } = repo(t, cargo);
  const advice = changed(['crates/jiter/build.rs']);
  const plan = preflightPlan(root, advice.changedPaths);
  fakePath(t, dir, {}); // no cargo on this machine
  const receipt = runPreflight(root, lane.laneId, lane.head, plan);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.exitCode, null, 'nothing failed');
  assert.equal(receipt.environment.code, 'TOOLCHAIN_MISSING');
  assert.deepEqual(receipt.environment.missing, ['cargo']);
  assert.deepEqual(receipt.environment.units, plan.tests);
  assert.equal(receipt.tests, 0);
  assert.deepEqual(readPreflightReceipt(root, lane.laneId), receipt);
  const gate = finishGates(root, require, lane, advice);
  assert.equal(gate.preflight.status, 'environment');
  assert.equal(gate.preflight.code, 'TOOLCHAIN_MISSING');
  // Exit 127 (a wrapper that could not find its program) is the same result.
  const shell = runPreflight(root, lane.laneId, lane.head, {
    ...plan,
    packageCommands: { [plan.tests[0]]: { cwd: '', argv: ['/bin/sh', '-c', 'exit 127'] } },
  });
  assert.equal(shell.environment.code, 'TOOLCHAIN_MISSING');
  assert.deepEqual(shell.environment.missing, ['/bin/sh']);
  // A declared runner whose program is not installed is environment too: it never blocks.
  const declared = repo(t, {
    'forge.json': JSON.stringify({
      preflight: { tests: { glob: 'tests/test_*.py', command: ['forge-no-such-pytest', '{files}'] } },
    }),
    'tests/test_a.py': '',
  });
  const pyAdvice = changed(['tests/test_a.py']);
  const pyPlan = preflightPlan(declared.root, pyAdvice.changedPaths);
  const py = runPreflight(declared.root, lane.laneId, lane.head, pyPlan);
  assert.equal(py.environment.code, 'TOOLCHAIN_MISSING');
  assert.equal(finishGates(declared.root, require, lane, pyAdvice).preflight.status, 'environment');
  // Gradle and Maven wrappers need a JVM besides the wrapper itself.
  assert.equal(
    missingToolchain({ argv: ['/bin/sh'], ecosystem: 'gradle' }, root, { PATH: join(dir, 'bin') }),
    'java',
  );
  assert.equal(missingToolchain({ argv: ['/bin/sh'], ecosystem: 'cargo' }, root, { PATH: '' }), null);
});

const gradle = {
  'settings.gradle.kts': 'rootProject.name = "fx"\ninclude(":core", ":app")\n',
  'build.gradle.kts': '// root\n',
  gradlew: '',
  'core/build.gradle.kts': 'plugins { `java-library` }\n',
  'core/src/main/java/Core.java': '',
  'app/build.gradle.kts': 'plugins { application }\ndependencies { implementation(project(":core")) }\n',
  'app/src/main/java/App.java': '',
};

test('a Gradle estimate uses the hosted check timing, then this machine, never the per-file constant', t => {
  const { root } = repo(t, gradle);
  const advice = changed(['core/src/main/java/Core.java']);
  const fresh = preflightPlan(root, advice.changedPaths);
  // core has no test class, so the module graph runs nothing there; app, which depends on it, runs whole.
  // The tree's ./gradlew is not declared, so local preflight runs gradle from PATH.
  assert.deepEqual(fresh.tests, ['package:.:gradle :app:test']);
  assert.equal(fresh.estimateBasis, 'default');
  assert.equal(fresh.estimateMinutes, Math.ceil(PREFLIGHT_SECONDS_PER_PACKAGE_COMMAND / 60));
  // A hosted check of 7.5 min, seen by land or wait in the landing timing it already holds.
  const timing = {
    checkReservedAt: '2026-11-08T10:00:00.000Z',
    ciObservedAt: '2026-11-08T10:00:30.000Z',
    ciEndedAt: '2026-11-08T10:08:00.000Z',
  };
  learnFromLanding(root, { submission: { phase: 'landed', error: null, timing } });
  learnFromLanding(root, { submission: { phase: 'landed', error: null, timing } }); // a replay counts once
  assert.equal(hostedCheckSeconds(root), 450);
  rememberHostedCheck(root, { ciObservedAt: 'x', ciEndedAt: 'y' }); // unreadable: ignored
  assert.equal(hostedCheckSeconds(root), 450);
  const hosted = preflightPlan(root, advice.changedPaths);
  assert.equal(hosted.estimateBasis, 'hosted');
  assert.equal(hosted.estimateMinutes, 8);
  assert.equal(hosted.totalEstimateMinutes, 8);
  const gate = finishGates(root, require, lane, advice);
  assert.equal(gate.preflight.estimateMinutes, 8);
});

const maven = {
  'pom.xml':
    '<project><groupId>fx</groupId><artifactId>parent</artifactId><packaging>pom</packaging><modules><module>core</module><module>web</module></modules></project>',
  mvnw: '',
  'core/pom.xml':
    '<project><parent><groupId>fx</groupId><artifactId>parent</artifactId></parent><artifactId>fx-core</artifactId></project>',
  'core/src/main/java/A.java': '',
  'web/pom.xml':
    '<project><parent><groupId>fx</groupId><artifactId>parent</artifactId></parent><artifactId>fx-web</artifactId><dependencies><dependency><groupId>fx</groupId><artifactId>fx-core</artifactId></dependency></dependencies></project>',
  'web/src/main/java/B.java': '',
};

test('a wrapper script in the tree (gradlew, mvnw) runs in preflight only when the project declares it', t => {
  const wrappers = JSON.stringify({ preflight: { wrappers: true } });
  for (const [files, path, tool, wrapper] of [
    [gradle, 'core/src/main/java/Core.java', 'gradle', './gradlew'],
    [maven, 'core/src/main/java/A.java', 'mvn', './mvnw'],
  ]) {
    const advice = changed([path]);
    const undeclared = preflightPlan(repo(t, files).root, advice.changedPaths);
    assert.equal(undeclared.status, 'planned');
    assert.ok(undeclared.tests.length, undeclared.reason);
    assert.ok(
      undeclared.tests.every(unit => unit.startsWith(`package:.:${tool} `)),
      JSON.stringify(undeclared.tests),
    );
    assert.ok(Object.values(undeclared.packageCommands).every(command => command.argv[0] === tool));
    assert.ok(!undeclared.command.includes(wrapper));
    assert.match(undeclared.advisory, new RegExp(`${wrapper.slice(2)} in the tree is not declared`));
    assert.match(undeclared.advisory, /"preflight": \{"wrappers": true\} in forge\.json/);
    const declared = preflightPlan(repo(t, { ...files, 'forge.json': wrappers }).root, advice.changedPaths);
    assert.ok(Object.values(declared.packageCommands).every(command => command.argv[0] === wrapper));
    assert.doesNotMatch(declared.advisory, /not declared/);
  }
  const bad = repo(t, { ...gradle, 'forge.json': JSON.stringify({ preflight: { wrappers: 'yes' } }) });
  const plan = preflightPlan(bad.root, changed(['core/src/main/java/Core.java']).changedPaths);
  assert.equal(plan.status, 'unavailable');
  assert.match(plan.reason, /forge\.json preflight\.wrappers is true or false/);
});

// 9ab983fd (electron-store, wave-2 run): the test file imports a package the manifest declares but
// the Lane never installed (Forge installs from a lockfile only, and this project has none). The
// run failed with exit 1 and the gate then refused every landing of a comment-only test change.
const electronStore = {
  'package.json': JSON.stringify({
    name: 'electron-store',
    type: 'module',
    dependencies: { conf: '^1.0.0' },
    devDependencies: { electron: '^30.0.0' },
  }),
  'index.js': "import Conf from 'conf';\nexport default Conf;\n",
  'test.js': "import test from 'node:test';\nimport electron from 'electron';\ntest('x', () => electron);\n",
};

test('a test change whose declared dependencies are not installed in the Lane is not refused', t => {
  const { root } = repo(t, electronStore);
  const advice = changed(['test.js']);
  const plan = preflightPlan(root, advice.changedPaths);
  assert.deepEqual(plan.tests, ['test.js']);
  const receipt = runPreflight(root, lane.laneId, lane.head, plan);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.environment.code, 'DEPENDENCIES_MISSING');
  assert.deepEqual(receipt.environment.missing, ['electron']);
  assert.deepEqual(receipt.environment.units, ['test.js']);
  assert.match(receipt.environment.message, /Declared but not installed in this Lane: electron/);
  assert.equal(receipt.failure, undefined);
  // The default policy no longer refuses: the gate reports the setup gap and names the package.
  const gate = finishGates(root, require, lane, advice);
  assert.equal(gate.preflight.status, 'environment');
  assert.equal(gate.preflight.code, 'DEPENDENCIES_MISSING');
  assert.deepEqual(gate.preflight.missing, ['electron']);
});

test('an import no manifest declares, or an installed package, is still a real failure', t => {
  // Undeclared (a typo or a deleted dependency): the change's own failure, so it stays required.
  const typo = repo(t, {
    ...electronStore,
    'test.js': "import test from 'node:test';\nimport nope from 'electrno';\ntest('x', () => nope);\n",
  });
  const advice = changed(['test.js']);
  const receipt = runPreflight(
    typo.root,
    lane.laneId,
    lane.head,
    preflightPlan(typo.root, advice.changedPaths),
  );
  assert.equal(receipt.environment, undefined);
  assert.equal(receipt.exitCode, 1);
  assert.deepEqual(receipt.failure.files, ['test.js']);
  assert.throws(
    () => finishGates(typo.root, require, lane, advice),
    error =>
      code('PREFLIGHT_REQUIRED')(error) &&
      error.message.includes('Its last run failed.') &&
      error.message.includes('Exit 1 on test.js:') &&
      error.message.includes('forge.json'),
  );
  // Declared and installed, but the test itself fails: a real failure, never an environment result.
  const real = repo(t, {
    ...electronStore,
    'node_modules/electron/package.json': '{"name":"electron","main":"index.js"}',
    'node_modules/electron/index.js': 'module.exports = {};\n',
    'test.js':
      "import test from 'node:test';\nimport assert from 'node:assert';\ntest('x', () => assert.equal(1, 2));\n",
  });
  const run = runPreflight(real.root, lane.laneId, lane.head, preflightPlan(real.root, advice.changedPaths));
  assert.equal(run.environment, undefined);
  assert.match(run.failure.excerpt, /AssertionError|1 == 2/);
  assert.throws(() => finishGates(real.root, require, lane, advice), code('PREFLIGHT_REQUIRED'));
});

test('a missing dependency does not hide a second, real failure', t => {
  const { root } = repo(t, {
    ...electronStore,
    'a.test.js':
      "import test from 'node:test';\nimport electron from 'electron';\ntest('a', () => electron);\n",
    'b.test.js':
      "import test from 'node:test';\nimport assert from 'node:assert';\ntest('b', () => assert.equal(1, 2));\n",
  });
  const advice = changed(['a.test.js', 'b.test.js']);
  const receipt = runPreflight(root, lane.laneId, lane.head, preflightPlan(root, advice.changedPaths));
  assert.equal(receipt.environment, undefined, 'b.test.js is unexplained by the missing package');
  assert.equal(receipt.passed, false);
  assert.throws(() => finishGates(root, require, lane, advice), code('PREFLIGHT_REQUIRED'));
});

// 9ab983fd (polyglot run): a project runner (`npx --no-install tsx`) in a package with no lockfile
// cannot start, so every selected file failed with no cause and no way forward.
test('a runner that cannot start for a missing package is advisory and names the install command', t => {
  const { root, dir } = repo(t, {
    'package.json': JSON.stringify({ type: 'module', scripts: { test: 'tsx --test' } }),
    'a.test.ts': "import test from 'node:test'; test('a', () => {});",
    'forge.json': JSON.stringify({
      preflight: { tests: { glob: '*.test.ts', command: ['npx', '--no-install', 'tsx', '--test'] } },
    }),
  });
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'npx'),
    '#!/bin/sh\necho \'npm error npx canceled due to missing packages and no YES option: ["tsx@4.19.2"]\' >&2\nexit 1\n',
  );
  chmodSync(join(bin, 'npx'), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    process.env.PATH = previous;
  });
  const advice = changed(['a.test.ts']);
  const receipt = runPreflight(root, lane.laneId, lane.head, preflightPlan(root, advice.changedPaths));
  assert.equal(receipt.passed, false);
  assert.equal(receipt.environment.code, 'DEPENDENCIES_MISSING');
  assert.deepEqual(receipt.environment.missing, ['tsx']);
  assert.deepEqual(receipt.environment.units, ['a.test.ts']);
  assert.match(receipt.environment.message, /npm install --ignore-scripts/);
  const gate = finishGates(root, require, lane, advice);
  assert.equal(gate.preflight.status, 'environment');
  assert.equal(gate.preflight.code, 'DEPENDENCIES_MISSING');
});
