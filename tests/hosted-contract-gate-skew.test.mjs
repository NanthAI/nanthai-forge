// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { actionsGateSelection } from '../dist/hosted-actions-job-plan.js';
import { hostedActionsRecipeSchema, hostedActionsRuntime } from '../dist/hosted-actions.js';
import { checkPin } from '../dist/hosted-check.js';
import { savePin } from '../dist/hosted-save.js';
import { standardSelection } from '../scripts/test-impact.mjs';
import { directSourceWindow } from '../dist/hosted-actions-direct.js';
import { checksFixture, code } from './hosted-checks-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const plans = await import(moduleUrl('../convex/projectHostedActionsPlan.ts'));
const direct = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));
const leaf = 'tests/leaf.test.mjs',
  extra = 'tests/extra.test.mjs',
  changed = 'tests/changed.test.mjs';
const files = () =>
  new Map([
    ['src/leaf.ts', 'export const leaf = 1;'],
    [leaf, "import '../dist/leaf.js';"],
    [extra, "import 'node:assert';"],
    [changed, "import 'node:test';"],
  ]);
const contract = { mode: 'contract', tests: [leaf], contractVersion: 1, reason: 'Synthetic contract' };
test('all four server/runner skew pairs remain full unless both support a contract gate', () => {
  for (const server of [false, true])
    for (const runner of [false, true]) {
      const run = { ...(server && runner ? { gate: contract } : {}) };
      const selected = actionsGateSelection(run, ['src/leaf.ts'], files(), true);
      assert.equal(selected.scope, server && runner ? 'scoped' : 'full');
      const selection = {
        ...selected,
        ...(server && runner ? { gate: { ...contract, effective: 'contract' } } : {}),
      };
      assert.equal(Object.hasOwn(selection, 'gate'), server && runner);
    }
});
test('contract selection includes changed tests and semantic union; infrastructure escalates; audit/full stay full', () => {
  const primaryIntentId = crypto.randomUUID();
  const semanticPlan = {
    primaryIntentId,
    members: [
      { intentId: primaryIntentId, outcome: 'Primary', version: 1, tests: [{ path: leaf, durationMs: 1 }] },
      { intentId: crypto.randomUUID(), outcome: 'Peer', version: 1, tests: [{ path: extra, durationMs: 1 }] },
    ],
  };
  const selected = actionsGateSelection(
    { gate: contract, semanticPlan },
    ['src/leaf.ts', changed],
    files(),
    true,
  );
  assert.deepEqual(selected.tests, [changed, extra, leaf].sort());
  for (const mode of ['contract', 'scoped', 'audit', 'full']) {
    const selected = actionsGateSelection(
      { gate: { ...contract, mode } },
      ['package-lock.json'],
      files(),
      true,
    );
    assert.equal(selected.scope, 'full');
  }
  assert.equal(actionsGateSelection({ gate: { mode: 'audit' } }, ['README.md'], files(), true).scope, 'full');
  for (const mode of ['full', 'contract', 'scoped'])
    assert.equal(
      actionsGateSelection({ gate: { ...contract, mode } }, ['README.md'], files(), true).scope,
      'docs',
    );
  assert.equal(
    actionsGateSelection({ gate: contract, semanticPlan }, ['README.md'], files(), true).scope,
    'scoped',
  );
  assert.equal(
    actionsGateSelection({ gate: { mode: 'full' }, semanticPlan }, ['README.md'], files(), true).scope,
    'full',
  );
  assert.deepEqual(
    actionsGateSelection({ gate: { mode: 'probe', tests: [leaf] } }, ['src/leaf.ts'], files(), true).tests,
    [leaf],
  );
  assert.equal(
    actionsGateSelection({ gate: { mode: 'scoped' } }, ['src/leaf.ts'], files(), true).scope,
    'scoped',
  );
  assert.throws(
    () =>
      actionsGateSelection(
        { gate: { ...contract, tests: ['tests/missing.test.mjs'] } },
        ['src/leaf.ts'],
        files(),
        true,
      ),
    { code: 'EVIDENCE_CHANGED' },
  );
});
async function fixture(t, gate) {
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
  const repository = 'synthetic/project';
  await f.bindRepository(f.projectId, { repository, repoId: 42 });
  const configuration = await f.configure(
    {
      kind: 'runner',
      configuration: {
        provider: 'github-actions',
        repository,
        runsOn: 'ubuntu-latest',
        runtime: hostedActionsRuntime,
        environmentFingerprint: f.runner.environmentFingerprint,
      },
    },
    f.configuration.digest,
  );
  const run = await f.enqueue(f.selection({ expectedConfiguration: configuration.digest }));
  if (gate) {
    const row = [...f.tables.projectHostedCheckRuns.values()][0];
    f.patch('projectHostedCheckRuns', row._id, { gate, value: JSON.stringify({ ...run, gate }) });
  }
  const id = { projectId: f.projectId, runId: run.id };
  const reserved = await f.call('reserve', direct.reserve, id);
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
    repository,
    workflow_ref: `${repository}/.github/workflows/forge-check.yml@refs/heads/main`,
    workflow_sha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    event_name: 'workflow_dispatch',
    run_id: '123',
    run_attempt: '1',
    runner_environment: 'github-hosted',
  };
  return {
    ...f,
    run,
    prepare: async selection => {
      const pins = {
        head: run.request.expectedHead,
        definition: run.check.definition,
        selection,
        groups: selection.tests.length ? [selection.tests] : [],
        standard: true,
        interaction: false,
        command: ['node', 'scripts/forge-check.mjs'],
      };
      const recipe = hostedActionsRecipeSchema.parse({ ...pins, pin: checkPin(pins) });
      storage.set('selection', savePin(selection));
      storage.set('recipe', savePin(recipe));
      return f.call('gatePlan', plans.prepare, {
        ...id,
        claims: JSON.stringify(claims),
        recipe: JSON.stringify(recipe),
        lockfile: 'e'.repeat(64),
        selectionStorage: 'selection',
        recipeStorage: 'recipe',
      });
    },
  };
}
test('old runner/new server: real plan validator accepts full echo omission and marks effective full', async t => {
  const f = await fixture(t, contract);
  const run = await f.prepare({ scope: 'full', reason: 'Old runner', tests: [leaf] });
  assert.equal(run.gate.effective, 'full');
  assert.equal([...f.tables.projectHostedCheckRuns.values()][0].gate.effective, 'full');
});
test('new runner/old server: legacy plan contains no gate fields and remains valid', async t => {
  const f = await fixture(t);
  const run = await f.prepare({ scope: 'full', reason: 'No gate supplied by server', tests: [leaf] });
  assert.equal(run.gate, undefined);
});
test('new server validates exact gate echo, required tests and full/audit escalation', async t => {
  const f = await fixture(t, contract);
  for (const selection of [
    { scope: 'scoped', reason: 'Missing coverage without echo', tests: [] },
    { scope: 'scoped', reason: 'Missing tests', tests: [], gate: { ...contract, effective: 'contract' } },
    {
      scope: 'scoped',
      reason: 'Forged version',
      tests: [leaf],
      gate: { ...contract, contractVersion: 2, effective: 'contract' },
    },
  ])
    await assert.rejects(f.prepare(selection), code('EVIDENCE_CHANGED'));
  const run = await f.prepare({
    scope: 'scoped',
    reason: 'Contract',
    tests: [leaf],
    gate: { ...contract, effective: 'contract' },
  });
  assert.equal(run.gate.effective, 'contract');
  assert.equal([...f.tables.projectHostedCheckRuns.values()][0].gate.effective, 'contract');
});

test('3k-file contract selection and complete metadata run stay below 60 function calls', async t => {
  const previous = process.env.FORGE_HOSTED_CHECK_KEY_SYNTHETIC;
  process.env.FORGE_HOSTED_CHECK_KEY_SYNTHETIC = 'synthetic-check-key';
  t.after(() =>
    previous === undefined
      ? delete process.env.FORGE_HOSTED_CHECK_KEY_SYNTHETIC
      : (process.env.FORGE_HOSTED_CHECK_KEY_SYNTHETIC = previous),
  );
  const f = await fixture(t, contract),
    inventory = files();
  for (let i = inventory.size; i < 3000; i++)
    inventory.set(`src/synthetic-${i}.ts`, `export const value = ${i};`);
  const start = performance.now();
  const selected = actionsGateSelection({ gate: contract }, ['src/leaf.ts'], inventory, true);
  assert.equal(inventory.size, 3000);
  assert.deepEqual(selected.tests, [leaf]);
  const run = await f.prepare({ ...selected, gate: { ...contract, effective: 'contract' } });
  // Exercise the complete signed shard/terminal path with the same strict fixture.
  const callbacks = await import(moduleUrl('../convex/projectHostedActionsResults.ts'));
  const claims = {
    iss: 'https://token.actions.githubusercontent.com',
    aud: process.env.CONVEX_SITE_URL,
    exp: Date.now() / 1000 + 300,
    nbf: Date.now() / 1000 - 30,
    iat: Date.now() / 1000 - 30,
    repository: 'synthetic/project',
    workflow_ref: 'synthetic/project/.github/workflows/forge-check.yml@refs/heads/main',
    workflow_sha: 'a'.repeat(40),
    ref: 'refs/heads/main',
    event_name: 'workflow_dispatch',
    run_id: '123',
    run_attempt: '1',
    runner_environment: 'github-hosted',
  };
  let terminal;
  for (let index = 0; index < run.plan.shardCount; index++)
    terminal = await f.call('gateResult', callbacks.result, {
      projectId: f.projectId,
      runId: run.id,
      claims: JSON.stringify(claims),
      result: JSON.stringify({
        index,
        exitCode: 0,
        ...(index === 0 ? { contractReports: { [leaf]: { durationMs: 12, failed: false } } } : {}),
      }),
    });
  assert.equal(terminal.status, 'passed');
  assert(f.traffic.acceptedCalls <= 60);
  // Existing direct-run accounting: HTTP + source transaction per window,
  // output/result callbacks per job, and the fixed dispatch/session/plan budget.
  // Include the manifest window rather than pretending it is a source-file page.
  const estimatedWholeRunCalls =
    2 * (1 + Math.ceil(inventory.size / directSourceWindow)) + run.plan.shardCount * 5 + 17;
  assert.equal(run.plan.shardCount, 2);
  assert(estimatedWholeRunCalls <= 60);
  t.diagnostic(
    JSON.stringify({
      metadataFunctionCalls: f.traffic.acceptedCalls,
      estimatedWholeRunCalls,
      sourceMaterializationCalls: 'not measured by this metadata fixture',
      wallMs: performance.now() - start,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
});

test('checked docs satisfy full and contract gates and persist their effective scope', async t => {
  for (const mode of ['full', 'contract'])
    await t.test(mode, async t => {
      const declared = mode === 'full' ? { mode, reason: 'Full policy' } : contract;
      const f = await fixture(t, declared);
      const run = await f.prepare({
        scope: 'docs',
        reason: 'Only Markdown documentation changed',
        tests: [],
        gate: { ...declared, effective: 'docs' },
      });
      assert.equal(run.gate.effective, 'docs');
      assert.equal(run.plan.shardCount, 1);
      assert.equal([...f.tables.projectHostedCheckRuns.values()][0].gate.effective, 'docs');
    });
});

test('legacy scoped plans with complete declared coverage remain valid without a gate echo', async t => {
  const f = await fixture(t, contract);
  const run = await f.prepare({ scope: 'scoped', reason: 'Legacy covered selection', tests: [leaf] });
  assert.equal(run.gate.effective, 'contract');
});

test('full and audit declarations cannot be downgraded to contract evidence by a plan', async t => {
  for (const mode of ['full', 'audit'])
    await t.test(mode, async t => {
      const declaration = { mode, reason: 'Full verification required' };
      const f = await fixture(t, declaration);
      await assert.rejects(
        f.prepare({
          scope: 'scoped',
          reason: 'Reduced',
          tests: [leaf],
          gate: { ...declaration, effective: 'contract' },
        }),
        code('EVIDENCE_CHANGED'),
      );
      await assert.rejects(
        f.prepare({ scope: 'scoped', reason: 'Legacy reduced', tests: [leaf] }),
        code('EVIDENCE_CHANGED'),
      );
      assert.equal(
        (
          await f.prepare({
            scope: 'full',
            reason: 'Full',
            tests: [leaf],
            gate: { ...declaration, effective: 'full' },
          })
        ).gate.effective,
        'full',
      );
    });
});

test('legacy docs-plus-union selection remains docs evidence for a full gate', async t => {
  const f = await fixture(t, { mode: 'full' });
  const row = [...f.tables.projectHostedCheckRuns.values()][0],
    run = JSON.parse(row.value);
  const primaryIntentId = f.candidate.intentId;
  run.semanticPlan = {
    primaryIntentId,
    members: [
      { intentId: primaryIntentId, outcome: 'Primary', version: 1, tests: [{ path: leaf, durationMs: 1 }] },
      { intentId: crypto.randomUUID(), outcome: 'Peer', version: 1, tests: [{ path: extra, durationMs: 1 }] },
    ],
  };
  f.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify(run) });
  const selected = standardSelection({
    paths: ['README.md'],
    files: files(),
    semanticTests: [leaf, extra],
    env: {},
  });
  assert.equal(selected.scope, 'scoped');
  await assert.rejects(
    f.prepare({ scope: 'scoped', reason: 'Unproven scoped code selection', tests: selected.tests }),
    code('EVIDENCE_CHANGED'),
  );
  await assert.rejects(
    f.prepare({ scope: selected.scope, reason: selected.reason, tests: [...selected.tests, changed] }),
    code('EVIDENCE_CHANGED'),
  );
  const prepared = await f.prepare({ scope: selected.scope, reason: selected.reason, tests: selected.tests });
  assert.equal(prepared.gate.effective, 'docs');
});
