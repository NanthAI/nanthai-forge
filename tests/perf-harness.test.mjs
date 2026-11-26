// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { budgets, measurement, eagerFiles, landingTiming } from '../scripts/perf/report.mjs';
import { cliColdStartSamples, coreBuildProblem, cpuMs, options } from '../scripts/perf-harness.mjs';
import { agentCommands, firstNetworkSamples } from '../scripts/perf/cli-first-network.mjs';
import { agentSurfaceFindings, readWeightBaseline } from '../scripts/agent-weight.mjs';
import { agentActionNames } from '../scripts/check-growth.mjs';
import { coreVerbs } from '../scripts/agent-verb-forms.mjs';
import { successfulSample } from '../scripts/perf/browser.mjs';

test('budget medians include the boundary, and an empty or incomplete run never passes', () => {
  assert.equal(measurement('now', [{ durationMs: 1500 }]).status, 'pass');
  assert.equal(measurement('now', [{ durationMs: 1501 }]).status, 'fail');
  assert.equal(measurement('now', []).status, 'unrun');
  for (const durationMs of [null, NaN, -1, Infinity]) {
    const row = measurement('now', [{ durationMs: 1 }, { durationMs }]);
    assert.equal(row.status, 'failed');
    assert.equal(row.medianMs, null);
  }
  assert.equal(measurement('work', [{ durationMs: 3 }, { durationMs: 1 }]).medianMs, 2);
});

test('CLI cold start is judged on CPU time from `time -p`, and a run that fails or prints no time never passes', () => {
  assert.equal(cpuMs('real 4.45\nuser 1.10\nsys 0.19\n'), 1290);
  assert.equal(cpuMs('no timing here'), null);
  const failed = cliColdStartSamples(1, [process.execPath, '-e', 'process.exit(3)']);
  assert.equal(measurement('cliColdStartCpu', failed).status, 'failed');
  const max = budgets.cliColdStartCpu;
  assert.equal(measurement('cliColdStartCpu', [{ durationMs: max }]).status, 'pass');
  assert.equal(measurement('cliColdStartCpu', [{ durationMs: max + 1 }]).status, 'fail');
});

/** Modules a process loads, via a preload that counts every module load until exit. */
function loadedModules(args, input = '') {
  const preload =
    'data:text/javascript,' +
    encodeURIComponent(
      "import { registerHooks } from 'node:module';const seen=new Set();" +
        'registerHooks({load(url,ctx,next){seen.add(url);return next(url,ctx);}});' +
        "process.on('exit',()=>process.stderr.write('\\nMODULES '+JSON.stringify([...seen])));",
    );
  const state = mkdtempSync(join(tmpdir(), 'forge-cold-'));
  const run = spawnSync(process.execPath, ['--import', preload, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, XDG_STATE_HOME: state, XDG_CONFIG_HOME: state },
  });
  rmSync(state, { recursive: true, force: true });
  const line = run.stderr.slice(run.stderr.lastIndexOf('\nMODULES ') + 9);
  return { run, modules: JSON.parse(line) };
}

test('381c62df: --version, --help and an idle turn-end hook stay on a minimal import path', () => {
  // dist/cli-entry.js is a bundle (7b2ae8d8): its command graph is chunks named for their first module.
  const heavy =
    /\/node_modules\/|\/(?:cli-bundle-)?(agent-cli|agent-install-hooks|hosted-agent-transport|agent-turn-work)(?:-[\w-]+)?\.js$/;
  const cases = [
    ['--version', ['dist/cli-entry.js', '--version'], '', readWeightBaseline('.').ceilings.versionModules],
    ['--help', ['dist/cli-entry.js', '--help'], '', readWeightBaseline('.').ceilings.helpModules],
    [
      'idle turn-end hook',
      ['dist/agent-stop-hook.js', '--forge-turn-end'],
      JSON.stringify({ session_id: 'cold-start', hook_event_name: 'Stop' }),
      25,
    ],
  ];
  for (const [name, args, input, ceiling] of cases) {
    const { run, modules } = loadedModules(
      args.map(a => (a.startsWith('dist/') ? fileURLToPath(new URL(`../${a}`, import.meta.url)) : a)),
      input,
    );
    assert.equal(run.status, 0, `${name}: ${run.stderr}`);
    const mine = modules.filter(url => url.startsWith('file:'));
    const loaded = mine.filter(url => heavy.test(url));
    assert.deepEqual(loaded, [], `${name} loaded the command graph`);
    assert.ok(mine.length <= ceiling, `${name} loaded ${mine.length} modules (ceiling ${ceiling})`);
  }
});

test('package preflight measures the real CLI even when its temp directory is inside a Lane', t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  assert.match(
    readFileSync(join(root, 'dist', 'cli-entry.js'), 'utf8'),
    /^#![^\r\n]*\bnode\r?\n/,
    'npm launches the bundled CLI directly and needs its Node interpreter line',
  );
  const lane = mkdtempSync(join(tmpdir(), 'forge-weight-lane-'));
  t.after(() => rmSync(lane, { recursive: true, force: true }));
  mkdirSync(join(lane, '.forge'));
  writeFileSync(join(lane, '.forge', 'hosted-lane.json'), '{}');
  const temp = join(lane, 'scratch');
  mkdirSync(temp);
  const run = spawnSync(process.execPath, ['scripts/package-ceilings.mjs', '--runtime', '--inventory'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const inventory = JSON.parse(/^Package module inventory: (.+)$/m.exec(run.stdout)[1]);
  for (const name of Object.keys(agentCommands)) {
    assert.ok(inventory[name]?.length, `${name} never reached its first network call`);
    assert.deepEqual(
      inventory[name].filter(path => /\/(?:typescript\/|zod\/v4\/locales\/)/.test(path)),
      [],
      `${name} loaded the TypeScript compiler or zod locales`,
    );
  }
});

test('ad80e037: the agent actions and runtime dependencies on this source match the weight baseline', () => {
  const baseline = readWeightBaseline('.');
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const report = {
    boundary: Object.keys(manifest.dependencies).sort(),
    agentActions: [...agentActionNames(readFileSync('src/agent-verbs.ts', 'utf8'), coreVerbs)].sort(),
  };
  assert.deepEqual(agentSurfaceFindings(report, baseline), []);
});

test('7b2ae8d8: a run that never reaches a network call, or fails, is a failed sample and never passes', () => {
  const never = fileURLToPath(new URL('../scripts/node-runtime.mjs', import.meta.url));
  const samples = firstNetworkSamples(1, 'cliAgentStatusCpu', { cli: never });
  assert.ok(Number.isNaN(samples[0].durationMs));
  assert.equal(measurement('cliAgentStatusCpu', samples).status, 'failed');
  const max = budgets.cliAgentStatusCpu;
  assert.equal(measurement('cliAgentStatusCpu', [{ durationMs: max }]).status, 'pass');
  assert.equal(measurement('cliAgentStatusCpu', [{ durationMs: max + 1 }]).status, 'fail');
});

test('bundle accounting follows shared static imports once and excludes dynamic route chunks', () => {
  const manifest = {
    entry: { file: 'main.js', imports: ['shared'], dynamicImports: ['route'] },
    shared: { file: 'shared.js', imports: ['entry'], css: ['shared.css'] },
    route: { file: 'route.js', imports: ['shared'] },
  };
  assert.deepEqual(eagerFiles(manifest, ['entry']), ['main.js', 'shared.css', 'shared.js']);
  assert.deepEqual(eagerFiles(manifest, ['entry', 'route']), [
    'main.js',
    'route.js',
    'shared.css',
    'shared.js',
  ]);
  assert.throws(() => eagerFiles(manifest, ['absent']), /PERF_MANIFEST_ENTRY/);
});

const at = seconds => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const work = () => ({
  intents: [{ id: 'intent', createdAt: at(0) }],
  views: [{ id: 'view', intentId: 'intent', head: 'exact', at: at(20) }],
  channelMoves: [
    { id: 'pending', status: 'pending', viewId: 'view', channel: 'main', head: 'exact', at: at(50) },
    { id: 'accepted', status: 'accepted', viewId: 'view', channel: 'main', head: 'exact', at: at(40) },
  ],
  runs: [
    {
      id: 'run',
      viewId: 'view',
      head: 'exact',
      status: 'passed',
      queuedAt: at(21),
      startedAt: at(23),
      endedAt: at(35),
    },
    { id: 'other-head', viewId: 'view', head: 'stale', status: 'passed' },
  ],
});

test('landing times retain exact source and distinguish author lifetime, composition, queue and run', () => {
  const data = work(),
    before = structuredClone(data),
    result = landingTiming(data);
  assert.equal(result.intentToAcceptMs, 40000);
  assert.equal(result.composeToAcceptMs, 20000);
  assert.equal(result.finishCommandMs, null);
  assert.deepEqual(
    result.runs.map(r => [r.id, r.queueMs, r.runMs]),
    [['run', 2000, 12000]],
  );
  assert.equal(result.head, 'exact');
  assert.deepEqual(data, before);
});

test('missing records, wrong exact head or invalid dates cannot manufacture a landing duration', () => {
  assert.equal(landingTiming(work(), 'absent').status, 'unrun');
  const missing = work();
  missing.views[0].head = 'different';
  assert.equal(landingTiming(missing).status, 'unrun');
  const badDate = work();
  badDate.intents[0].createdAt = 'invalid';
  assert.equal(landingTiming(badDate).status, 'failed');
  const noQueue = work();
  delete noQueue.runs[0].queuedAt;
  assert.equal(landingTiming(noQueue).runs[0].queueMs, null);
});

test('browser result rejects error-ready markers, missing diffs, signed-out pages and wrong routes', () => {
  const good = {
    authenticated: true,
    routeMatches: true,
    runtimeError: false,
    hasAlert: false,
    hasDiff: true,
    mark: { complete: 950, queries: { sourceDiff: 900 } },
  };
  assert.equal(successfulSample(good, 'laneFirstDiff'), true);
  for (const change of [
    { authenticated: false },
    { routeMatches: false },
    { runtimeError: true },
    { hasAlert: true },
    { hasDiff: false },
    { mark: { complete: 950, queries: {} } },
    { mark: { complete: null } },
  ])
    assert.equal(successfulSample({ ...good, ...change }, 'laneFirstDiff'), false);
});

test('arguments keep live measurement explicit and reject invalid timing or credential-bearing URLs', () => {
  assert.equal(options([]).live, false);
  assert.throws(() => options(['--live']));
  assert.throws(() => options(['--samples', '0']));
  assert.throws(() => options(['--samples', '1.5']));
  assert.throws(() => options(['--live', '--base', 'https://user:password@example.invalid']));
  assert.throws(() => options(['--landing-id', 'not-selected']));
  assert.throws(() => options(['--capsule-cold-read', '.']), 'cold reads name their packed landings');
  assert.throws(() => options(['--submissions', 'ids.txt']));
});

async function run(t, extra = []) {
  const directory = mkdtempSync(resolve('node_modules/perf-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const output = join(directory, 'result.json');
  const child = spawn(
    process.execPath,
    [
      'scripts/perf-harness.mjs',
      '--samples',
      '1',
      '--out',
      output,
      '--credentials',
      join(directory, 'absent-credentials'),
      ...extra,
    ],
    {
      env: { ...process.env, FORGE_AUTH_TOKEN: 'synthetic-redaction-sentinel' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let text = '';
  child.stdout.on('data', b => (text += b));
  child.stderr.on('data', b => (text += b));
  const code = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', done);
  });
  const json = readFileSync(output, 'utf8');
  assert.doesNotMatch(json + text, /synthetic-redaction-sentinel|synthetic-only|Authorization|Bearer/);
  assert.equal(statSync(output).mode & 0o777, 0o600);
  return { code, record: JSON.parse(json) };
}

test('one command records machine/build identity and explicitly unrun opt-in CLI cold start and browser results', async t => {
  const { code, record } = await run(t);
  const cold = record.measurements.cliColdStartCpu;
  assert.deepEqual(cold.samples, []);
  assert.equal(cold.status, 'unrun');
  assert.equal(cold.medianMs, null);
  assert.match(cold.reason, /--cli-cold-start/);
  assert.equal(code, 0);
  assert.equal(record.status, 'partial');
  for (const name of ['now', 'work', 'laneFirstDiff'])
    assert.equal(record.measurements[name].status, 'unrun');
  assert.equal(record.landing.status, 'unrun');
  assert.match(record.buildHash, /^[a-f0-9]{64}$/);
  assert.ok(record.machine.cpuCount > 0);
  assert.ok(Date.parse(record.endedAt) >= Date.parse(record.startedAt));
  assert.equal(record.syntheticFixture, undefined);
});

test('requested live setup failure still writes JSON and returns a failure, never a successful live sample', async t => {
  const { code, record } = await run(t, ['--live', '--base', 'http://127.0.0.1:1']);
  assert.equal(code, 1);
  assert.equal(record.status, 'fail');
  assert.equal(record.browser.status, 'failed');
  assert.equal(record.measurements.now.status, 'unrun');
  assert.equal(record.measurements.now.medianMs, null);
});

test('ad80e037: preflight runs this file as the agent weight guard for build inputs, never for a docs- or test-only Lane', async () => {
  const { preflightGuards, selectGuards } = await import('../dist/agent-preflight-static.js');
  const guards = preflightGuards(readFileSync('package.json', 'utf8'), path => existsSync(path));
  const weight = guards.find(guard => guard.name === 'package runtime ceilings (MCP/CLI modules and chunks)');
  assert.deepEqual(weight?.tests, ['tests/perf-harness.test.mjs']);
  for (const path of ['src/mcp-hosted-agent.ts', 'scripts/build-cli-bundle.mjs', 'package-lock.json'])
    assert.ok(selectGuards([weight], [path]).selected.length, path);
  assert.equal(
    selectGuards([weight], ['docs/sample-guide.md', 'tests/sample-only.test.mjs', 'sample-notes.md']).selected
      .length,
    0,
  );
});

test('ad80e037: the agent weight guard triggers on every script the built CLI or MCP server imports', async () => {
  // dist bundles any scripts/*.mjs that src/ reaches, directly or through other scripts, so each one
  // can change a module count; a script added to that graph must join the guard inputs.
  const { preflightGuards } = await import('../dist/agent-preflight-static.js');
  const { globRegExp } = await import('../dist/path-glob.js');
  const weight = preflightGuards(readFileSync('package.json', 'utf8'), path => existsSync(path)).find(
    guard => guard.name === 'package runtime ceilings (MCP/CLI modules and chunks)',
  );
  const patterns = weight.inputs.map(globRegExp);
  const spec = /(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  const reached = new Set(),
    queue = [];
  const visit = (from, target) => {
    const path = join(dirname(from), target).replaceAll('\\', '/');
    if (path.startsWith('scripts/') && !reached.has(path) && existsSync(path))
      (reached.add(path), queue.push(path));
  };
  for (const file of readdirSync('src', { recursive: true }))
    if (/\.m?ts$/.test(file) && !file.endsWith('.d.ts'))
      for (const [, target] of readFileSync(join('src', file), 'utf8').matchAll(spec))
        visit(join('src', file), target);
  while (queue.length) {
    const file = queue.shift();
    for (const [, target] of readFileSync(file, 'utf8').matchAll(spec)) visit(file, target);
  }
  assert.ok(reached.size > 10, 'the scan finds the scripts src/ imports');
  assert.deepEqual(
    [...reached].filter(path => !patterns.some(pattern => pattern.test(path))).sort(),
    [],
    'add these to the agent weight guard inputs in package.json',
  );
});

test('perf-harness names a missing core build and a bundle overwritten by plain tsc', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'perf-dist-'));
  try {
    assert.match(coreBuildProblem(dir), /core build missing/);
    writeFileSync(join(dir, 'cli-entry.js'), 'import { main } from "./cli.js";\n');
    assert.match(coreBuildProblem(dir), /not the bundled entry/);
    writeFileSync(join(dir, 'cli-entry.js'), 'import { a } from "./cli-bundle-x-AbC.js";\n');
    assert.match(coreBuildProblem(dir), /cli-bundle-x-AbC\.js, which is missing/);
    writeFileSync(join(dir, 'cli-bundle-x-AbC.js'), '');
    assert.equal(coreBuildProblem(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
