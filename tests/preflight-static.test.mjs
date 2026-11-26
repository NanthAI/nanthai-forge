// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../dist/state/hash.js';
import { sourceTree } from '../dist/source-tree.js';
import {
  orderByHistory,
  preflightFileStats,
  preflightPlan,
  preflightRuntime,
  runPreflight,
} from '../dist/agent-preflight.js';
import {
  globRegExp,
  preflightGuards,
  forgeWritten,
  runStaticChecks,
  selectGuards,
  selectStaticChecks,
  staticChecks,
} from '../dist/agent-preflight-static.js';

const laneId = '22222222-2222-4222-8222-222222222222';
const healthy = {
  ok: true,
  latencyMs: 1,
  fseventsdRssMb: null,
  fseventsdCpuPercent: null,
  reason: null,
  attempts: [],
};
test.beforeEach(t => t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy));

const manifest = (staticChecks, scripts = {}) =>
  JSON.stringify({
    type: 'module',
    scripts,
    forge: { checkRecipe: 'forge-standard-v1', preflight: { static: staticChecks } },
  });

test('without a declaration only a conventionally named formatter check runs; an unknown check script is never guessed', () => {
  assert.deepEqual(staticChecks('{"scripts":{"check":"npm test"}}'), []);
  const [format] = staticChecks('{"scripts":{"format:check":"oxfmt --check","check":"npm test"}}');
  assert.deepEqual(format.command, ['npm', 'run', '-s', 'format:check']);
  assert.equal(format.source, 'conventional');
  assert.deepEqual(staticChecks('not json'), []);
  assert.deepEqual(staticChecks(undefined), []);
});

test('a declaration is used as written, and a check the project no longer defines fails loudly', () => {
  const checks = staticChecks(
    manifest(
      [
        'check',
        { name: 'docs', command: ['node', 'x.mjs'], inputs: ['docs/**'] },
        { script: 'fmt', inputs: ['**/*.ts'] },
      ],
      { check: 'a', fmt: 'b' },
    ),
  );
  assert.deepEqual(
    checks.map(item => [item.name, item.command.join(' '), item.inputs]),
    [
      ['check', 'npm run -s check', null],
      ['docs', 'node x.mjs', ['docs/**']],
      ['fmt', 'npm run -s fmt', ['**/*.ts']],
    ],
  );
  assert.deepEqual(
    staticChecks(manifest([], { 'format:check': 'x' })),
    [],
    'an empty declaration turns the defaults off',
  );
  assert.throws(() => staticChecks(manifest(['gone'], {})), /cannot run/);
  assert.throws(() => staticChecks(manifest([{ inputs: ['a'] }])), /cannot run/);
});

test('inputs scope a check to the paths it reads; untouched checks are named', () => {
  const globs = {
    '**/*.{ts,mjs}': [
      ['a.ts', true],
      ['src/deep/b.mjs', true],
      ['a.md', false],
      ['src/a.tsx', false],
    ],
    'docs/**': [
      ['docs/a.md', true],
      ['docs/x/y.png', true],
      ['src/docs/a.md', false],
    ],
    '*.md': [
      ['README.md', true],
      ['docs/README.md', false],
    ],
    '.oxfmtrc.json': [
      ['.oxfmtrc.json', true],
      ['a/.oxfmtrc.json', false],
    ],
  };
  for (const [glob, cases] of Object.entries(globs))
    for (const [path, expected] of cases)
      assert.equal(globRegExp(glob).test(path), expected, `${glob} vs ${path}`);
  const checks = staticChecks(
    manifest(
      [
        'always',
        { name: 'ts', script: 'ts', inputs: ['**/*.ts'] },
        { name: 'md', script: 'md', inputs: ['*.md'] },
      ],
      {
        always: 'x',
        ts: 'x',
        md: 'x',
      },
    ),
  );
  const { selected, untouched } = selectStaticChecks(checks, ['src/a.ts']);
  assert.deepEqual(
    selected.map(item => item.name),
    ['always', 'ts'],
  );
  assert.deepEqual(untouched, ['md']);
});

test('a static check that fails fails preflight before any build or test and names itself; passes and timeouts are reported', () => {
  const results = runStaticChecks(
    process.cwd(),
    [
      { name: 'ok', command: [process.execPath, '-e', ''], inputs: null, source: 'declared' },
      { name: 'bad', command: [process.execPath, '-e', 'process.exit(3)'], inputs: null, source: 'declared' },
      {
        name: 'slow',
        command: [process.execPath, '-e', 'setTimeout(()=>{},5000)'],
        inputs: null,
        source: 'declared',
      },
    ],
    process.env,
    300,
  );
  assert.deepEqual(
    results.map(item => [item.name, item.outcome]),
    [
      ['ok', 'passed'],
      ['bad', 'failed'],
      ['slow', 'timed-out'],
    ],
  );
});

function fixture(t, checks, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-preflight-static-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = new Map([
    ['package.json', manifest(checks, { 'format:check': 'x' })],
    ['scripts/forge-check.mjs', ''],
    ['src/a.ts', 'export const n = 1;'],
    ['src/b.ts', 'export const n = 2;'],
    ['tests/a.test.mjs', "import test from 'node:test'; import '../src/a.ts'; test('a', () => {});"],
    ['tests/b.test.mjs', "import test from 'node:test'; import '../src/b.ts'; test('b', () => {});"],
    ...Object.entries(extra),
  ]);
  for (const [path, body] of bytes) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const files = () => [...bytes].map(([path, body]) => ({ path, blob: digest(body), mode: 'file' }));
  const plan = (paths, options) =>
    preflightPlan(root, { paths, complete: true }, { laneId, files: files() }, options);
  const run = p => runPreflight(root, laneId, digest(JSON.stringify(files())), p, sourceTree(files()));
  return { root, plan, run };
}

test('preflight runs the static checks a change triggers before tests, and a failure skips the tests', t => {
  const f = fixture(t, [
    {
      name: 'bad format',
      command: [process.execPath, '-e', 'console.error("unformatted"); process.exit(1)'],
      inputs: ['**/*.ts'],
    },
    { name: 'docs', command: [process.execPath, '-e', ''], inputs: ['docs/**'] },
  ]);
  const plan = f.plan(['src/a.ts']);
  assert.deepEqual(
    plan.static.selected.map(item => item.name),
    ['bad format'],
  );
  assert.deepEqual(plan.static.untouched, ['docs']);
  const receipt = f.run(plan);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.exitCode, 1);
  assert.deepEqual(
    receipt.static.map(item => [item.name, item.outcome]),
    [['bad format', 'failed']],
  );
  assert.equal(receipt.tests, plan.tests.length, 'planned tests are counted, none was started');
  assert.equal(receipt.testMs, undefined, 'no test process ran');
  assert.equal(receipt.buildMs, undefined);
  assert.deepEqual(preflightFileStats(f.root), {}, 'nothing was observed, so nothing is recorded');
});

test('a passing static check lets the tests run; a docs-only change still runs the checks that read docs', t => {
  const f = fixture(t, [{ name: 'ok', command: [process.execPath, '-e', ''], inputs: null }], {
    'docs/guide.md': '# Guide\n',
  });
  const code = f.plan(['src/a.ts']);
  const receipt = f.run(code);
  assert.equal(receipt.passed, true);
  assert.deepEqual(
    receipt.static.map(item => item.outcome),
    ['passed'],
  );
  assert.ok(receipt.testMs !== undefined);
  const docs = f.plan(['docs/guide.md']);
  assert.deepEqual(docs.tests, []);
  assert.deepEqual(
    docs.static.selected.map(item => item.name),
    ['ok'],
  );
  const docsReceipt = f.run(docs);
  assert.equal(docsReceipt.passed, true);
  assert.deepEqual(
    docsReceipt.static.map(item => item.outcome),
    ['passed'],
  );
});

test('a misdeclared static check makes the plan unavailable with its reason instead of silently skipping', t => {
  const f = fixture(t, ['missing-script']);
  const plan = f.plan(['src/a.ts']);
  assert.equal(plan.status, 'unavailable');
  assert.match(plan.reason, /cannot run/);
});

test('likely-failing tests run first, then the cheapest; the watch tier keeps its evidence order', () => {
  const tiers = [
    { tier: 'direct', tests: ['a', 'b', 'c', 'd'] },
    { tier: 'watch', tests: ['w1', 'w2', 'w3'] },
  ];
  const stats = {
    a: { ms: 9000, failed: false },
    b: { ms: 100, failed: false },
    c: { ms: 5000, failed: true },
    w2: { ms: 1, failed: true },
  };
  const [direct, watch] = orderByHistory(tiers, stats, 1000);
  // c failed last time; then b (100 ms), d (unknown = 1000 ms fallback), a (9000 ms).
  assert.deepEqual(direct.tests, ['c', 'b', 'd', 'a']);
  assert.deepEqual(watch.tests, ['w2', 'w1', 'w3']);
});

test('after a failure the remaining groups are not started and the receipt says so; passes are kept', t => {
  const f = fixture(t, [], {
    'tests/a.test.mjs':
      "import test from 'node:test'; import '../src/a.ts'; test('a', () => { throw new Error('boom'); });",
  });
  const agent = join(f.root + '.forge-client', 'agent');
  mkdirSync(agent, { recursive: true });
  // Slow, previously failing a runs first; each file is its own group at 40 s per file.
  writeFileSync(
    join(agent, 'preflight-files.json'),
    JSON.stringify({
      'tests/a.test.mjs': { ms: 40000, failed: true },
      'tests/b.test.mjs': { ms: 40000, failed: false },
    }),
  );
  const plan = f.plan(['src/a.ts', 'src/b.ts']);
  assert.deepEqual(plan.tests, ['tests/a.test.mjs', 'tests/b.test.mjs']);
  const receipt = f.run(plan);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.stoppedForFailure, 1);
  assert.equal(receipt.tests, 1);
  assert.equal(receipt.deferredTests, 1);
  assert.deepEqual(Object.keys(preflightFileStats(f.root)).sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.equal(preflightFileStats(f.root)['tests/a.test.mjs'].failed, true);
});

test('observed per-file time and the slowest files are recorded for the next plan', t => {
  const f = fixture(t, []);
  const receipt = f.run(f.plan(['src/a.ts', 'src/b.ts']));
  assert.equal(receipt.passed, true);
  const stats = preflightFileStats(f.root);
  assert.deepEqual(Object.keys(stats).sort(), ['tests/a.test.mjs', 'tests/b.test.mjs']);
  assert.ok(stats['tests/a.test.mjs'].ms >= 0 && stats['tests/a.test.mjs'].failed === false);
  assert.ok(receipt.slowest.length >= 1 && receipt.slowest.length <= 3);
});

test('budget the ranked tiers leave over runs the cheapest timed tests the budget cut, last; unranked coverage never fills it', t => {
  const near = "import test from 'node:test'; import './near-fixture.mjs'; test('d', () => {});";
  const f = fixture(t, [], {
    // Two modules between src/a.ts and these tests: the trimmable near tier.
    'src/m1.ts': "import './a.ts';",
    'src/m2.ts': "import './m1.ts';",
    'tests/near-fixture.mjs': "import '../src/m2.ts';",
    'tests/d3.test.mjs': "import test from 'node:test'; import '../src/m2.ts'; test('d', () => {});",
    'tests/d1.test.mjs': near,
    'tests/d2.test.mjs': near,
    // Reaches src/a.ts only through a computed path: landing coverage, not evidence about this change.
    'tests/dynamic.test.mjs':
      "import test from 'node:test'; test('d', async () => { await import(process.argv[2] ?? 'node:fs'); });",
  });
  const agent = join(f.root + '.forge-client', 'agent');
  mkdirSync(agent, { recursive: true });
  writeFileSync(
    join(agent, 'preflight-files.json'),
    JSON.stringify({
      'tests/d1.test.mjs': { ms: 50, failed: false },
      'tests/d2.test.mjs': { ms: 10, failed: false },
      'tests/d3.test.mjs': { ms: 600000, failed: false },
      'tests/dynamic.test.mjs': { ms: 5, failed: false },
    }),
  );
  const plan = f.plan(['src/a.ts']);
  assert.deepEqual(plan.tests.slice(0, 1), ['tests/a.test.mjs']);
  // d3 is closest (no shared fixture) but takes ten minutes, so the budget cuts the near tier there;
  // the cut d2 (10 ms) and d1 (50 ms) fill the leftover, cheapest first.
  assert.deepEqual(plan.tests.slice(-2), ['tests/d2.test.mjs', 'tests/d1.test.mjs']);
  assert.ok(plan.deferredTests.includes('tests/d3.test.mjs'));
  assert.ok(plan.deferredTests.includes('tests/dynamic.test.mjs'), 'unranked coverage never fills');
  assert.equal(plan.local.filler, 2);
  assert.match(plan.local.summary, /2 cheap test file\(s\) timed in earlier runs use the leftover budget/);
  // The estimate is what the wall-time cap allows: at most the budget plus the longest planned file.
  assert.ok(plan.estimateMinutes >= 1);
  assert.ok(plan.estimateMinutes <= Math.ceil((plan.local.budgetSeconds + 4) / 60));
});

const guardManifest = guards =>
  JSON.stringify({
    type: 'module',
    scripts: {},
    forge: { checkRecipe: 'forge-standard-v1', preflight: { guards } },
  });
const runtimeGuard = {
  name: 'runtime',
  tests: ['tests/runtime-guard.test.mjs'],
  inputs: ['src/**'],
};
// Stands in for convex-runtime-imports: it finds the offence by reading source, not by importing it.
const runtimeGuardTest = `import test from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
test('no Node global in src', () => assert.doesNotMatch(readFileSync(new URL('../src/' + 'size.ts', import.meta.url), 'utf8'), /Buffer\\./));`;

test('guards are declared once with path rules; a malformed one or a missing test fails loudly', () => {
  const has = path => path === 'tests/runtime-guard.test.mjs';
  const guards = preflightGuards(guardManifest([runtimeGuard]), has);
  assert.deepEqual(guards, [runtimeGuard]);
  assert.deepEqual(selectGuards(guards, ['src/x.ts']).selected, guards);
  assert.deepEqual(selectGuards(guards, ['docs/x.json']), { selected: [], untouched: ['runtime'] });
  assert.deepEqual(preflightGuards('{"scripts":{}}', has), []);
  assert.deepEqual(preflightGuards('not json', has), []);
  assert.throws(
    () => preflightGuards(guardManifest([{ name: 'gone', tests: ['tests/gone.test.mjs'] }]), has),
    /cannot run/,
  );
  assert.throws(
    () => preflightGuards(guardManifest([{ tests: ['tests/runtime-guard.test.mjs'] }]), has),
    /cannot run/,
  );
});

test('a triggered guard runs first and the time budget never trims it, even where no import reaches it', t => {
  const f = fixture(t, [], {
    'package.json': guardManifest([
      runtimeGuard,
      { name: 'docs only', tests: ['tests/b.test.mjs'], inputs: ['docs/**'] },
    ]),
    'src/size.ts': 'export const size = (s: string) => s.length;',
    'tests/runtime-guard.test.mjs': runtimeGuardTest,
  });
  const plan = f.plan(['src/a.ts'], { budgetSeconds: 0 });
  assert.equal(plan.tests[0], 'tests/runtime-guard.test.mjs');
  assert.ok(plan.tests.includes('tests/a.test.mjs') || plan.deferredTests.includes('tests/a.test.mjs'));
  assert.equal(plan.local.mandatory >= 1, true);
  assert.deepEqual(
    plan.local.guards.map(item => item.name),
    ['runtime'],
  );
  assert.equal(typeof plan.local.guards[0].seconds, 'number');
  assert.match(plan.local.summary, /Guards run early and are protected from the local budget: runtime ~\d/);
  assert.ok(!plan.local.tierTests.mandatory.includes('tests/b.test.mjs'), 'an untouched guard stays out');
});

test("a demoted guard stays in the plan, outside local.guards, reserving none of the learned set's room", t => {
  const has = path => path === 'tests/runtime-guard.test.mjs';
  const demoted = { ...runtimeGuard, demote: true };
  assert.deepEqual(preflightGuards(guardManifest([demoted]), has), [demoted]);
  assert.deepEqual(preflightGuards(guardManifest([{ ...runtimeGuard, demote: 'yes' }]), has), [runtimeGuard]);
  const f = fixture(t, [], {
    'package.json': guardManifest([demoted]),
    'src/size.ts': 'export const size = (s: string) => s.length;',
    'tests/runtime-guard.test.mjs': runtimeGuardTest,
  });
  const plan = f.plan(['src/a.ts'], { budgetSeconds: 0 });
  assert.ok(plan.local.tierTests.mandatory.includes('tests/runtime-guard.test.mjs'), 'still planned');
  assert.ok(!(plan.local.guards ?? []).some(item => item.name === 'runtime'), 'not a never-stopped guard');
});

test('replay (b78ca196): a Node global in a Convex-loaded src file fails preflight locally, before the budget', t => {
  const f = fixture(t, [], {
    'package.json': guardManifest([runtimeGuard]),
    'src/size.ts': 'export const size = (s: string) => Buffer.byteLength(s);',
    'tests/runtime-guard.test.mjs': runtimeGuardTest,
  });
  const plan = f.plan(['src/size.ts'], { budgetSeconds: 0 });
  assert.deepEqual(plan.tests, ['tests/runtime-guard.test.mjs']);
  const receipt = f.run(plan);
  assert.equal(receipt.passed, false);
  assert.equal(receipt.stoppedForTime, undefined);
  assert.deepEqual(
    receipt.slowest.map(item => item.file),
    ['tests/runtime-guard.test.mjs'],
  );
});

test('forge.json declares static checks and guards for any language; package.json forge stays the fallback', () => {
  const neutral = JSON.stringify({
    preflight: {
      static: [{ name: 'vet', command: ['go', 'vet', './...'], inputs: ['**/*.go'] }],
      guards: [{ name: 'api', tests: ['api/api_test.go'], inputs: ['api/**'] }],
    },
    install: { later: true },
  });
  const has = path => path === 'api/api_test.go';
  // A Go repository with no package.json at all.
  assert.deepEqual(
    staticChecks(undefined, neutral).map(check => [check.name, check.command.join(' '), check.source]),
    [['vet', 'go vet ./...', 'declared']],
  );
  assert.deepEqual(preflightGuards(undefined, has, neutral), [
    { name: 'api', tests: ['api/api_test.go'], inputs: ['api/**'] },
  ]);
  // Forge's own package.json config is read unchanged when there is no forge.json.
  const forge = JSON.parse(manifest(['check'], { check: 'x' }));
  assert.deepEqual(staticChecks(JSON.stringify(forge)), staticChecks(JSON.stringify(forge), undefined));
  assert.equal(staticChecks(JSON.stringify(forge))[0].name, 'check');
  // forge.json without a static key leaves package.json's declaration in force.
  assert.equal(staticChecks(JSON.stringify(forge), '{"preflight":{}}')[0].name, 'check');
  // A setting in both files, a malformed forge.json or a broken entry fails loudly, naming the file.
  assert.throws(() => staticChecks(JSON.stringify(forge), '{"preflight":{"static":[]}}'), /both forge\.json/);
  assert.throws(() => staticChecks(undefined, '{"preflight":'), /forge\.json is not JSON/);
  assert.throws(() => preflightGuards(undefined, has, '[]'), /forge\.json must hold a JSON object/);
  assert.throws(
    () => staticChecks(undefined, '{"preflight":{"static":["lint"]}}'),
    /forge\.json preflight\.static/,
  );
  assert.throws(
    () => preflightGuards(undefined, () => false, neutral),
    /forge\.json preflight\.guards names a guard that cannot run/,
  );
});

// Incident 060fb653: a configured whole-repo command whose output names no file is judged against a
// copy of the Lane's base; only a failure the base does not have refuses.
test('a whole-repo command that names no file is advisory when base fails the same way, and refuses when base passes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-static-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'lane');
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes/debt.txt'), 'TODO: old debt\n');
  writeFileSync(join(root, 'changed.txt'), 'new text\n');
  const check = {
    name: 'repo lint',
    command: [
      process.execPath,
      '-e',
      "if (require('fs').readFileSync('notes/debt.txt','utf8').includes('TODO')) { console.error('1 problem found'); process.exit(1) }",
    ],
    inputs: null,
    source: 'declared',
  };
  const judge = (changed, base) =>
    runStaticChecks(root, [check], process.env, 10_000, {
      changed,
      base: path => base[path],
      scratch: join(dir, 'scratch'),
    })[0];
  const preExisting = judge(['changed.txt'], { 'changed.txt': Buffer.from('old text\n') });
  assert.equal(preExisting.outcome, 'pre-existing');
  assert.match(preExisting.advisory, /pre-existing on the Lane's base: same diagnostic, not blocking/);
  const added = judge(['notes/debt.txt'], { 'notes/debt.txt': Buffer.from('clean\n') });
  assert.equal(added.outcome, 'failed');
  assert.match(added.excerpt, /passes on the Lane's base: this change causes it/);
  // A file the change added (absent on base) is removed from the copy; unknown base bytes cannot judge.
  assert.equal(judge(['changed.txt'], { 'changed.txt': null }).outcome, 'pre-existing');
  const unknown = judge(['changed.txt'], {});
  assert.equal(unknown.outcome, 'unjudged');
  assert.match(unknown.advisory, /no copy of the Lane's base/);
  assert.deepEqual(readdirSync(join(dir, 'scratch')), [], 'the base copy is removed after the run');
  // Unknown changed paths and a program that is not installed advise, never pass silently.
  assert.equal(judge(null, {}).outcome, 'unjudged');
  const missing = runStaticChecks(
    root,
    [{ ...check, command: ['sh', '-c', 'forge-no-such-program-060fb653'] }],
    process.env,
    10_000,
    { changed: ['changed.txt'] },
  )[0];
  assert.equal(missing.outcome, 'unjudged');
  assert.match(missing.advisory, /not installed here \(exit 127\)/);
  // Without a scope (no change to judge against) every failure still refuses, as before.
  assert.equal(runStaticChecks(root, [check], process.env, 10_000)[0].outcome, 'failed');
});

test('a failure naming an untouched file the base copy does not name is new: the change broke it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-static-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'lane');
  mkdirSync(root, { recursive: true });
  // b.txt imports a name a.txt exported; the change removed it from a.txt, so b.txt (untouched) breaks.
  writeFileSync(join(root, 'a.txt'), 'defines: nothing\n');
  writeFileSync(join(root, 'b.txt'), 'uses: x\n');
  writeFileSync(join(root, 'c.txt'), 'debt\n');
  const check = {
    name: 'cross-file',
    command: [
      process.execPath,
      '-e',
      "const fs=require('fs'); const bad=['c.txt']; if (!fs.readFileSync('a.txt','utf8').includes('NAME')) bad.push('b.txt'); for (const f of bad) console.error(f + ': error'); process.exit(1)",
    ],
    inputs: null,
    source: 'declared',
  };
  const [result] = runStaticChecks(root, [check], process.env, 10_000, {
    changed: ['a.txt'],
    base: () => Buffer.from('defines: NAME\n'),
    scratch: join(dir, 'scratch'),
  });
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.files, ['b.txt']);
  assert.match(result.excerpt, /new compared with the Lane's base: b\.txt/);
});

test('c717a2c2: a new source file can change the diagnostic on an already-failing generated file', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-static-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'lane');
  mkdirSync(root);
  writeFileSync(join(root, 'generated.js'), '');
  writeFileSync(join(root, 'new-source.js'), '');
  const check = {
    name: 'check generated module',
    command: [
      process.execPath,
      '-e',
      "const added = require('fs').existsSync('new-source.js'); console.error('generated.js: ' + (added ? 'new import fails' : 'old import fails')); process.exit(1)",
    ],
    inputs: null,
    source: 'declared',
  };
  const run = (base, command = check.command, hasBaseFile) =>
    runStaticChecks(root, [{ ...check, command }], process.env, 10_000, {
      changed: ['new-source.js'],
      base,
      hasBaseFile,
      scratch: join(dir, 'scratch'),
    })[0];
  assert.equal(run(() => null).outcome, 'unjudged');
  assert.equal(run(undefined).outcome, 'unjudged');
  const longDiagnostic = [
    ...check.command.slice(0, 2),
    check.command[2].replace('process.exit(1)', "console.error('x'.repeat(17_000)); process.exit(1)"),
  ];
  assert.equal(run(() => null, longDiagnostic).outcome, 'unjudged');
  const staleGenerated = [
    ...check.command.slice(0, 2),
    "console.error('generated.js: new import fails'); process.exit(1)",
  ];
  assert.equal(
    run(
      () => null,
      staleGenerated,
      () => false,
    ).outcome,
    'unjudged',
  );
});

test('past the output scan cap a changed path is still found and refuses; a capped scan claims nothing', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-static-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'lane');
  mkdirSync(join(root, '.forge'), { recursive: true });
  writeFileSync(join(root, '.forge/hosted-lane.json'), '{}');
  writeFileSync(join(root, 'own.ts'), 'x');
  const noisy = own => ({
    name: 'noisy lint',
    command: [
      process.execPath,
      '-e',
      `console.error('.forge/hosted-lane.json: error'); for (let i = 0; i < 6000; i++) console.error('token' + i); ${own ? "console.error('own.ts: error');" : ''} process.exit(1)`,
    ],
    inputs: null,
    source: 'declared',
  });
  const run = own => runStaticChecks(root, [noisy(own)], process.env, 10_000, { changed: ['own.ts'] })[0];
  const refused = run(true);
  assert.equal(refused.outcome, 'failed');
  assert.deepEqual(refused.files, ['own.ts']);
  const capped = run(false);
  assert.equal(capped.outcome, 'unjudged', 'never forge-metadata from a capped scan');
  assert.match(capped.advisory, /too long to scan in full/);
});

test('a changed path with spaces is matched whole in relative, ./, quoted and absolute output; a part of it is uncertain', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-static-scope-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'lane');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/bad name.md'), 'x');
  writeFileSync(join(root, 'legacy.md'), 'x');
  const said = text => ({
    name: 'fmt',
    command: [process.execPath, '-e', `console.error(${JSON.stringify(text)}); process.exit(1)`],
    inputs: null,
    source: 'declared',
  });
  const run = text =>
    runStaticChecks(root, [said(text)], process.env, 10_000, { changed: ['docs/bad name.md'] })[0];
  for (const text of [
    'legacy.md\ndocs/bad name.md:3:1 trailing space',
    '[warn] ./docs/bad name.md',
    `"${join(root, 'docs/bad name.md')}" is not formatted`,
    'legacy.md, docs/bad\\ name.md',
  ]) {
    const result = run(text);
    assert.equal(result.outcome, 'failed', text);
    assert.deepEqual(result.files, ['docs/bad name.md'], text);
  }
  // Named only in part (URL-encoded): not "only untouched files"; with no base copy, unjudged.
  const part = run('legacy.md\ndocs/bad%20name.md');
  assert.equal(part.outcome, 'unjudged');
  assert.match(part.advisory, /only in part/);
  // A longer name that contains it is a different file.
  assert.equal(run('legacy.md\ndocs/bad name.md.bak').outcome, 'unjudged');
});

test('only the root .forge folder and root dependency link count as Forge-written in this check', () => {
  assert.equal(forgeWritten('.forge/hosted-lane.json'), true);
  assert.equal(forgeWritten('node_modules/pkg/index.js'), true);
  assert.equal(forgeWritten('src/.forge/x.json'), false);
  assert.equal(forgeWritten('web/node_modules/pkg/index.js'), false);
  assert.equal(forgeWritten('.forgery/x.json'), false);
});
