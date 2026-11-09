// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { githubActionsWorkflow } from '../dist/github-actions-workflow.js';
import {
  ACTIONS_TOOLS,
  CACHE_PRESETS,
  CACHE_PRESET_NAMES,
  actionsDeclaration,
  actionsToolchainsSchema,
  actionsCacheSchema,
  CACHE_SEEDS,
  DEPS_SEED_PROGRAM,
} from '../dist/actions-toolchains.js';
import {
  hostedDeclaredSteps,
  hostedDepsCache,
  hostedSeedSteps,
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
  // Zig and CMake declare a version only (their actions read no Candidate file).
  ['zig', { tool: 'zig', version: '0.14.0' }, undefined],
  ['cmake', { tool: 'cmake', version: '3.31.6' }, undefined],
  [
    'elixir',
    { tool: 'elixir', version: '1.17', otpVersion: '27' },
    { tool: 'elixir', versionFile: '.tool-versions' },
  ],
  ['ruby', { tool: 'ruby', version: '3.3' }, { tool: 'ruby', versionFile: 'app/.ruby-version' }],
  ['php', { tool: 'php', version: '8.3' }, { tool: 'php', versionFile: '.php-version' }],
  // setup-dart reads no version file; Flutter reads pubspec.yaml, and a channel name picks a channel.
  ['dart', { tool: 'dart', version: '3.5' }, undefined],
  ['flutter', { tool: 'flutter', version: '3.24.5' }, { tool: 'flutter', versionFile: 'app/pubspec.yaml' }],
];
test('generated workflow snapshot per toolchain, by version and from a file', () => {
  assert.deepEqual(
    toolchainCases.map(([tool]) => tool),
    [...ACTIONS_TOOLS],
  );
  for (const [tool, byVersion, byFile] of toolchainCases) {
    snapshot(`toolchain-${tool}.yml`, githubActionsWorkflow('ubuntu-latest', { toolchains: [byVersion] }));
    if (byFile)
      snapshot(
        `toolchain-${tool}-file.yml`,
        githubActionsWorkflow('ubuntu-latest', { toolchains: [byFile] }),
      );
  }
});

test('Zig and CMake (Issue 345ebcb9): version only, pinned actions that never write a cache, own hosted blocks', async () => {
  const { hostedLateToolBlocks, declaredStepsInstalled, hostedWorkflowBlocks } =
    await import('../dist/actions-toolchains-hosted.js');
  const parse = toolchains => actionsToolchainsSchema.safeParse(toolchains).success;
  assert.equal(
    parse([
      { tool: 'zig', version: '0.14.0' },
      { tool: 'cmake', version: '3.31.6' },
    ]),
    true,
  );
  assert.equal(parse([{ tool: 'zig', versionFile: 'build.zig.zon' }]), false);
  assert.equal(parse([{ tool: 'cmake', versionFile: 'CMakeLists.txt' }]), false);
  assert.equal(parse([{ tool: 'zig', version: '0.14.0', distribution: 'zulu' }]), false);
  // The action's own cache would save from inside the check; Forge's cache step is the only writer.
  const workflow = githubActionsWorkflow('ubuntu-latest', {
    toolchains: [
      { tool: 'zig', version: '0.14.0' },
      { tool: 'cmake', version: '3.31.6' },
    ],
  });
  assert.match(
    workflow,
    /uses: mlugg\/setup-zig@[0-9a-f]{40} # v2\.2\.1\n {8}with:\n {10}version: "0\.14\.0"\n {10}use-cache: false/,
  );
  assert.match(
    workflow,
    /uses: lukka\/get-cmake@[0-9a-f]{40} # v4\.4\.2\n {8}with:\n {10}cmakeVersion: "3\.31\.6"\n {10}useCloudCache: false/,
  );
  // Hosted: the pinned declaration reaches the workflow through the plan outputs.
  assert.deepEqual(hostedToolchains({ toolchains: [{ tool: 'zig', version: '0.14.0' }] }), {
    zig: { version: '0.14.0', versionFile: '' },
  });
  // The blocks every runner repository already installed do not change; the new tools have their own.
  const installed = hostedWorkflowBlocks().join('\n');
  assert.doesNotMatch(installed, /setup-zig|get-cmake/);
  const zig = { toolchains: [{ tool: 'zig', version: '0.14.0' }] };
  assert.equal(declaredStepsInstalled(installed, { toolchains: [{ tool: 'go', version: '1.23' }] }), true);
  assert.equal(declaredStepsInstalled(installed, zig), false);
  assert.equal(declaredStepsInstalled(`${installed}\n${hostedLateToolBlocks('zig')[0]}`, zig), false);
  assert.equal(declaredStepsInstalled(`${installed}\n${hostedLateToolBlocks('zig').join('\n')}`, zig), true);
  assert.equal(
    declaredStepsInstalled(`${installed}\n${hostedLateToolBlocks('zig').join('\n')}`, {
      toolchains: [{ tool: 'cmake', version: '3.31.6' }],
    }),
    false,
  );
  for (const tool of ['zig', 'cmake'])
    for (const block of hostedLateToolBlocks(tool)) {
      assert.deepEqual(actionPinFindings(tool, block), [], tool);
      assert.match(block, new RegExp(`if: .*fromJSON\\(.*toolchains.*\\)\\.${tool}\\n`));
    }
});

test('vcpkg, conan and zig cache presets: restored from the lockfiles, only Zig is seeded (Candidate-free)', () => {
  assert.deepEqual(CACHE_PRESETS.vcpkg.paths, ['~/.cache/vcpkg/archives']);
  assert.deepEqual(CACHE_PRESETS.conan.paths, ['~/.conan2/p']);
  assert.deepEqual(CACHE_PRESETS.zig.paths, ['~/.cache/zig/p']);
  assert.deepEqual(CACHE_SEEDS.zig, {
    lockfile: 'build.zig.zon',
    manifests: ['build.zig'],
    command: ['zig', 'build', '--fetch'],
  });
  assert.equal(CACHE_SEEDS.vcpkg, undefined);
  assert.equal(CACHE_SEEDS.conan, undefined);
  const files = [
    { path: 'svc/build.zig.zon', blob: 'b1' },
    { path: 'vcpkg.json', blob: 'b2' },
    { path: 'src/main.zig', blob: 'b3' },
  ];
  const input = { projectId: 'p', files, save: true, os: 'Linux', arch: 'X64' };
  const zig = hostedDepsCache({ cache: { presets: ['zig'] } }, input);
  assert.equal(zig.seed, 'zig');
  assert.notEqual(
    zig.key,
    hostedDepsCache(
      { cache: { presets: ['zig'] } },
      { ...input, files: [{ ...files[0], blob: 'b9' }, ...files.slice(1)] },
    ).key,
  );
  assert.equal(
    zig.key,
    hostedDepsCache({ cache: { presets: ['zig'] } }, { ...input, files: files.slice(0, 1) }).key,
    'only lockfiles are keyed',
  );
  const vcpkg = hostedDepsCache({ cache: { presets: ['vcpkg', 'conan'] } }, input);
  assert.equal(vcpkg.seed, '');
  assert.match(vcpkg.paths, /vcpkg\/archives\n~\/\.conan2\/p/);
});

test('the Zig seed copies only build.zig.zon and build.zig into an empty folder and runs zig build --fetch', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-zig-seed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'),
    bin = join(root, 'bin'),
    log = join(root, 'log.json');
  for (const dir of [join(repo, 'src'), bin]) mkdirSync(dir, { recursive: true });
  for (const [name, text] of [
    ['build.zig.zon', '.{}'],
    ['build.zig', 'pub fn build() void {}'],
    ['src/main.zig', 'pub fn main() void {}'],
    ['.npmrc', 'repository configuration'],
  ])
    writeFileSync(join(repo, name), text);
  writeFileSync(
    join(bin, 'zig'),
    `#!/bin/sh\nnode -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({cwd: process.cwd(), files: require("fs").readdirSync(".").sort(), args: process.argv.slice(2)}))' ${JSON.stringify(log)} "$@"\n`,
    { mode: 0o755 },
  );
  const result = spawnSync(process.execPath, ['-e', DEPS_SEED_PROGRAM, repo, 'zig'], {
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const ran = JSON.parse(readFileSync(log, 'utf8'));
  assert.deepEqual(ran.files, ['build.zig', 'build.zig.zon']);
  assert.deepEqual(ran.args, ['build', '--fetch']);
  assert.ok(!ran.cwd.startsWith(repo), 'the download runs outside the Candidate');
  assert.match(result.stdout, /Forge seed: zig build\.zig\.zon downloaded/);
});

test('generated workflow snapshot per cache preset: restored before the check, seeded Candidate-free only by main', () => {
  for (const preset of Object.keys(CACHE_PRESETS)) {
    const workflow = githubActionsWorkflow('ubuntu-latest', { cache: { presets: [preset] } });
    snapshot(`cache-${preset}.yml`, workflow);
    assert.equal(workflow.match(/actions\/cache\/restore@/g).length, 2);
    // A seeded preset saves once, from the static job's seed, before the check; others never save.
    const seeded = Boolean(CACHE_SEEDS[preset]);
    assert.equal((workflow.match(/actions\/cache\/save@/g) ?? []).length, seeded ? 1 : 0, preset);
    assert.equal(
      (
        workflow.match(
          /github.ref == format\('refs\/heads\/\{0\}', github.event.repository.default_branch\)/g,
        ) ?? []
      ).length,
      seeded ? 2 : 0,
    );
    if (seeded) {
      const check = workflow.lastIndexOf('      - run: node scripts/forge-check.mjs');
      assert.ok(workflow.indexOf('actions/cache/save@') < check, `${preset} saves before the check`);
      assert.ok(workflow.indexOf('actions/cache/save@') > workflow.indexOf('  static:'));
    }
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
    'hosted-plan-seed.yml',
    hostedSeedSteps('steps.plan.outputs', "steps.plan.outputs.single_shard != '' && "),
  );
  // Values reach the Rust shell step only through env, never through its script text.
  const steps = hostedDeclaredSteps('needs.hosted-plan.outputs');
  const script = steps.slice(steps.indexOf('run: |'), steps.indexOf('        env:'));
  assert.doesNotMatch(script, /\$\{\{/);
});

test('schema literals match the tool and preset lists they stand for', () => {
  assert.deepEqual([...CACHE_PRESET_NAMES], Object.keys(CACHE_PRESETS));
  const tools = ACTIONS_TOOLS.map(tool => ({
    tool,
    version: '1',
    ...(tool === 'elixir' ? { otpVersion: '27' } : {}),
  }));
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
    [{ tool: 'elixir', version: '1.17' }],
    [{ tool: 'go', version: '1.23', otpVersion: '27' }],
    [{ tool: 'elixir', versionFile: 'mix.exs' }],
    [{ tool: 'ruby', versionFile: 'Gemfile' }],
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
  assert.equal(entry.seed, 'go');
  assert.equal(hostedDepsCache({ cache: { presets: ['cargo'] } }, input).seed, '');
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
    INSTALL_DIR_FOR_OTP: '/opt/otp',
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
    'INSTALL_DIR_FOR_OTP',
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
  assert.equal(blocks.length, 2);
  assert.equal(declaredStepsInstalled(blocks.join('\n')), true);
  assert.equal(declaredStepsInstalled(blocks.slice(1).join('\n')), false);
  for (const block of blocks) assert.deepEqual(actionPinFindings('block', block), []);
  // Tools added later (Dart, Flutter) have blocks of their own: a workflow installed before them still
  // runs checks that declare only the first tools, and refuses one that declares a later tool.
  const { hostedLateToolBlocks, HOSTED_LATE_TOOLS } = await import('../dist/actions-toolchains-hosted.js');
  const first = blocks.join('\n');
  const go = { toolchains: [{ tool: 'go', version: '1.23' }] };
  const dart = {
    toolchains: [
      { tool: 'go', version: '1.23' },
      { tool: 'dart', version: '3.5' },
    ],
  };
  assert.equal(declaredStepsInstalled(first, go), true);
  assert.equal(declaredStepsInstalled(first, dart), false);
  assert.equal(declaredStepsInstalled([...hostedLateToolBlocks('dart'), first].join('\n'), dart), true);
  for (const tool of HOSTED_LATE_TOOLS)
    for (const block of hostedLateToolBlocks(tool)) {
      assert.deepEqual(actionPinFindings(tool, block), []);
      assert.ok(!blocks.some(old => old.includes(block)), `${tool} steps are not in the first blocks`);
    }
});

test('hosted Elixir, Ruby and PHP blocks (Issue 721cd45c): plan outputs, Candidate paths, PHP gets no token', async () => {
  const { hostedLateToolBlocks, HOSTED_LATE_TOOLS, hostedUnsupportedTools } =
    await import('../dist/actions-toolchains-hosted.js');
  // Every declarable tool now has fixed-workflow steps; none is refused by name.
  assert.deepEqual(hostedUnsupportedTools({ toolchains: ACTIONS_TOOLS.map(tool => ({ tool })) }), []);
  snapshot('hosted-late-tools.yml', HOSTED_LATE_TOOLS.flatMap(tool => hostedLateToolBlocks(tool)).join(''));
  assert.deepEqual(
    hostedToolchains({
      toolchains: [
        { tool: 'elixir', version: '1.17', otpVersion: '27' },
        { tool: 'ruby', versionFile: 'app/.ruby-version' },
        { tool: 'php', version: '8.3' },
      ],
    }),
    {
      elixir: { version: '1.17', otpVersion: '27', versionFile: '', versionType: 'loose' },
      ruby: { version: '.ruby-version', directory: 'app' },
      php: { version: '8.3', versionFile: '' },
    },
  );
  assert.deepEqual(
    hostedToolchains({
      toolchains: [
        { tool: 'elixir', versionFile: '.tool-versions' },
        { tool: 'ruby', version: '3.3' },
        { tool: 'php', versionFile: '.php-version' },
      ],
    }),
    {
      elixir: { version: '', otpVersion: '', versionFile: '.tool-versions', versionType: 'strict' },
      ruby: { version: '3.3', directory: '.' },
      php: { version: '', versionFile: '.php-version' },
    },
  );
  for (const block of hostedLateToolBlocks('php')) assert.match(block, /\n {10}github-token: ''\n$/);
  for (const block of hostedLateToolBlocks('ruby')) assert.doesNotMatch(block, /bundler-cache/);
  // Paths read from the Candidate are under runner.temp/candidate, never the control checkout.
  for (const tool of ['elixir', 'ruby', 'php'])
    for (const block of hostedLateToolBlocks(tool))
      assert.match(block, /format\('\{0\}\/candidate\/\{1\}', runner\.temp, /, tool);
});

test('Dart takes a version only, Flutter a version, a channel or pubspec.yaml', () => {
  const parse = toolchains => actionsToolchainsSchema.safeParse(toolchains).success;
  assert.equal(parse([{ tool: 'dart', version: 'stable' }]), true);
  assert.equal(parse([{ tool: 'dart', versionFile: 'pubspec.yaml' }]), false);
  assert.equal(parse([{ tool: 'flutter', versionFile: 'app/pubspec.yaml' }]), true);
  assert.equal(parse([{ tool: 'flutter', versionFile: '.flutter-version' }]), false);
  assert.match(
    githubActionsWorkflow('ubuntu-latest', { toolchains: [{ tool: 'flutter', version: 'beta' }] }),
    /subosito\/flutter-action@[0-9a-f]{40} # v2\.23\.0\n {8}with:\n {10}channel: "beta"\n/,
  );
  assert.deepEqual(
    hostedToolchains({
      toolchains: [
        { tool: 'flutter', version: 'beta' },
        { tool: 'dart', version: '3.5' },
      ],
    }),
    {
      flutter: { version: '', versionFile: '', channel: 'beta' },
      dart: { version: '3.5', versionFile: '' },
    },
  );
  assert.deepEqual(hostedToolchains({ toolchains: [{ tool: 'flutter', version: '3.24.5' }] }).flutter, {
    version: '3.24.5',
    versionFile: '',
    channel: 'stable',
  });
});

test("this repository's forge-check.yml installs every declared-setup block and plan output", async () => {
  const { declaredStepsInstalled, HOSTED_LATE_TOOLS, hostedLateToolBlocks } =
    await import('../dist/actions-toolchains-hosted.js');
  const workflow = readFileSync(new URL('../.github/workflows/forge-check.yml', import.meta.url), 'utf8');
  assert.equal(declaredStepsInstalled(workflow), true);
  // Every late tool too, each block before its job's dependency-cache restore.
  const all = { toolchains: HOSTED_LATE_TOOLS.map(tool => ({ tool, version: '1' })) };
  assert.equal(declaredStepsInstalled(workflow, all), true);
  const restores = [...workflow.matchAll(/^ {8}id: forge-deps$/gm)].map(m => m.index);
  assert.equal(restores.length, 2);
  for (const tool of HOSTED_LATE_TOOLS)
    hostedLateToolBlocks(tool).forEach((block, job) => {
      const at = workflow.indexOf(block);
      assert.ok(at < restores[job] && (job === 0 || at > restores[0]), `${tool} block ${job}`);
    });
  assert.match(workflow, /^ {6}toolchains: \$\{\{ steps\.plan\.outputs\.toolchains \}\}$/m);
  assert.match(workflow, /^ {6}deps_cache: \$\{\{ steps\.plan\.outputs\.deps_cache \}\}$/m);
});

test('the dependency seed copies only lockfiles and manifests into an empty folder and never fails', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-seed-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'),
    bin = join(root, 'bin'),
    log = join(root, 'log.jsonl');
  for (const dir of [repo, join(repo, 'svc'), join(repo, 'node_modules/dep'), bin])
    mkdirSync(dir, { recursive: true });
  writeFileSync(join(repo, 'package-lock.json'), '{}');
  writeFileSync(join(repo, 'package.json'), '{}');
  writeFileSync(join(repo, '.npmrc'), 'repository configuration');
  writeFileSync(join(repo, 'svc/go.sum'), '');
  writeFileSync(join(repo, 'svc/go.mod'), 'module x');
  writeFileSync(join(repo, 'svc/main.go'), 'package main');
  writeFileSync(join(repo, 'node_modules/dep/package-lock.json'), '{}');
  // A fake npm records its folder and what it can see; a fake go fails (a broken tool skips its lockfile).
  const record = `#!/bin/sh\nnode -e 'require("fs").appendFileSync(process.argv[1], JSON.stringify({cwd: process.cwd(), files: require("fs").readdirSync(".").sort(), args: process.argv.slice(2)})+"\\n")' ${JSON.stringify(log)} "$@"\n`;
  writeFileSync(join(bin, 'npm'), record, { mode: 0o755 });
  writeFileSync(join(bin, 'go'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, ['-e', DEPS_SEED_PROGRAM, repo, 'npm go cargo'], {
    env: { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const [npm, ...more] = readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(more.length, 0, 'node_modules is never walked');
  assert.deepEqual(npm.files, ['package-lock.json', 'package.json']);
  assert.ok(!npm.cwd.startsWith(repo), 'the download runs outside the Candidate');
  assert.deepEqual(npm.args, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  assert.match(result.stdout, /Forge seed: npm package-lock.json downloaded/);
  assert.match(result.stdout, /Forge seed: go svc\/go.sum skipped \(exit 3\)/);
  assert.match(result.stdout, /Forge seed: 2 lockfiles for npm, go/);
});
