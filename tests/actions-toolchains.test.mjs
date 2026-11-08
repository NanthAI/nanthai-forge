// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { githubActionsWorkflow } from '../dist/github-actions-workflow.js';
import {
  ACTIONS_TOOLS,
  CACHE_PRESETS,
  CACHE_PRESET_NAMES,
  actionsDeclaration,
  actionsToolchainsSchema,
  actionsCacheSchema,
} from '../dist/actions-toolchains.js';
import {
  hostedDeclaredSteps,
  hostedDepsCache,
  hostedSaveSteps,
  hostedToolchains,
} from '../dist/actions-toolchains-hosted.js';
import { hostedCheckDefinition } from '../dist/hosted-check.js';
import { hostedActionsRecipeSchema } from '../dist/hosted-actions.js';
import { digest } from '../dist/hash.js';
import { actionPinFindings } from '../scripts/check-action-pins.mjs';
import { toolchainEnvAllow, toolchainEnvNames, toolchainEnvPattern } from '../scripts/child-env.mjs';
import { runActionsCheck } from '../scripts/github-actions-check.mjs';

// Snapshots are reviewed bytes: UPDATE_ACTIONS_SNAPSHOTS=1 rewrites them after a deliberate change.
const fixtures = new URL('./fixtures/actions-workflow/', import.meta.url);
function snapshot(name, text) {
  const file = new URL(name, fixtures);
  if (process.env.UPDATE_ACTIONS_SNAPSHOTS === '1') writeFileSync(file, text);
  assert.equal(text, readFileSync(file, 'utf8'), `snapshot ${name}`);
  assert.deepEqual(actionPinFindings(name, text), [], name);
}

test('undeclared checks generate the same workflow bytes as before toolchains existed', () => {
  // These fixtures were captured from the generator before the declaration existed.
  const before = readFileSync(new URL('undeclared.yml', fixtures), 'utf8');
  const selfHosted = readFileSync(new URL('undeclared-self-hosted.yml', fixtures), 'utf8');
  assert.equal(githubActionsWorkflow(), before);
  assert.equal(githubActionsWorkflow('ubuntu-latest', undefined), before);
  assert.equal(githubActionsWorkflow(['self-hosted', 'linux']), selfHosted);
  // A setup-only declaration is not a workflow declaration.
  assert.equal(actionsDeclaration({ actions: { setup: { executable: 'warm', args: [] } } }), undefined);
  assert.equal(githubActionsWorkflow('ubuntu-latest', actionsDeclaration({})), before);
});

const toolchainCases = [
  ['go', { tool: 'go', version: '1.23' }, { tool: 'go', versionFile: 'go.mod' }],
  ['python', { tool: 'python', version: '3.12' }, { tool: 'python', versionFile: '.python-version' }],
  [
    'java',
    { tool: 'java', version: '21', distribution: 'zulu' },
    { tool: 'java', versionFile: '.java-version' },
  ],
  ['dotnet', { tool: 'dotnet', version: '8.0.x' }, { tool: 'dotnet', versionFile: 'global.json' }],
  ['rust', { tool: 'rust', version: '1.82.0' }, { tool: 'rust', versionFile: 'crates/rust-toolchain.toml' }],
];
test('generated workflow snapshot per toolchain, by version and from a file', () => {
  assert.deepEqual(
    toolchainCases.map(([tool]) => tool),
    [...ACTIONS_TOOLS],
  );
  for (const [tool, byVersion, byFile] of toolchainCases) {
    snapshot(`toolchain-${tool}.yml`, githubActionsWorkflow('ubuntu-latest', { toolchains: [byVersion] }));
    snapshot(`toolchain-${tool}-file.yml`, githubActionsWorkflow('ubuntu-latest', { toolchains: [byFile] }));
  }
});

test('generated workflow snapshot per cache preset, keyed on its lockfiles and saved only by main', () => {
  for (const preset of Object.keys(CACHE_PRESETS)) {
    const workflow = githubActionsWorkflow('ubuntu-latest', { cache: { presets: [preset] } });
    snapshot(`cache-${preset}.yml`, workflow);
    // Restore in both jobs before the check; save after it, only on the default branch.
    assert.equal(workflow.match(/actions\/cache\/restore@/g).length, 2);
    assert.equal(workflow.match(/actions\/cache\/save@/g).length, 2);
    assert.equal(
      workflow.match(/github.ref == format\('refs\/heads\/\{0\}', github.event.repository.default_branch\)/g)
        .length,
      2,
    );
    for (const glob of CACHE_PRESETS[preset].lockfiles) assert.ok(workflow.includes(`'${glob}'`), glob);
  }
  const custom = githubActionsWorkflow('ubuntu-latest', {
    toolchains: [{ tool: 'go', versionFile: 'go.mod' }],
    cache: { presets: ['go', 'cargo'], lockfiles: ['go.sum', 'tools/Cargo.lock'] },
  });
  snapshot('combined.yml', custom);
  assert.match(
    custom,
    /key: forge-deps-v1-go\+cargo-\$\{\{ runner.os \}\}-\$\{\{ runner.arch \}\}-\$\{\{ hashFiles\('go.sum', 'tools\/Cargo.lock'\) \}\}/,
  );
  // The semantic static rewrite still finds the static job's run step last.
  assert.ok(custom.lastIndexOf('      - run: node scripts/forge-check.mjs') > custom.indexOf('  static:'));
});

test('hosted fixed-workflow steps read the pinned plan outputs and pin every action', () => {
  snapshot(
    'hosted-plan-steps.yml',
    hostedDeclaredSteps('steps.plan.outputs', "steps.plan.outputs.single_shard != '' && "),
  );
  snapshot('hosted-check-steps.yml', hostedDeclaredSteps('needs.hosted-plan.outputs'));
  snapshot(
    'hosted-plan-save.yml',
    hostedSaveSteps('steps.plan.outputs', "steps.plan.outputs.single_shard != '' && "),
  );
  // Values reach the Rust shell step only through env, never through its script text.
  const steps = hostedDeclaredSteps('needs.hosted-plan.outputs');
  const script = steps.slice(steps.indexOf('run: |'), steps.indexOf('        env:'));
  assert.doesNotMatch(script, /\$\{\{/);
});

test('schema literals match the tool and preset lists they stand for', () => {
  assert.deepEqual([...CACHE_PRESET_NAMES], Object.keys(CACHE_PRESETS));
  const tools = ACTIONS_TOOLS.map(tool => ({ tool, version: '1' }));
  assert.equal(actionsToolchainsSchema.safeParse(tools).success, true);
  assert.equal(actionsCacheSchema.safeParse({ presets: [...CACHE_PRESET_NAMES] }).success, true);
});

test('the declaration is a fixed allowlist: unsafe or unknown values never reach YAML', () => {
  for (const toolchains of [
    [{ tool: 'node', version: '24' }],
    [{ tool: 'go', version: '${{ secrets.X }}' }],
    [{ tool: 'go', version: '1.23" && curl x' }],
    [{ tool: 'go', version: '1.23\nrun: x' }],
    [{ tool: 'go', version: '1.23', versionFile: 'go.mod' }],
    [{ tool: 'go' }],
    [{ tool: 'go', versionFile: '/etc/passwd' }],
    [{ tool: 'go', versionFile: '../go.mod' }],
    [{ tool: 'go', versionFile: "go'.mod" }],
    [{ tool: 'go', version: '1.23', distribution: 'temurin' }],
    [{ tool: 'java', version: '21', distribution: 'unknown' }],
    [{ tool: 'rust', versionFile: 'Cargo.toml' }],
    [{ tool: 'go', version: '1.23', extra: true }],
    [
      { tool: 'go', version: '1.23' },
      { tool: 'go', version: '1.22' },
    ],
    [],
  ])
    assert.equal(actionsToolchainsSchema.safeParse(toolchains).success, false, JSON.stringify(toolchains));
  for (const cache of [
    { presets: [] },
    { presets: ['bazel'] },
    { presets: ['go', 'go'] },
    { presets: ['go'], lockfiles: ["go.sum') }}"] },
    { presets: ['go'], lockfiles: ['{a,b}.lock'] },
    { presets: ['go'], lockfiles: ['../go.sum'] },
    { presets: ['go'], lockfiles: ['/go.sum'] },
    { presets: ['go'], paths: ['/'] },
  ])
    assert.equal(actionsCacheSchema.safeParse(cache).success, false, JSON.stringify(cache));
  assert.equal(actionsCacheSchema.safeParse({ presets: ['go'], lockfiles: ['**/go.sum'] }).success, true);
});

const command = { name: 'verify', executable: 'go', args: ['test', './...'], environmentLabel: 'Go' };
test('a definition pins its declaration in its digest; setup-only definitions keep their digest', () => {
  const setup = { setup: { executable: '/opt/warm', args: [] } };
  const old = hostedCheckDefinition(
    { ...command, actions: setup },
    'a0000000-0000-4000-8000-000000000000',
    'x',
  );
  // The digest of the same fields as before the declaration existed.
  assert.equal(old.definition, digest(JSON.stringify({ ...command, actions: setup })));
  const declared = { toolchains: [{ tool: 'go', versionFile: 'go.mod' }], cache: { presets: ['go'] } };
  const fields = { actionsToolchains: declared.toolchains, actionsCache: declared.cache };
  const a = hostedCheckDefinition({ ...command, ...fields }, old.id, 'x');
  const b = hostedCheckDefinition(
    { ...command, ...fields, actionsCache: { presets: ['cargo'] } },
    old.id,
    'x',
  );
  assert.notEqual(a.definition, b.definition);
  assert.notEqual(a.definition, old.definition);
  assert.deepEqual(actionsDeclaration(a), declared);
  // `actions.setup` stays required, so released CLIs keep parsing every check reply.
  assert.throws(() => hostedCheckDefinition({ ...command, actions: {} }, old.id, 'x'));
  assert.throws(() => hostedCheckDefinition({ ...command, actions: declared }, old.id, 'x'));
  assert.throws(() =>
    hostedCheckDefinition({ ...command, actionsCache: { presets: ['bazel'] } }, old.id, 'x'),
  );
  // Recipes accept the pinned declaration and nothing else under `actions`.
  const recipe = {
    pin: 'a'.repeat(64),
    head: 'b'.repeat(64),
    definition: a.definition,
    selection: { scope: 'full', reason: 'x', tests: [] },
    groups: [],
    standard: false,
    interaction: false,
    command: ['go', 'test', './...'],
  };
  assert.equal(hostedActionsRecipeSchema.safeParse({ ...recipe, actions: declared }).success, true);
  assert.equal(hostedActionsRecipeSchema.safeParse({ ...recipe, actions: setup }).success, false);
});

test('hosted outputs: version files are Candidate-relative and the cache key follows lockfile content only', () => {
  const declared = {
    toolchains: [
      { tool: 'go', versionFile: 'go.mod' },
      { tool: 'java', version: '21' },
      { tool: 'rust', versionFile: 'rust-toolchain.toml' },
    ],
    cache: { presets: ['go'] },
  };
  assert.deepEqual(hostedToolchains(declared), {
    go: { version: '', versionFile: 'go.mod' },
    java: { version: '21', versionFile: '', distribution: 'temurin' },
    rust: { version: '', directory: '.' },
  });
  assert.deepEqual(hostedToolchains(undefined), {});
  assert.deepEqual(hostedDepsCache(undefined, { projectId: 'p', files: [], save: true }), {});
  const files = [
    { path: 'go.sum', blob: '1'.repeat(64) },
    { path: 'svc/go.sum', blob: '2'.repeat(64) },
    { path: 'main.go', blob: '3'.repeat(64) },
  ];
  const input = { projectId: 'p', files, save: false, os: 'Linux', arch: 'X64' };
  const entry = hostedDepsCache(declared, input);
  assert.match(entry.key, /^forge-deps-v1-go-[0-9a-f]{16}-Linux-X64-[0-9a-f]{64}$/);
  assert.equal(entry.paths, '~/go/pkg/mod\n~/.cache/go-build');
  assert.equal(entry.save, false);
  // Source edits keep the key; a lockfile edit, another project or another runner changes it.
  const edited = files.map(f => (f.path === 'main.go' ? { ...f, blob: '4'.repeat(64) } : f));
  assert.equal(hostedDepsCache(declared, { ...input, files: [...edited].reverse() }).key, entry.key);
  const locked = files.map(f => (f.path === 'svc/go.sum' ? { ...f, blob: '5'.repeat(64) } : f));
  assert.notEqual(hostedDepsCache(declared, { ...input, files: locked }).key, entry.key);
  assert.notEqual(hostedDepsCache(declared, { ...input, projectId: 'q' }).key, entry.key);
  assert.notEqual(hostedDepsCache(declared, { ...input, arch: 'ARM64' }).key, entry.key);
});

test('toolchain locations pass to configured commands; credential names never do', t => {
  const source = {
    PATH: '/bin',
    JAVA_HOME: '/opt/jdk',
    JAVA_HOME_21_X64: '/opt/jdk21',
    GOROOT_1_23_ARM64: '/opt/go',
    ANDROID_HOME: '/opt/android',
    CARGO_HOME: '/opt/cargo',
    pythonLocation: '/opt/python',
    GITHUB_TOKEN: 'synthetic',
    ACTIONS_RUNTIME_TOKEN: 'synthetic',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'synthetic',
    NPM_TOKEN: 'synthetic',
    CARGO_REGISTRY_TOKEN: 'synthetic',
    NUGET_AUTH_TOKEN: 'synthetic',
    AWS_SECRET_ACCESS_KEY: 'synthetic',
    JAVA_HOME_TOKEN_X64: 'synthetic',
  };
  assert.deepEqual(toolchainEnvAllow(source).sort(), [
    'ANDROID_HOME',
    'CARGO_HOME',
    'GOROOT_1_23_ARM64',
    'JAVA_HOME',
    'JAVA_HOME_21_X64',
    'pythonLocation',
  ]);
  for (const name of toolchainEnvNames)
    assert.doesNotMatch(name, /TOKEN|SECRET|PASSWORD|KEY|AUTH|CREDENTIAL/i);
  assert.doesNotMatch('GITHUB_TOKEN', toolchainEnvPattern);

  const root = mkdtempSync(join(tmpdir(), 'forge-toolchain-env-'));
  const saved = Object.fromEntries(
    ['FORGE_ACTIONS_PLAN', 'FORGE_ACTIONS_SHARD', 'JAVA_HOME_21_X64', 'GITHUB_TOKEN'].map(n => [
      n,
      process.env[n],
    ]),
  );
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    rmSync(root, { recursive: true, force: true });
  });
  process.env.JAVA_HOME_21_X64 = '/opt/jdk21';
  process.env.GITHUB_TOKEN = 'synthetic';
  process.env.FORGE_ACTIONS_SHARD = 'static';
  process.env.FORGE_ACTIONS_PLAN = join(root, 'plan.json');
  const seen = [];
  for (const standard of [false, true]) {
    writeFileSync(
      process.env.FORGE_ACTIONS_PLAN,
      JSON.stringify({
        standard,
        command: ['gradle', 'test'],
        groups: [],
        // A configured command runs in full; Forge's own docs scope runs its document checks.
        selection: { scope: standard ? 'docs' : 'full', reason: 'x', tests: [] },
      }),
    );
    runActionsCheck((_command, _args, { env }) => seen.push({ standard, env }), { install: false });
  }
  const opaque = seen.find(s => !s.standard),
    forge = seen.find(s => s.standard);
  assert.equal(opaque.env.JAVA_HOME_21_X64, '/opt/jdk21');
  assert.equal(opaque.env.GITHUB_TOKEN, undefined);
  // Forge's own suite keeps its exact environment.
  assert.equal(forge.env.JAVA_HOME_21_X64, undefined);
  assert.equal(existsSync(join(root, 'plan.json')), true);
});

test('declared-setup step check: undefined skips, a workflow needs every generated block', async () => {
  const { declaredStepsInstalled, hostedWorkflowBlocks } =
    await import('../dist/actions-toolchains-hosted.js');
  assert.equal(declaredStepsInstalled(undefined), true);
  assert.equal(declaredStepsInstalled(''), false);
  const blocks = hostedWorkflowBlocks();
  assert.equal(blocks.length, 4);
  assert.equal(declaredStepsInstalled(blocks.join('\n')), true);
  assert.equal(declaredStepsInstalled(blocks.slice(1).join('\n')), false);
  for (const block of blocks) assert.deepEqual(actionPinFindings('block', block), []);
});
