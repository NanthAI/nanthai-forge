import { compactCheckText } from '../dist/check-compact-output.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import ts from 'typescript';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { coverageArtifact, coverageMarker, fileDigest, v8Touched } from '../scripts/test-coverage.mjs';
import { standardSelection } from '../scripts/test-impact.mjs';
import { retainCheckCoverage, latestCheckCoverage, coverageSourcePath } from '../dist/check-coverage.js';
import { initNative } from '../dist/native-work.js';
import { NativeSource } from '../dist/native-source.js';
import { WorkStore } from '../dist/work-store.js';
import { checkRunSchema } from '../dist/work-types.js';

const head = 'a'.repeat(64);
const files = new Map(
  Object.entries({
    'src/leaf.ts': 'export const leaf = 1;',
    'src/hub.ts':
      "export async function loadLeaf() { return import('./leaf.js'); } export const unrelated = 2;",
    'tests/leaf.test.mjs': "import '../dist/leaf.js';",
    'tests/hub.test.mjs': "import '../dist/hub.js';",
    'tests/files.test.mjs': '',
  }),
);
const tests = [...files.keys()].filter(path => path.startsWith('tests/')).sort();
const row = (test, touched, extra = {}) =>
  coverageMarker + JSON.stringify({ version: 1, head, test, touched, complete: true, ...extra });
function input() {
  return {
    head,
    age: 0,
    artifact: coverageArtifact({
      head,
      files,
      tests,
      lines: [
        row(tests[0], []),
        row('tests/hub.test.mjs', ['src/hub.ts']),
        row('tests/leaf.test.mjs', ['src/leaf.ts']),
      ],
    }),
  };
}
const select = (coverage = input(), changes = {}) =>
  standardSelection({
    files,
    paths: ['src/leaf.ts'],
    coverage,
    env: { FORGE_CHECK_SCOPED: '1' },
    ...changes,
  });

test('shadow reduces a runtime hub recommendation while leaving the actual graph tests unchanged', () => {
  const baseline = select(undefined),
    observed = select();
  assert.deepEqual(observed.tests, baseline.tests);
  assert.equal(observed.coverage.currentCount, 3);
  assert.equal(observed.coverage.coverageCount, 2);
  assert.deepEqual(observed.coverage.tests, ['tests/files.test.mjs', 'tests/leaf.test.mjs']);
  assert.equal(observed.coverage.fallback, null);
  assert.equal(select(input(), { paths: ['src/leaf.ts', 'docs/example.md'] }).coverage.fallback, null);
  const changed = new Map(files);
  changed.set('src/leaf.ts', 'export const leaf = 2;');
  assert.equal(select(input(), { files: changed }).coverage.coverageCount, 2);
});

test('missing, mismatched, malformed, incomplete and stale trace inputs fall back to the exact graph set', () => {
  const cases = [
    undefined,
    { ...input(), head: 'b'.repeat(64) },
    { ...input(), age: 11 },
    { ...input(), age: -1 },
    { ...input(), age: undefined },
    { ...input(), artifact: { ...input().artifact, full: false } },
    { ...input(), artifact: { ...input().artifact, tests: {} } },
    {
      ...input(),
      artifact: {
        ...input().artifact,
        tests: { ...input().artifact.tests, 'tests/leaf.test.mjs': ['../escape'] },
      },
    },
  ];
  for (const coverage of cases) {
    const result = standardSelection({
      files,
      paths: ['src/leaf.ts'],
      coverage,
      env: { FORGE_CHECK_SCOPED: '1' },
    });
    assert.deepEqual(result.coverage.tests, result.tests);
    assert.ok(result.coverage.fallback);
  }
  assert.equal(select({ ...input(), age: 10 }).coverage.fallback, null);
});

test('new/deleted files, changed tests, source drift and unobserved code retain graph selection', () => {
  for (const mutate of [
    f => f.set('src/new.ts', 'new'),
    f => f.delete('src/hub.ts'),
    f => f.set('tests/hub.test.mjs', 'changed'),
    f => f.set('src/hub.ts', 'changed'),
  ]) {
    const changed = new Map(files);
    mutate(changed);
    const result = select(input(), { files: changed });
    assert.ok(result.coverage.fallback);
    assert.deepEqual(result.coverage.tests, result.tests);
  }
  const trace = input();
  trace.artifact.tests['tests/leaf.test.mjs'] = [];
  assert.match(select(trace).coverage.fallback, /no recorded execution/);
});

test('config/schema/fixtures/dynamic domains and full overrides cannot be narrowed', () => {
  for (const path of [
    'src/config.ts',
    'src/schema.ts',
    'tests/fixture.json',
    'convex/schema.ts',
    'tsconfig.json',
    'scripts/a.mjs',
  ]) {
    const result = select(input(), { paths: [path] });
    assert.ok(result.coverage.fallback);
    assert.deepEqual(result.coverage.tests, result.tests);
  }
  for (const extra of [
    { mainCheck: { channel: 'main' } },
    { env: { FORGE_CHECK_FULL: '1', FORGE_CHECK_SCOPED: '1' } },
    { env: {} },
  ]) {
    const result = select(input(), extra);
    assert.equal(result.scope, 'full');
    assert.deepEqual(result.coverage.tests, result.tests);
  }
});

test('artifact decoding rejects wrong source, missing test completions and truncated records; unions replay', () => {
  for (const lines of [
    [],
    [row(tests[0], [])],
    [coverageMarker + '{'],
    [...tests.map(test => row(test, [])), coverageMarker + '{'],
    tests.map(test => row(test, [], { head: 'b'.repeat(64) })),
    tests.map(test => row(test, [], { complete: false })),
  ]) {
    assert.equal(coverageArtifact({ head, files, tests, lines }), null);
    assert.equal(
      coverageArtifact({ head, files, tests, lines: compactCheckText(lines.join('\n')).split('\n') }),
      null,
    );
  }
  const artifact = coverageArtifact({
    head,
    files,
    tests,
    lines: [
      ...tests.map(test => row(test, [])),
      row('tests/hub.test.mjs', ['src/hub.ts']),
      row('tests/hub.test.mjs', ['src/leaf.ts']),
    ],
  });
  assert.deepEqual(artifact.tests['tests/hub.test.mjs'], ['src/hub.ts', 'src/leaf.ts']);
  assert.equal(artifact.digests['src/leaf.ts'], fileDigest(files.get('src/leaf.ts')));
});

test('V8 decoder merges workers and children, maps built core paths, and rejects missing/truncated data', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-v8-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const script = (path, count = 1) => ({
    url: pathToFileURL(resolve(path)).href,
    functions: [{ ranges: [{ count }] }],
  });
  writeFileSync(
    join(directory, 'coverage-1.json'),
    JSON.stringify({ result: [script('dist/leaf.js'), script('dist/hub.js', 0), script('../outside.js')] }),
  );
  writeFileSync(join(directory, 'coverage-2.json'), JSON.stringify({ result: [script('dist/hub.js')] }));
  assert.deepEqual(v8Touched(directory, files), ['src/hub.ts', 'src/leaf.ts']);
  writeFileSync(join(directory, 'coverage-3.json'), '{');
  assert.throws(() => v8Touched(directory, files));
});

test('real supervisor attributes inherited child-process coverage to its test file', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-coverage-run-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const dir of ['src', 'dist', 'tests', 'scripts', 'web', 'convex', 'netlify'])
    mkdirSync(join(directory, dir));
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  writeFileSync(join(directory, 'package-lock.json'), '{"packages":{}}');
  writeFileSync(join(directory, 'src/leaf.ts'), 'export const leaf=1;');
  writeFileSync(join(directory, 'dist/leaf.js'), 'export const leaf=1;');
  writeFileSync(
    join(directory, 'tests/child.test.mjs'),
    `import test from 'node:test'; import {execFileSync} from 'node:child_process'; test('child',()=>execFileSync(process.execPath,['dist/leaf.js']));`,
  );
  const result = spawnSync(process.execPath, [resolve('scripts/test-files.mjs'), 'tests/child.test.mjs'], {
    cwd: directory,
    env: { ...process.env, FORGE_TEST_COVERAGE_HEAD: head },
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const line = result.stdout.split('\n').find(line => line.startsWith(coverageMarker));
  const event = JSON.parse(line.slice(coverageMarker.length));
  assert.equal(event.complete, true);
  assert.equal(event.test, 'tests/child.test.mjs');
  assert.ok(event.touched.includes('src/leaf.ts'), line);
});

test('native retained artifact is source pinned and requires accepted full-run provenance and digest integrity', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-coverage-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of files) {
    mkdirSync(join(root, path.slice(0, path.lastIndexOf('/'))), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  writeFileSync(join(root, 'tests/binary.json'), Buffer.from([0xff]));
  const initial = initNative(root),
    store = new WorkStore(root),
    source = new NativeSource(root);
  const sourceFiles = new Map(
    source.state(initial.head).files.map(file => [file.path, source.object(file.blob).toString('utf8')]),
  );
  const run = { id: 'synthetic', head: initial.head };
  const directory = join(store.directory, 'check-synthetic');
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'stdout.log'),
    tests.map(test => row(test, ['src/leaf.ts'], { head: initial.head })).join('\n'),
  );
  const artifacts = retainCheckCoverage(store, run, directory, { scope: 'full', tests });
  assert.equal(artifacts.length, 1);
  assert.deepEqual(checkRunSchema.shape.artifacts.parse(artifacts), artifacts);
  assert.equal(artifacts[0].sourcePath, coverageSourcePath);
  const artifact = JSON.parse(readFileSync(join(directory, 'artifacts', artifacts[0].filename), 'utf8'));
  assert.equal(artifact.head, initial.head);
  assert.equal(artifact.digests['tests/binary.json'], fileDigest(Buffer.from([0xff])));
  assert.equal(artifact.digests['src/leaf.ts'], fileDigest(sourceFiles.get('src/leaf.ts')));
  assert.equal(latestCheckCoverage(store, 'b'.repeat(64)), undefined);
  // Isolate read-only provenance lookup from unrelated Work schema fixture setup.
  store.readRecords = () => null;
  store.load = () => ({
    channelMoves: [{ channel: 'main', status: 'accepted', head: initial.head, viewId: 'view' }],
    views: [{ id: 'view', head: initial.head }],
    runs: [{ ...run, viewId: 'view', status: 'passed', checkSelection: { scope: 'full' }, artifacts }],
  });
  assert.equal(latestCheckCoverage(store, initial.head).artifact.head, initial.head);
  writeFileSync(join(directory, 'artifacts', artifacts[0].filename), 'tampered');
  assert.equal(latestCheckCoverage(store, initial.head), undefined);
});

test('observed dynamic execution can add a recommendation absent from the import graph', () => {
  const changed = new Map(files);
  changed.set('tests/dynamic.test.mjs', "import 'node:assert';");
  const trace = input();
  trace.artifact.digests['tests/dynamic.test.mjs'] = fileDigest(changed.get('tests/dynamic.test.mjs'));
  trace.artifact.tests['tests/dynamic.test.mjs'] = ['src/leaf.ts'];
  const result = select(trace, { files: changed });
  assert.ok(!result.tests.includes('tests/dynamic.test.mjs'));
  assert.ok(result.coverage.tests.includes('tests/dynamic.test.mjs'));
});

test('unavailable advisory source inventory does not prevent the selected tests from running', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-coverage-unavailable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tests'));
  writeFileSync(
    join(root, 'tests/standalone.test.mjs'),
    "import test from 'node:test'; test('still runs', () => {});",
  );
  const result = spawnSync(
    process.execPath,
    [resolve('scripts/test-files.mjs'), 'tests/standalone.test.mjs'],
    {
      cwd: root,
      env: { ...process.env, FORGE_TEST_COVERAGE_HEAD: head },
      encoding: 'utf8',
      timeout: 60000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Coverage unavailable: source inventory/);
  assert.match(result.stdout, /# pass 1/);
  assert.ok(!result.stdout.includes(coverageMarker));
});

test('a narrowed runtime recommendation does not erase a type-level interface failure', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-coverage-types-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'interface.ts');
  writeFileSync(path, 'interface Model { value: string; } const sample: Model = { value: 1 };');
  const result = select();
  assert.ok(result.coverage.coverageCount < result.tests.length);
  const program = ts.createProgram([path], { noEmit: true, noLib: true, types: [], strict: true });
  assert.ok(program.getSemanticDiagnostics().some(diagnostic => diagnostic.code === 2322));
});

test('barrel initialization coverage retains tests that load the re-exported module', () => {
  const barrel = new Map(files);
  barrel.set('src/hub.ts', "export { leaf } from './leaf.js'; export const unrelated = 2;");
  const trace = input();
  trace.artifact.digests['src/hub.ts'] = fileDigest(barrel.get('src/hub.ts'));
  trace.artifact.tests['tests/hub.test.mjs'] = ['src/hub.ts', 'src/leaf.ts'];
  const result = select(trace, { files: barrel });
  assert.ok(result.coverage.tests.includes('tests/hub.test.mjs'));
  assert.equal(result.coverage.coverageCount, result.tests.length);
});
