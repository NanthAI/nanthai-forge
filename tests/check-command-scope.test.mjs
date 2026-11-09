// SPDX-License-Identifier: Apache-2.0
// Any configured check command, not only Forge's own recipe, gets the changed-paths file; a
// check that declares scope or shards gets scoped evidence and shard jobs (Issue efa03bee).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionsGateSelection } from '../dist/hosted-actions-job-plan.js';
import {
  commandChangesBytes,
  commandSelection,
  commandShardCount,
  commandShardGroups,
} from '../dist/check-command-scope.js';
import { hostedActionsRecipeSchema, hostedActionsRuntime } from '../dist/hosted-actions.js';
import { checkPin, hostedCheckDefinition } from '../dist/hosted-check.js';
import { savePin } from '../dist/hosted-save.js';
import { runActionsCheck } from '../scripts/github-actions-check.mjs';
import { checksFixture, code } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const plans = await import(moduleUrl('../convex/projectHostedActionsPlan.ts'));
const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));

// A pnpm workspace with its own CI script: nothing about Forge's layout.
const pnpmRepo = () =>
  new Map([
    ['package.json', JSON.stringify({ name: 'synthetic', packageManager: 'pnpm@9.12.0' })],
    ['pnpm-lock.yaml', 'lockfileVersion: 9.0\n'],
    ['pnpm-workspace.yaml', 'packages:\n  - packages/*\n'],
    ['packages/app/src/index.ts', 'export const app = 1;\n'],
    ['packages/app/test/index.test.ts', "import { app } from '../src/index';\n"],
    ['tests/contract.test.ts', "import 'vitest';\n"],
    ['ci/check.sh', 'pnpm install --frozen-lockfile && pnpm -r test\n'],
  ]);
const pnpmCheck = selection => ({
  name: 'ci',
  executable: 'bash',
  args: ['ci/check.sh'],
  environmentLabel: 'clean',
  ...(selection ? { selection } : {}),
});
const base = 'a'.repeat(64),
  head = 'b'.repeat(64);
const run = (check, gate) => ({
  check,
  ...(gate ? { gate } : {}),
  candidate: { base: { head: base } },
  request: { expectedHead: head },
});
const contract = {
  mode: 'contract',
  tests: ['tests/contract.test.ts'],
  contractVersion: 1,
  reason: 'Synthetic',
};
const changed = ['packages/app/src/index.ts'];

test('an undeclared command keeps one full job and still receives the changed-paths file', () => {
  for (const gate of [undefined, contract, { mode: 'audit' }]) {
    const selected = actionsGateSelection(run(pnpmCheck(), gate), changed, pnpmRepo(), false);
    assert.equal(selected.scope, 'full');
    assert.equal(selected.reason, 'Exact configured command');
    assert.deepEqual(selected.changes, {
      version: 1,
      comparison: 'main',
      base,
      head,
      paths: changed,
      mode: 'full',
    });
  }
  assert.equal(commandShardCount(pnpmCheck(), { callsPerJob: 4 }), 0);
});

test('a declared command scopes only under a reduced-evidence gate and gets the gate tests', () => {
  const declared = pnpmCheck({ scope: 'changed-paths' });
  const scoped = actionsGateSelection(run(declared, contract), changed, pnpmRepo(), false);
  assert.equal(scoped.scope, 'scoped');
  assert.deepEqual(scoped.tests, ['tests/contract.test.ts']);
  assert.equal(scoped.changes.mode, 'scoped');
  assert.deepEqual(scoped.changes.tests, ['tests/contract.test.ts']);
  // No gate, a full gate or the main audit: the command must run everything.
  for (const gate of [undefined, { mode: 'full' }, { mode: 'audit' }]) {
    const selected = actionsGateSelection(run(declared, gate), changed, pnpmRepo(), false);
    assert.equal(selected.scope, 'full');
    assert.equal(selected.changes.mode, 'full');
  }
  // A gate test the Candidate lacks never becomes a silent pass.
  assert.throws(
    () =>
      commandSelection(run(declared, { ...contract, tests: ['tests/missing.test.ts'] }), changed, pnpmRepo()),
    code('EVIDENCE_CHANGED'),
  );
  // Too many paths for the plan: full, without a partial list.
  const many = Array.from({ length: Math.ceil(commandChangesBytes / 20) }, (_, i) => `packages/p${i}/x.ts`);
  const big = commandSelection(run(declared, contract), many, pnpmRepo());
  assert.equal(big.scope, 'full');
  assert.equal(big.changes.paths, undefined);
});

test('a declared scoped recheck hands the command both sides; no checked base runs full', () => {
  const recheck = { mode: 'scoped', reason: `scoped-recheck:${'c'.repeat(64)}` };
  const declared = pnpmCheck({ scope: 'changed-paths' });
  const selected = actionsGateSelection(run(declared, recheck), changed, pnpmRepo(), false, [
    'packages/lib/src/b.ts',
  ]);
  assert.equal(selected.scope, 'scoped');
  assert.deepEqual(selected.changes.mainPaths, ['packages/lib/src/b.ts']);
  assert.equal(actionsGateSelection(run(declared, recheck), changed, pnpmRepo(), false).scope, 'full');
});

test('declared shards stay within the job and Convex call budget', () => {
  const sharded = pnpmCheck({ shards: 20 });
  assert.equal(commandShardCount(sharded, { callsPerJob: 4 }), 11); // concurrency budget 12, minus static
  assert.equal(commandShardCount(sharded, { callsPerJob: 6 }), 7); // 48 calls / 6, minus static
  assert.equal(commandShardCount(sharded, { callsPerJob: 4, jobCap: 5 }), 3);
  assert.equal(commandShardCount(pnpmCheck({ shards: 2 }), { callsPerJob: 4, jobCap: 3 }), 0);
  assert.deepEqual(commandShardGroups(2), [['forge-command-shard:1/2'], ['forge-command-shard:2/2']]);
  // The definition digest changes only for a check that declares it.
  const checkId = '00000000-0000-4000-8000-000000000001';
  const plain = hostedCheckDefinition(pnpmCheck(), checkId, 'at');
  assert.equal(plain.selection, undefined);
  assert.notEqual(
    hostedCheckDefinition(pnpmCheck({ shards: 3 }), checkId, 'at').definition,
    plain.definition,
  );
  assert.throws(() => hostedCheckDefinition(pnpmCheck({}), checkId, 'at'));
});

function repository(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'forge-command-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of files) if (!path.includes('/')) writeFileSync(join(root, path), text);
  const previous = {
    cwd: process.cwd(),
    plan: process.env.FORGE_ACTIONS_PLAN,
    shard: process.env.FORGE_ACTIONS_SHARD,
  };
  t.after(() => {
    process.chdir(previous.cwd);
    for (const [key, value] of [
      ['FORGE_ACTIONS_PLAN', previous.plan],
      ['FORGE_ACTIONS_SHARD', previous.shard],
    ])
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  process.chdir(root);
  return root;
}
/** Runs the executor as an Actions job would, with a command that records what it was given. */
function execute(root, plan, shard, report) {
  writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
  process.env.FORGE_ACTIONS_PLAN = join(root, 'plan.json');
  process.env.FORGE_ACTIONS_SHARD = shard;
  const seen = [];
  runActionsCheck((command, args, { env }) => {
    const changes = env.FORGE_CHECK_CHANGES
      ? JSON.parse(readFileSync(env.FORGE_CHECK_CHANGES, 'utf8'))
      : null;
    seen.push({ command: [command, ...args], env: { ...env }, changes });
    if (report) writeFileSync(env.FORGE_CHECK_SELECTION, JSON.stringify(report));
  });
  return seen;
}

test('pnpm-style repository: the executor gives the custom command its file, scope and shard part', t => {
  const files = pnpmRepo();
  const root = repository(t, files);
  const declared = pnpmCheck({ scope: 'changed-paths', shards: 3 });
  const selected = actionsGateSelection(run(declared, contract), changed, files, false);
  const groups = commandShardGroups(commandShardCount(declared, { callsPerJob: 4 }));
  const plan = { standard: false, command: ['bash', 'ci/check.sh'], groups, selection: selected };
  const [shard] = execute(root, plan, '1');
  // No npm install for a pnpm lockfile; the project's command owns its setup.
  assert.deepEqual(shard.command, ['bash', 'ci/check.sh']);
  assert.deepEqual(shard.changes, selected.changes);
  assert.equal(shard.env.FORGE_CHECK_SCOPED, '1');
  assert.equal(shard.env.FORGE_CHECK_FULL, undefined);
  assert.equal(shard.env.FORGE_CHECK_BASE, base);
  assert.equal(shard.env.FORGE_CHECK_HEAD, head);
  assert.equal(shard.env.FORGE_CHECK_PART, 'tests');
  assert.equal(shard.env.FORGE_CHECK_SHARD, '2/3');
  assert.equal(shard.env.FORGE_CHECK_SHARD_INDEX, '2');
  assert.equal(shard.env.FORGE_CHECK_SHARD_TOTAL, '3');
  // The file lives outside the Candidate and is removed after the command.
  assert(!shard.env.FORGE_CHECK_CHANGES.startsWith(root));
  assert.equal(existsSync(shard.env.FORGE_CHECK_CHANGES), false);
  const [fixed] = execute(root, plan, 'static');
  assert.equal(fixed.env.FORGE_CHECK_PART, 'static');
  assert.equal(fixed.env.FORGE_CHECK_SHARD, undefined);
  assert.throws(() => execute(root, plan, '3'), /Unselected command shard/);
  // Without declared shards there is one whole-command job and no part variables.
  const [whole] = execute(root, { ...plan, groups: [] }, 'static');
  assert.equal(whole.env.FORGE_CHECK_PART, undefined);
  assert.throws(() => execute(root, { ...plan, groups: [] }, '0'), /Unselected command shard/);
  // A plan from an older planner has no changes file and still runs the command.
  const [legacy] = execute(root, { ...plan, groups: [], selection: { scope: 'full', tests: [] } }, 'static');
  assert.equal(legacy.env.FORGE_CHECK_CHANGES, undefined);
  // Hand-written plans with no groups or selection still run the one whole-command job.
  const [bare] = execute(root, { standard: false, command: ['bash', 'ci/check.sh'] }, 'static');
  assert.equal(bare.env.FORGE_CHECK_PART, undefined);
});

test('a command asked for a full run that reports a reduced scope fails', t => {
  const files = pnpmRepo();
  const root = repository(t, files);
  const declared = pnpmCheck({ scope: 'changed-paths' });
  const full = actionsGateSelection(run(declared, { mode: 'audit' }), changed, files, false);
  const plan = { standard: false, command: ['bash', 'ci/check.sh'], groups: [], selection: full };
  assert.throws(() => execute(root, plan, 'static', { scope: 'scoped' }), /SCOPE_MISMATCH/);
  const [ok] = execute(root, plan, 'static', { scope: 'full' });
  assert.equal(ok.env.FORGE_CHECK_FULL, '1');
  // A scoped run may report anything: it is scoped evidence either way.
  const scoped = actionsGateSelection(run(declared, contract), changed, files, false);
  execute(root, { ...plan, selection: scoped }, 'static', { scope: 'scoped' });
});

async function server(t, check, gate) {
  const previous = process.env.CONVEX_SITE_URL;
  process.env.CONVEX_SITE_URL = 'https://fixture.invalid';
  t.after(() =>
    previous === undefined ? delete process.env.CONVEX_SITE_URL : (process.env.CONVEX_SITE_URL = previous),
  );
  const f = await checksFixture(),
    storage = new Map();
  f.decorateContext(ctx => {
    ctx.storage = { getMetadata: async id => storage.get(id) };
    ctx.scheduler = { runAfter: async () => 'synthetic-task', cancel: async () => {} };
  });
  const repo = 'synthetic/pnpm';
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
  if (gate) {
    const row = [...f.tables.projectHostedCheckRuns.values()][0];
    f.patch('projectHostedCheckRuns', row._id, { gate, value: JSON.stringify({ ...queued, gate }) });
  }
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
    repository_visibility: 'private',
  };
  const planFor = (paths, mainPaths) =>
    actionsGateSelection(
      { ...queued, check: { ...queued.check }, gate },
      paths,
      pnpmRepo(),
      false,
      mainPaths,
    );
  return {
    queued,
    planFor,
    tables: f.tables,
    prepare: async (selection, groups = []) => {
      const pins = {
        head: queued.request.expectedHead,
        definition: queued.check.definition,
        selection,
        groups,
        standard: false,
        interaction: false,
        command: [check.executable, ...check.args],
      };
      const recipe = hostedActionsRecipeSchema.parse({ ...pins, pin: checkPin(pins) });
      storage.set('selection', savePin(selection));
      storage.set('recipe', savePin(recipe));
      return JSON.parse(
        await f.call('commandPlan', plans.prepare, {
          ...id,
          claims: JSON.stringify(claims),
          recipe: JSON.stringify(recipe),
          lockfile: 'e'.repeat(64),
          selectionStorage: 'selection',
          recipeStorage: 'recipe',
        }),
      );
    },
  };
}
const echo = (selected, gate) => ({
  ...selected,
  gate: { ...gate, effective: selected.scope === 'full' ? 'full' : 'contract' },
});

test('pnpm-style repository: the server counts a declared scoped pass as contract evidence, never full', async t => {
  const declared = pnpmCheck({ scope: 'changed-paths', shards: 3 });
  const s = await server(t, declared, contract);
  const selected = s.planFor(changed);
  assert.equal(selected.scope, 'scoped');
  const run = await s.prepare(echo(selected, contract), commandShardGroups(3));
  assert.equal(run.gate.effective, 'contract');
  assert.equal(run.plan.shardCount, 4);
  assert.equal([...s.tables.projectHostedCheckRuns.values()][0].gate.effective, 'contract');
});

test('the server refuses command plans the check did not declare', async t => {
  const s = await server(t, pnpmCheck(), contract);
  const selected = s.planFor(changed);
  assert.equal(selected.scope, 'full');
  // An undeclared command cannot claim a scoped pass or shard jobs.
  for (const [selection, groups] of [
    [echo({ ...selected, scope: 'scoped', changes: { ...selected.changes, mode: 'scoped' } }, contract), []],
    [echo(selected, contract), commandShardGroups(2)],
  ])
    await assert.rejects(s.prepare(selection, groups), code('EVIDENCE_CHANGED'));
  const run = await s.prepare(echo(selected, contract));
  assert.equal(run.gate.effective, 'full');
});

test('the server refuses shard counts, gate tests and changes pins that differ from the declaration', async t => {
  const declared = pnpmCheck({ scope: 'changed-paths', shards: 2 });
  const s = await server(t, declared, contract);
  const selected = s.planFor(changed);
  for (const [selection, groups] of [
    [echo(selected, contract), commandShardGroups(3)],
    [echo(selected, contract), [['tests/contract.test.ts'], ['forge-command-shard:2/2']]],
    [echo({ ...selected, tests: [] }, contract), []],
    [echo({ ...selected, changes: { ...selected.changes, head: 'f'.repeat(64) } }, contract), []],
    [echo({ ...selected, changes: { ...selected.changes, mode: 'full' } }, contract), []],
  ])
    await assert.rejects(s.prepare(selection, groups), code('EVIDENCE_CHANGED'));
  assert.equal((await s.prepare(echo(selected, contract), commandShardGroups(2))).gate.effective, 'contract');
});

test('a full or audit gate keeps a declared command full on the server', async t => {
  const declared = pnpmCheck({ scope: 'changed-paths' });
  const s = await server(t, declared, { mode: 'audit' });
  const selected = s.planFor(changed);
  assert.equal(selected.scope, 'full');
  await assert.rejects(
    s.prepare(
      echo(
        { ...selected, scope: 'scoped', changes: { ...selected.changes, mode: 'scoped' } },
        { mode: 'audit' },
      ),
    ),
    code('EVIDENCE_CHANGED'),
  );
  assert.equal((await s.prepare(echo(selected, { mode: 'audit' }))).gate.effective, 'full');
});
