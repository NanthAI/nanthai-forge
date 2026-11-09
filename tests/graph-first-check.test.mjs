// SPDX-License-Identifier: Apache-2.0
// Package-graph-scoped first checks for outside repositories (Issue 234b5abc): an Intent without a
// contract under the contract gate's other guards runs a declared command scoped when the manifest
// package graph selects a minority of testable packages; Forge ships the per-ecosystem runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { actionsGateSelection } from '../dist/hosted-actions-job-plan.js';
import { commandScopeProposal, PACKAGES_RUN_LINE } from '../dist/check-command-scope.js';
import {
  acceptGraphFirst,
  fromGraphFirstContract,
  GRAPH_FIRST_CONTRACT,
  graphFirstCheck,
  graphFirstGate,
  graphShareFor,
  isGraphFirstGate,
} from '../dist/graph-first-check.js';
import { gateFor } from '../dist/contract-gate-policy.js';
import { policyPreset } from '../dist/autonomy-policy.js';
import { selectionFallback } from '../dist/fallback-reasons.js';
import { writeCheckPackages } from '../dist/package-graph-checkout.js';
import { commandCheckInputs } from '../scripts/check-command-env.mjs';
import { noTestsCollected, packageRunCommands, runPackageCommands } from '../scripts/check-packages-run.mjs';

const base = 'a'.repeat(64),
  head = 'b'.repeat(64);
const ci = (selection = { scope: 'changed-paths' }) => ({
  name: 'ci',
  executable: 'bash',
  args: ['ci/check.sh'],
  environmentLabel: 'clean',
  ...(selection ? { selection } : {}),
});
const run = (check, gate) => ({
  check,
  ...(gate ? { gate } : {}),
  candidate: { base: { head: base } },
  request: { expectedHead: head },
});

// One synthetic repository per ecosystem: four leaf packages (two in Python) beside one shared package
// every leaf depends on. A leaf change selects a minority; the shared package selects everyone. Leaf
// tests use their package, so the module graph (src/module-graph.ts) narrows the runner to them.
const repos = {
  go: new Map([
    ['core/go.mod', 'module example.com/core\n\ngo 1.22\n'],
    ['core/core.go', 'package core\n'],
    ...['a', 'b', 'c'].flatMap(name => [
      [
        `${name}/go.mod`,
        `module example.com/${name}\n\ngo 1.22\n\nrequire example.com/core v0.0.0\n\nreplace example.com/core => ../core\n`,
      ],
      [`${name}/${name}.go`, `package ${name}\n`],
      [`${name}/${name}_test.go`, `package ${name}\n`],
    ]),
  ]),
  cargo: new Map([
    ['Cargo.toml', '[workspace]\nmembers = ["crates/*"]\n'],
    ['crates/core/Cargo.toml', '[package]\nname = "core"\n'],
    ['crates/core/src/lib.rs', ''],
    ...['a', 'b', 'c'].flatMap(name => [
      [
        `crates/${name}/Cargo.toml`,
        `[package]\nname = "${name}"\n[dependencies]\ncore = { path = "../core" }\n`,
      ],
      [`crates/${name}/src/lib.rs`, '#[test]\nfn t() {}\n'],
    ]),
  ]),
  python: new Map([
    ['pytest.ini', '[pytest]\n'],
    ['packages/core/pyproject.toml', '[project]\nname = "core"\n'],
    ['packages/core/src/core/__init__.py', ''],
    ...['a', 'b', 'c'].flatMap(name => [
      [
        `packages/${name}/pyproject.toml`,
        `[project]\nname = "${name}"\ndependencies = ["core"]\n[tool.uv.sources]\ncore = { path = "../core" }\n`,
      ],
      [`packages/${name}/src/${name}/__init__.py`, ''],
      [`packages/${name}/tests/test_${name}.py`, `import ${name}\n`],
    ]),
  ]),
  gradle: new Map([
    ['settings.gradle', "include ':core', ':a', ':b', ':c'\n"],
    ['gradlew', '#!/bin/sh\n'],
    ['core/build.gradle', "plugins { id 'java' }\n"],
    ['core/src/main/java/Core.java', ''],
    ...['a', 'b', 'c'].flatMap(name => [
      [`${name}/build.gradle`, "plugins { id 'java' }\ndependencies { implementation project(':core') }\n"],
      [`${name}/src/main/java/${name.toUpperCase()}.java`, `class ${name.toUpperCase()} {}\n`],
      [
        `${name}/src/test/java/${name.toUpperCase()}Test.java`,
        `class ${name.toUpperCase()}Test { @Test void t() { new ${name.toUpperCase()}(); } }\n`,
      ],
    ]),
  ]),
  js: new Map([
    ['package.json', JSON.stringify({ private: true, workspaces: ['packages/*'] })],
    ['package-lock.json', '{}'],
    ['packages/core/package.json', JSON.stringify({ name: 'core', scripts: { test: 'node --test' } })],
    ['packages/core/index.js', ''],
    ...['a', 'b', 'c'].flatMap(name => [
      [
        `packages/${name}/package.json`,
        JSON.stringify({ name, dependencies: { core: '*' }, scripts: { test: 'node --test' } }),
      ],
      [`packages/${name}/index.js`, ''],
    ]),
  ]),
};
const leaf = {
  go: ['a/a.go', ['go', 'test', '.']],
  cargo: ['crates/a/src/lib.rs', ['cargo', 'test', '-p', 'a', '--lib']],
  python: ['packages/a/src/a/__init__.py', null],
  gradle: ['a/src/main/java/A.java', ['./gradlew', ':a:test', '--tests', 'ATest']],
  js: ['packages/a/index.js', ['npm', 'run', 'test', '--workspace=packages/a']],
};
const shared = {
  go: 'core/core.go',
  cargo: 'crates/core/src/lib.rs',
  python: 'packages/core/src/core/__init__.py',
  gradle: 'core/src/main/java/Core.java',
  js: 'packages/core/index.js',
};
const gate = graphFirstGate();

for (const [ecosystem, files] of Object.entries(repos))
  test(`${ecosystem}: a leaf change runs a graph-first command scoped; the shared package keeps it full`, () => {
    const [path, argv] = leaf[ecosystem];
    const scoped = actionsGateSelection(run(ci(), gate), [path], files, false);
    assert.equal(scoped.scope, 'scoped', scoped.reason);
    assert.equal(scoped.changes.mode, 'scoped');
    assert.equal(scoped.graph.scope, 'scoped');
    assert(scoped.graph.selected >= 1 && scoped.graph.selected * 2 <= scoped.graph.total, scoped.reason);
    assert.match(scoped.reason, /package-graph first check/);
    // The gate echo the server checks: scoped evidence, never full.
    const full = actionsGateSelection(run(ci(), gate), [shared[ecosystem]], files, false);
    assert.equal(full.scope, 'full', full.reason);
    assert.equal(full.changes.mode, 'full');
    assert.match(full.reason, /more than 50%/);
    assert.equal(full.fallback, 'graph-full');
    // The per-ecosystem command the runner receives for the leaf change.
    const root = checkout(files);
    try {
      const packages = writeCheckPackages(root, scoped.changes, { node: 'node', script: 'runner.mjs' });
      const written = JSON.parse(readFileSync(packages.path, 'utf8'));
      assert.equal(written.scope, 'scoped');
      if (argv) assert.deepEqual(written.commands.at(-1).argv, argv);
      else assert.equal(written.commands[0].ecosystem, ecosystem);
      assert(packages.run && existsSync(packages.run));
      packages.remove();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

function checkout(files) {
  const root = mkdtempSync(join(tmpdir(), 'forge-graph-first-'));
  for (const [path, text] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test('a root package, an unplaced path or an unknown graph keeps the first check full', () => {
  const files = repos.cargo;
  for (const paths of [['Cargo.toml'], ['README-notes.sh'], ['crates/a/src/lib.rs', 'build/x.sh']]) {
    const selected = actionsGateSelection(run(ci(), gate), paths, files, false);
    assert.equal(selected.scope, 'full', paths.join());
    assert.equal(selected.fallback, 'graph-full');
  }
  const unknown = graphShareFor(new Map([['src/main.c', '']]), ['src/main.c']);
  assert.equal(unknown.scope, 'full');
});

test('only a declared configured command qualifies; Forge’s own recipe keeps full first checks', () => {
  const files = repos.cargo;
  const undeclared = actionsGateSelection(run(ci(null), gate), [leaf.cargo[0]], files, false);
  assert.equal(undeclared.scope, 'full');
  assert.equal(graphFirstCheck(ci(null)), false);
  assert.equal(graphFirstCheck(ci()), true);
  assert.equal(
    graphFirstCheck({
      executable: 'node',
      args: ['scripts/forge-check.mjs'],
      selection: { scope: 'changed-paths' },
    }),
    false,
  );
  // Without the graph-first gate the declared command still runs in full on a first check.
  for (const other of [undefined, { mode: 'full', reason: 'Intent has no contract' }]) {
    const selected = actionsGateSelection(run(ci(), other), [leaf.cargo[0]], files, false);
    assert.equal(selected.scope, 'full');
    assert.equal(selected.graph, undefined);
  }
});

test('the server gate: no contract plus every other contract-gate guard gives graph-first, else full', () => {
  const input = (patch = {}) => {
    const policy = policyPreset('trusted');
    Object.assign(policy.acceptance, patch.acceptance ?? {});
    return {
      policy,
      project: { owner: 'owner' },
      actor: patch.actor ?? { kind: 'agent', id: 'owner' },
      paths: patch.paths === undefined ? ['crates/a/src/lib.rs'] : patch.paths,
      contract: patch.contract === undefined ? GRAPH_FIRST_CONTRACT : patch.contract,
      main: {
        status: 'green',
        unaudited: { count: 0, firstAt: null },
        debt: false,
        hold: null,
        ...patch.main,
      },
    };
  };
  assert.equal(isGraphFirstGate(fromGraphFirstContract(gateFor(input()))), true);
  assert.equal(acceptGraphFirst(input()), 'pass');
  for (const patch of [
    { acceptance: { gate: 'full' } },
    { acceptance: { mode: 'review' } },
    { actor: { kind: 'agent', id: 'contributor' } },
    { paths: null },
    { main: { debt: true } },
    { main: { status: 'unknown' } },
    // A recovery (needs-fix) Intent arrives without the stand-in contract.
    { contract: null },
  ]) {
    assert.equal(fromGraphFirstContract(gateFor(input(patch))).mode, 'full', JSON.stringify(patch));
    assert.equal(acceptGraphFirst(input(patch)), 'full-required', JSON.stringify(patch));
  }
  // Red main stops the proof.
  assert.equal(acceptGraphFirst(input({ main: { status: 'red' } })), 'main-red');
  // A real contract (version 1+) is never mistaken for the stand-in.
  const real = gateFor(input({ contract: { version: 1, tests: [{ path: 'tests/a.test.mjs' }] } }));
  assert.equal(fromGraphFirstContract(real), real);
});

test('the per-ecosystem runner runs every command in the checkout and fails on the first failure', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-packages-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'crates/a'), { recursive: true });
  const seen = [];
  const spawn = (cmd, args, options) => {
    seen.push([options.cwd, cmd, ...args]);
    return { status: cmd === 'cargo' ? 0 : 3 };
  };
  const commands = [
    { ecosystem: 'cargo', cwd: 'crates/a', argv: ['cargo', 'test'] },
    { ecosystem: 'python', cwd: '', argv: ['uv', 'run', 'pytest', 'packages/a'] },
  ];
  assert.equal(runPackageCommands(commands, root, { spawn, log: () => {} }), 3);
  assert.deepEqual(seen, [
    [join(root, 'crates/a'), 'cargo', 'test'],
    [root, 'uv', 'run', 'pytest', 'packages/a'],
  ]);
  for (const bad of [
    'not json',
    JSON.stringify({ version: 1, scope: 'full', commands: [] }),
    JSON.stringify({ version: 1, scope: 'scoped', commands: [] }),
    JSON.stringify({ version: 1, scope: 'scoped', commands: [{ cwd: '../x', argv: ['true'] }] }),
    JSON.stringify({ version: 1, scope: 'scoped', commands: [{ cwd: '/etc', argv: ['true'] }] }),
  ])
    assert(packageRunCommands(bad).error, bad);
});

test('pytest exit 5 (no tests collected) is not a failure; another tool or exit code still is', () => {
  for (const argv of [
    ['pytest', 'packages/a'],
    ['python', '-m', 'pytest', 'a', 'b'],
    ['uv', 'run', 'pytest', 'packages/a'],
    ['poetry', 'run', 'pytest'],
    ['/usr/bin/pytest', '-m', 'not slow', 'a'],
  ])
    assert.equal(noTestsCollected(argv, 5), true, argv.join(' '));
  for (const [argv, status] of [
    [['pytest', 'a'], 1],
    [['pytest', 'a'], 0],
    [['cargo', 'test'], 5],
    [['go', 'test', './...'], 5],
    [['make', 'pytest'], 5],
    [['echo', 'pytest'], 5],
  ])
    assert.equal(noTestsCollected(argv, status), false, `${argv.join(' ')} ${status}`);
  const logs = [];
  const status = { 'pytest a': 5, 'pytest b': 1 };
  const spawn = (cmd, args) => ({ status: status[[cmd, ...args].join(' ')] ?? 0 });
  const root = process.cwd();
  assert.equal(
    runPackageCommands([{ ecosystem: 'python', cwd: '', argv: ['pytest', 'a'] }], root, {
      spawn,
      log: line => logs.push(line),
    }),
    0,
  );
  assert.match(logs.join('\n'), /collected no tests \(exit 5\)/);
  assert.equal(
    runPackageCommands(
      [
        { ecosystem: 'python', cwd: '', argv: ['pytest', 'a'] },
        { ecosystem: 'python', cwd: '', argv: ['pytest', 'b'] },
      ],
      root,
      { spawn, log: () => {} },
    ),
    1,
  );
});

test('the one-line opt-in runs the affected package commands and reports a scoped run', t => {
  // A real repository script: setup, then the line, then its full test step (never reached).
  const files = new Map([
    ['package.json', JSON.stringify({ private: true, workspaces: ['packages/*'] })],
    ['package-lock.json', '{}'],
    ...['a', 'b', 'c'].map(name => [
      `packages/${name}/package.json`,
      JSON.stringify({ name, scripts: { test: 'node --test' } }),
    ]),
    ['ci/check.sh', `set -eu\necho setup\n${PACKAGES_RUN_LINE}\necho FULL-SUITE\n`],
  ]);
  const root = checkout(files);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const selected = actionsGateSelection(run(ci(), gate), ['packages/a/package.json'], files, false);
  assert.equal(selected.scope, 'scoped', selected.reason);
  const packages = writeCheckPackages(root, selected.changes, {
    node: process.execPath,
    script: join(import.meta.dirname, '../scripts/check-packages-run.mjs'),
  });
  t.after(() => packages.remove());
  // Stand-in for npm on PATH: records the argv and the folder it ran in.
  const bin = join(root, '.bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "npm $* in $(pwd)"\n');
  chmodSync(join(bin, 'npm'), 0o755);
  const previous = { ...process.env };
  t.after(() => {
    for (const key of ['FORGE_CHECK_PACKAGES', 'FORGE_CHECK_PACKAGES_RUN'])
      previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key]);
  });
  process.env.FORGE_CHECK_PACKAGES = packages.path;
  process.env.FORGE_CHECK_PACKAGES_RUN = packages.run;
  const inputs = commandCheckInputs({ selection: selected }, 'static');
  assert.equal(inputs.env.FORGE_CHECK_PACKAGES_RUN, packages.run);
  const output = execFileSync('sh', ['ci/check.sh'], {
    cwd: root,
    env: { PATH: `${bin}:${process.env.PATH}`, ...inputs.env },
    encoding: 'utf8',
  });
  assert.match(output, /^setup$/m);
  assert.match(output, /npm run test --workspace=packages\/a in .*forge-graph-first-/);
  assert.doesNotMatch(output, /FULL-SUITE/);
  assert.equal(JSON.parse(readFileSync(inputs.env.FORGE_CHECK_SELECTION, 'utf8')).scope, 'scoped');
  inputs.finish(true);
  // A full run gets no runner, so the same script runs its full steps.
  const fullInputs = commandCheckInputs(
    { selection: actionsGateSelection(run(ci(), undefined), ['packages/a/package.json'], files, false) },
    'static',
  );
  assert.equal(fullInputs.env.FORGE_CHECK_PACKAGES_RUN, undefined);
  const full = execFileSync('sh', ['ci/check.sh'], {
    cwd: root,
    env: { PATH: process.env.PATH, ...fullInputs.env },
    encoding: 'utf8',
  });
  assert.match(full, /FULL-SUITE/);
  fullInputs.finish(true);
});

test('configure-check and check-settings propose the scope only for an undeclared configured command', () => {
  const proposal = commandScopeProposal(ci(null));
  assert.deepEqual(proposal.selection, { scope: 'changed-paths' });
  assert.equal(proposal.line, PACKAGES_RUN_LINE);
  assert.equal(commandScopeProposal(ci()), null);
  assert.equal(commandScopeProposal({ executable: 'node', args: ['scripts/forge-check.mjs'] }), null);
});

test('selection fallback names a graph-first full run', () => {
  const fallback = selectionFallback({
    standard: false,
    gate,
    docsPaths: undefined,
    paths: ['Cargo.toml'],
    mainPaths: null,
    selected: { scope: 'full' },
  });
  assert.equal(fallback, 'graph-full');
});

// Server: the enqueue stamps the gate from server-read policy and main; the plan must carry a minority.
const { checksFixture, code } = await import('./hosted-checks-fixture.mjs');
const { moduleUrl } = await import('./convex-module.mjs');
const { hostedActionsRecipeSchema, hostedActionsRuntime } = await import('../dist/hosted-actions.js');
const { checkPin } = await import('../dist/hosted-check.js');
const { savePin } = await import('../dist/hosted-save.js');
const plans = await import(moduleUrl('../convex/projectHostedActionsPlan.ts'));
const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));
const gates = await import(moduleUrl('../convex/projectHostedGate.ts'));

async function server(t, { check = ci(), main = 'green', paths = ['crates/a/src/lib.rs'] } = {}) {
  const previous = process.env.CONVEX_SITE_URL;
  process.env.CONVEX_SITE_URL = 'https://fixture.invalid';
  t.after(() =>
    previous === undefined ? delete process.env.CONVEX_SITE_URL : (process.env.CONVEX_SITE_URL = previous),
  );
  // The Candidate's own paths (governance), as composition records them.
  const f = await checksFixture(null, {
      candidateFields: { governance: { version: 1, paths, ownerInputs: false } },
    }),
    storage = new Map();
  f.decorateContext(ctx => {
    ctx.storage = { getMetadata: async id => storage.get(id) };
    ctx.scheduler = { runAfter: async () => 'synthetic-task', cancel: async () => {} };
  });
  f.patch('hostedProjects', f.projectId, { autonomyPolicy: policyPreset('trusted') });
  if (main)
    f.insert('projectHostedMainAudits', {
      projectId: f.projectId,
      ...(main === 'red'
        ? {
            red: {
              since: new Date().toISOString(),
              head: f.state.sha256,
              runId: '00000000-0000-4000-8000-000000000001',
            },
          }
        : {}),
      lastGreen: { sequence: 0, head: f.state.sha256, runId: '00000000-0000-4000-8000-000000000000' },
    });
  const repo = 'synthetic/cargo';
  await f.bindRepository(f.projectId, { repository: repo, repoId: 42 });
  const definition = await f.configure(
    { kind: 'definition', checkId: f.checkId, command: check },
    f.definition.digest,
  );
  const configuration = await f.configure(
    {
      kind: 'runner',
      configuration: {
        provider: 'github-actions',
        repository: repo,
        runsOn: 'ubuntu-latest',
        runtime: hostedActionsRuntime,
        environmentFingerprint: f.runner.environmentFingerprint,
      },
    },
    f.configuration.digest,
  );
  const queued = await f.enqueue(
    f.selection({ expectedDefinition: definition.digest, expectedConfiguration: configuration.digest }),
  );
  const id = { projectId: f.projectId, runId: queued.id };
  const reserved = JSON.parse(await f.call('reserve', direct.reserve, id));
  await f.call('bind', direct.observe, {
    ...id,
    fence: reserved.fence,
    outcome: 'accepted',
    executionId: '123',
  });
  const claims = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: process.env.CONVEX_SITE_URL,
    exp: Date.now() / 1000 + 300,
    nbf: Date.now() / 1000 - 30,
    iat: Date.now() / 1000 - 30,
    repository: repo,
    workflow_ref: `${repo}/.github/workflows/forge-check.yml@refs/heads/main`,
    workflow_sha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    event_name: 'workflow_dispatch',
    run_id: '123',
    run_attempt: '1',
    runner_environment: 'github-hosted',
  };
  const prepare = async selection => {
    const pins = {
      head: queued.request.expectedHead,
      definition: queued.check.definition,
      selection,
      groups: [],
      standard: false,
      interaction: false,
      command: [check.executable, ...check.args],
    };
    const recipe = hostedActionsRecipeSchema.parse({ ...pins, pin: checkPin(pins) });
    storage.set('selection', savePin(selection));
    storage.set('recipe', savePin(recipe));
    return JSON.parse(
      await f.call('graphPlan', plans.prepare, {
        ...id,
        claims: JSON.stringify(claims),
        recipe: JSON.stringify(recipe),
        lockfile: 'e'.repeat(64),
        selectionStorage: 'selection',
        recipeStorage: 'recipe',
      }),
    );
  };
  const planFor = changed => actionsGateSelection(queued, changed, repos.cargo, false);
  return { f, queued, prepare, planFor };
}
const echo = (selected, gate) => ({
  ...selected,
  gate: { ...gate, effective: selected.scope === 'full' ? 'full' : 'contract' },
});

test('server: a no-contract Intent with a declared command gets the graph-first gate; the plan records its minority', async t => {
  const s = await server(t);
  assert.deepEqual(s.queued.gate, graphFirstGate());
  const scoped = s.planFor(['crates/a/src/lib.rs']);
  assert.equal(scoped.scope, 'scoped');
  const planned = await s.prepare(echo(scoped, s.queued.gate));
  assert.equal(planned.gate.effective, 'contract', 'scoped evidence, never full');
  // Acceptance re-reads current policy and main: passes now, holds on red main, refuses once the
  // project leaves the contract gate.
  const accept = () =>
    s.f.run(
      'acceptGraphFirst',
      async ctx =>
        gates.hostedAcceptGate(
          ctx,
          await ctx.db.get(s.f.projectId),
          s.f.candidate,
          { kind: 'agent', id: 'owner' },
          planned,
        ),
      {},
    );
  assert.equal(await accept(), 'pass');
  const audit = [...s.f.tables.projectHostedMainAudits.values()][0];
  s.f.patch('projectHostedMainAudits', audit._id, {
    red: { since: new Date().toISOString(), head: s.f.state.sha256, runId: audit.lastGreen.runId },
  });
  assert.equal(await accept(), 'main-red');
  s.f.patch('hostedProjects', s.f.projectId, { autonomyPolicy: policyPreset('supervised') });
  assert.equal(await accept(), 'full-required');
  // A plan that drops or inflates the recorded share is refused before the command runs.
  const { graph: _graph, ...unrecorded } = scoped;
  for (const selection of [
    unrecorded,
    { ...scoped, graph: { ...scoped.graph, selected: 3, total: 4 } },
    { ...scoped, graph: { ...scoped.graph, selected: 0 } },
  ])
    await assert.rejects(s.prepare(echo(selection, s.queued.gate)), code('EVIDENCE_CHANGED'));
});

test('server: a majority change plans full evidence under the same gate', async t => {
  const s = await server(t, { paths: ['crates/core/src/lib.rs'] });
  const full = s.planFor(['crates/core/src/lib.rs']);
  assert.equal(full.scope, 'full');
  assert.equal((await s.prepare(echo(full, s.queued.gate))).gate.effective, 'full');
});

test('server: an undeclared command, a red or unaudited main, or unknown paths keep the full first check', async t => {
  for (const options of [
    { check: ci(null) },
    { main: 'red' },
    { main: null },
    { paths: ['.github/workflows/ci.yml'] },
  ]) {
    const s = await server(t, options);
    assert.equal(s.queued.gate.mode, 'full', JSON.stringify(options));
  }
});
