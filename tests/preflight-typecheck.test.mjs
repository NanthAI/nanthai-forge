// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item ad80e037 fix 6: the landing check typechecks every TypeScript project (root, web, convex,
// site); preflight typechecked none of them, so a TS2339 in convex/ reached the landing check.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from '../dist/state/hash.js';
import { sourceTree } from '../dist/source-tree.js';
import { preflightPlan, preflightRuntime, runPreflight } from '../dist/agent-preflight.js';
import { selectStaticChecks, staticChecks } from '../dist/agent-preflight-static.js';
import { configChain, shellSteps } from '../dist/preflight-typecheck.js';

const laneId = '44444444-4444-4444-8444-444444444444';
const healthy = {
  ok: true,
  latencyMs: 1,
  fseventsdRssMb: null,
  fseventsdCpuPercent: null,
  reason: null,
  attempts: [],
};
test.beforeEach(t => t.mock.method(preflightRuntime, 'filesystemEventHealth', () => healthy));

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const tsc = join(repoRoot, 'node_modules', '@typescript', 'native', 'bin', 'tsc');
const tsconfig = include =>
  JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      types: [],
      module: 'ESNext',
      moduleResolution: 'Bundler',
      allowImportingTsExtensions: true,
    },
    include,
  });

function lane(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-preflight-typecheck-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = new Map(Object.entries(files));
  for (const [path, body] of bytes) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const list = () => [...bytes].map(([path, body]) => ({ path, blob: digest(body), mode: 'file' }));
  const plan = paths => preflightPlan(root, { paths, complete: true }, { laneId, files: list() });
  const run = (p, changed) =>
    runPreflight(root, laneId, digest(JSON.stringify(list())), p, sourceTree(list()), true, changed);
  return { root, plan, run };
}

// The project's own typecheck script: a setup step, then one compiler step per project.
const typecheckScript = [
  'node setup.mjs',
  `node ${JSON.stringify(tsc)} -p tsconfig.json`,
  `node ${JSON.stringify(tsc)} -p convex/tsconfig.json`,
].join(' && ');
const project = convexBody => ({
  'package.json': JSON.stringify({
    type: 'module',
    scripts: { typecheck: typecheckScript },
    forge: { preflight: { static: [] } },
  }),
  'setup.mjs':
    "import { writeFileSync } from 'node:fs'; writeFileSync('convex/generated.ts', 'export const g = 1;\\n');\n",
  'tsconfig.json': tsconfig(['src']),
  'src/a.ts': 'export const n: number = 1;\n',
  'convex/tsconfig.json': tsconfig(['./**/*']),
  'convex/x.ts': convexBody,
  'docs/guide.md': '# Guide\n',
});

test('fix 6: a type error in convex/ fails preflight; the project whose program the change misses does not run', t => {
  const f = lane(t, project("import { g } from './generated.ts';\nexport const s: string = g;\n"));
  const plan = f.plan(['convex/x.ts']);
  assert.deepEqual(
    plan.static.selected.map(check => check.name),
    ['typecheck tsconfig.json', 'typecheck convex/tsconfig.json'],
  );
  const receipt = f.run(plan, ['convex/x.ts']);
  assert.equal(receipt.outcome, 'failed');
  assert.deepEqual(
    receipt.static.map(check => [check.name, check.outcome]),
    [['typecheck convex/tsconfig.json', 'failed']],
    'the root program holds no changed file, so only convex/ is typechecked',
  );
  assert.deepEqual(receipt.static[0].files, ['convex/x.ts']);
  assert.match(receipt.static[0].excerpt, /TS2322/);
});

test('fix 6: a clean convex/ change passes, and a docs-only change runs no typecheck at all', t => {
  const f = lane(t, project("import { g } from './generated.ts';\nexport const s: number = g;\n"));
  const receipt = f.run(f.plan(['convex/x.ts']), ['convex/x.ts']);
  assert.equal(receipt.outcome, 'passed', JSON.stringify(receipt.static));
  const docs = f.plan(['docs/guide.md']);
  assert.deepEqual(docs.static?.selected ?? [], []);
  assert.deepEqual(docs.static?.untouched, ['typecheck tsconfig.json', 'typecheck convex/tsconfig.json']);
});

test('fix 6: preflight derives a typecheck step for every project the landing check typechecks', () => {
  // The landing check (scripts/verify.mjs) runs one compiler per project; the legacy-compiler
  // compatibility run checks convex/tsconfig.json again with the TypeScript package.
  const verify = readFileSync(join(repoRoot, 'scripts/verify.mjs'), 'utf8');
  const checked = new Set(
    [...verify.matchAll(/tsc\('typecheck:[^']*',([^)]*)\)/g)].map(
      ([, args]) => /'-p', '([^']+)'/.exec(args)?.[1] ?? 'tsconfig.json',
    ),
  );
  assert.ok(checked.has('convex/tsconfig.json'), 'the landing check typechecks convex/');
  const derived = staticChecks(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    .filter(check => check.typecheck)
    .map(check => check.typecheck.project);
  assert.deepEqual(new Set(derived), checked);
});

test('fix 6: only plain `&&` command lists are split; other shell syntax runs the script whole', () => {
  assert.deepEqual(shellSteps(`node a.mjs && tsc --types "*" -p 'web/tsconfig.json'`), [
    ['node', 'a.mjs'],
    ['tsc', '--types', '*', '-p', 'web/tsconfig.json'],
  ]);
  for (const text of [
    'tsc | tee log',
    'tsc; tsc -p x',
    'X=1 tsc',
    'tsc -p $DIR',
    'tsc *.ts',
    'tsc || true',
    'a && && b',
    'node gen.mjs\ntsc',
    'node gen.mjs\r\ntsc',
  ])
    assert.equal(shellSteps(text), null, text);
  const [whole] = staticChecks(
    JSON.stringify({ scripts: { typecheck: 'tsc | tee log' }, forge: { preflight: { static: [] } } }),
  );
  assert.deepEqual(whole.command, ['npm', 'run', '-s', 'typecheck']);
  assert.equal(whole.source, 'conventional', 'a script it cannot split is advice, never a refusal');
});

test('review 7732ef40: only a project that declares its static checks is refused by them; npm pre/post scripts are kept', () => {
  const steps = (scripts, forge) =>
    staticChecks(JSON.stringify({ scripts, ...(forge ? { forge: { preflight: { static: [] } } } : {}) }))
      .filter(check => check.typecheck)
      .map(check => [check.name, check.source, check.typecheck.setup]);
  // A project that never declared static checks may not keep its typecheck clean on main: advice.
  assert.deepEqual(steps({ typecheck: 'tsc' }, false), [['typecheck tsconfig.json', 'conventional', []]]);
  assert.deepEqual(steps({ typecheck: 'tsc' }, true), [['typecheck tsconfig.json', 'derived', []]]);
  // npm runs pre<script> first (code generation the compiler reads); a post<script> runs the whole.
  assert.deepEqual(steps({ typecheck: 'tsc', pretypecheck: 'node gen.mjs' }, true), [
    ['typecheck tsconfig.json', 'derived', [['npm', 'run', '-s', 'pretypecheck']]],
  ]);
  assert.deepEqual(steps({ typecheck: 'tsc', posttypecheck: 'node check.mjs' }, true), [
    ['typecheck', 'conventional', []],
  ]);
  // A lockfile-only change can change installed types: the typecheck steps are triggered.
  const forge = JSON.stringify({ scripts: { typecheck: 'tsc' }, forge: { preflight: { static: [] } } });
  for (const lock of ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'])
    assert.deepEqual(
      selectStaticChecks(staticChecks(forge), [lock]).selected.map(check => check.name),
      ['typecheck tsconfig.json'],
      lock,
    );
});

test('review 7732ef40: a change to a config a project extends, whatever its name, typechecks that project', t => {
  const files = project("import { g } from './generated.ts';\nexport const s: number = g;\n");
  files['base.json'] = JSON.stringify({ compilerOptions: { strict: true } });
  files['convex/tsconfig.json'] = JSON.stringify({
    extends: '../base',
    ...JSON.parse(files['convex/tsconfig.json']),
  });
  const f = lane(t, files);
  assert.deepEqual(configChain(f.root, 'convex/tsconfig.json'), ['convex/tsconfig.json', 'base.json']);
  // A cycle in an `extends` array, or a commented-out `extends`, ends the walk; it never throws.
  writeFileSync(
    join(f.root, 'a.json'),
    '// "extends": "./gone",\n/* "extends": "./old" */\n{ "include": ["src/**/*"], "extends": ["./b", "./a.json"] }',
  );
  writeFileSync(join(f.root, 'b.json'), JSON.stringify({ extends: ['./c', './a'] }));
  assert.deepEqual(configChain(f.root, 'a.json'), ['a.json', 'b.json', 'c.json']);
  const receipt = f.run(f.plan(['base.json']), ['base.json']);
  assert.deepEqual(
    receipt.static.map(check => [check.name, check.outcome]),
    [['typecheck convex/tsconfig.json', 'passed']],
  );
});
