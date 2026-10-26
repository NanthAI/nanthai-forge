// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { actionsCost, actionsRate, localCost, modalRunCost, runnerMonthCosts } from '../dist/check-cost.js';
import { modalCredentials } from '../dist/modal-credentials.js';
import { modalClient } from '../dist/modal-client.js';
import { editedPolicy, policyPreset } from '../dist/autonomy-policy.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { receiptSchema, createRunReceipt } from '../dist/work-run-receipt.js';
import { modalMonthCost } from '../dist/check-backend.js';
import { initNative } from '../dist/native-work.js';

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-runner-cost-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const job = (id, seconds, patch = {}) => ({
  id,
  status: 'completed',
  started_at: '2026-10-01T12:00:00Z',
  completed_at: new Date(Date.parse('2026-10-01T12:00:00Z') + seconds * 1000).toISOString(),
  ...patch,
});

test('Blacksmith cost uses job timestamps, per-job rounding, CPU multiplier and retained retries', () => {
  const label = 'blacksmith-4vcpu-ubuntu-2404';
  const jobs = [41, 183, 128, 170, 146].map((seconds, index) => job(index + 1, seconds));
  const cost = actionsCost(label, actionsRate(label), [...jobs, jobs[0]]);
  assert.equal(cost.billedMinutes, 14);
  assert.equal(cost.billedSeconds, 840);
  assert.ok(Math.abs(cost.estimatedCostUsd - 0.112) < 1e-12);
  assert.match(cost.basis, /3,000 free 2-vCPU minutes/);
  assert.match(cost.basis, /GitHub API billable minutes can be zero/);
  assert.equal(actionsCost(label, actionsRate(label), [...jobs, job(100, 61)]).billedMinutes, 16);
  assert.equal(actionsRate('blacksmith-2vcpu-ubuntu-2404'), 0.004);
});

test('Actions rates can be overridden by label and missing timing/rates remain unknown', () => {
  assert.equal(actionsRate('ubuntu-latest'), 0.006);
  assert.equal(actionsCost('ubuntu-latest', 0.006, [job(1, 61)]).estimatedCostUsd, 0.012);
  const policy = editedPolicy(policyPreset('trusted'), {
    checks: {
      runner: 'github-actions',
      repo: 'synthetic/runner',
      runsOn: 'custom',
      ratesUsdPerMinute: { custom: 0.003 },
    },
  });
  assert.equal(
    actionsCost('custom', policy.checks.ratesUsdPerMinute.custom, [job(1, 61)]).estimatedCostUsd,
    0.006,
  );
  assert.equal(actionsCost('custom', actionsRate('custom'), [job(1, 61)]).estimatedCostUsd, null);
  for (const patch of [
    { started_at: null },
    { completed_at: 'invalid' },
    { status: 'in_progress' },
    { completed_at: '2020-01-01' },
  ]) {
    assert.equal(actionsCost('ubuntu-latest', 0.006, [job(1, 61, patch)]).billedMinutes, null);
  }
  assert.equal(actionsCost('ubuntu-latest', 0.006, []).estimatedCostUsd, null);
});

test('Modal per-second quantities are deduplicated and legacy estimates retain their basis', () => {
  const usage = {
    executionId: 'synthetic-sandbox',
    seconds: 10,
    cpuCoreSeconds: 20,
    memoryGiBSeconds: 40,
    basis: 'worker-runtime',
  };
  const cost = modalRunCost({
    actual: 'modal',
    requested: 'modal',
    costUsage: [usage, usage],
    estimatedCostUsd: 99,
  });
  assert.equal(cost.billedSeconds, 10);
  assert.equal(cost.estimatedCostUsd, 20 * 0.00003942 + 40 * 0.00000667);
  assert.match(cost.basis, /worker-runtime/);
  const legacy = modalRunCost({ estimatedCostUsd: 2 });
  assert.equal(legacy.billedSeconds, null);
  assert.match(legacy.basis, /Legacy aggregate.*overstate/);
});

test('monthly status separates months/runners, deduplicates executions and counts unknown/legacy inputs', () => {
  const cost = actionsCost('blacksmith-2vcpu-ubuntu-2404', 0.004, [job(1, 61)]);
  const run = (id, month, backend) => ({ id, startedAt: `${month}-01T00:00:00Z`, backend });
  const summary = runnerMonthCosts([
    run('a', '2026-10', { actual: 'github-actions', cost }),
    run('adopt', '2026-10', { actual: 'github-actions', cost }),
    run('local', '2026-09', { actual: 'local', cost: localCost('local') }),
    run('legacy', '2026-10', { actual: 'modal', estimatedCostUsd: 1 }),
    run('unknown', '2026-10', { actual: 'github-actions' }),
  ]);
  const actions = summary.months.find(row => row.label);
  assert.equal(actions.estimatedCostUsd, 0.008);
  assert.equal(actions.recordedRuns, 2);
  assert.equal(actions.billedMinutes, 2);
  assert.equal(summary.months.find(row => row.runner === 'modal').legacyRuns, 1);
  assert.equal(summary.months.find(row => row.runner === 'modal').unknownRuns, 1);
  assert.equal(summary.months.find(row => row.runner === 'local').estimatedCostUsd, 0);
  assert.equal(summary.months.find(row => row.runner === 'github-actions' && !row.label).unknownRuns, 1);
  assert.match(summary.basis, /not billed spend/);
});

test('project references resolve only explicit env/file credentials, reject source paths and redact failures', t => {
  const root = directory(t),
    project = join(root, 'project');
  mkdirSync(project);
  const env = {
    PROJECT_ID: 'synthetic-project-id',
    PROJECT_SECRET: 'synthetic-project-secret',
    MODAL_TOKEN_ID: 'synthetic-owner-id',
    MODAL_TOKEN_SECRET: 'synthetic-owner-secret',
  };
  const reference = { kind: 'env', tokenId: 'PROJECT_ID', tokenSecret: 'PROJECT_SECRET' };
  assert.deepEqual(modalCredentials(project, reference, env), {
    MODAL_TOKEN_ID: env.PROJECT_ID,
    MODAL_TOKEN_SECRET: env.PROJECT_SECRET,
  });
  const secret = join(root, 'secret.json');
  writeFileSync(
    secret,
    JSON.stringify({ tokenId: 'synthetic-file-id', tokenSecret: 'synthetic-file-secret' }),
  );
  assert.equal(modalCredentials(project, { kind: 'file', path: secret }).MODAL_TOKEN_ID, 'synthetic-file-id');
  const internal = join(project, 'source.json');
  writeFileSync(internal, readFileSync(secret));
  const link = join(root, 'symlink.json');
  symlinkSync(internal, link);
  for (const ref of [
    undefined,
    { kind: 'env', tokenId: 'MISSING', tokenSecret: 'MISSING' },
    { kind: 'file', path: internal },
    { kind: 'file', path: link },
    { kind: 'file', path: 'relative.json' },
    { kind: 'file', path: join(root, 'absent.json') },
  ]) {
    assert.throws(
      () => modalCredentials(project, ref, env),
      error => {
        assert.equal(error.code, 'MODAL_CREDENTIALS_REQUIRED');
        assert.match(error.message, /checks.credentialsRef/);
        assert.doesNotMatch(error.message, /synthetic-project-secret|synthetic-owner|secret.json/);
        return true;
      },
    );
  }
  writeFileSync(secret, 'synthetic-private-invalid-json');
  assert.throws(
    () => modalCredentials(project, { kind: 'file', path: secret }),
    error => !error.message.includes('synthetic-private'),
  );
});

test('Modal SDK child receives project tokens, an empty config and no ambient account selectors', async t => {
  const root = directory(t),
    executable = join(root, 'fake-python');
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.FORGE_MODAL_PYTHON = executable;
  process.env.MODAL_TOKEN_ID = 'synthetic-owner';
  process.env.MODAL_TOKEN_SECRET = 'synthetic-owner-secret';
  process.env.MODAL_CONFIG_PATH = join(root, 'owner-config');
  process.env.MODAL_ENVIRONMENT = 'owner-env';
  writeFileSync(
    executable,
    `#!${process.execPath}\nconst fs = require('node:fs');
const ok = process.env.MODAL_TOKEN_ID === 'synthetic-project' && process.env.MODAL_TOKEN_SECRET === 'synthetic-project-secret' && !process.env.MODAL_ENVIRONMENT && fs.readFileSync(process.env.MODAL_CONFIG_PATH, 'utf8') === '';
process.stdout.write(JSON.stringify({kind:'progress',message:ok?'isolated':'incorrect'})+'\\n');`,
    { mode: 0o755 },
  );
  const events = [];
  await modalClient(join(root, 'plan.json'), event => events.push(event), undefined, {
    MODAL_TOKEN_ID: 'synthetic-project',
    MODAL_TOKEN_SECRET: 'synthetic-project-secret',
  });
  assert.deepEqual(events, [{ kind: 'progress', message: 'isolated' }]);
  await assert.rejects(
    modalClient(join(root, 'plan.json'), () => {}),
    { code: 'MODAL_CREDENTIALS_REQUIRED' },
  );
});

test('default local check records cost in durable receipt and status; runner policy edits retry safely', async t => {
  const root = directory(t);
  writeFileSync(join(root, 'source.txt'), 'synthetic source');
  initNative(root);
  const agent = new AgentWorkflow(root);
  assert.equal((await agent.dispatch({ action: 'status' })).result.checkRunner.runner, 'local');
  const lane = (await agent.dispatch({ action: 'start', outcome: 'Synthetic cost fixture' })).result;
  await agent.dispatch({
    action: 'define-check',
    name: 'verify',
    executable: process.execPath,
    args: ['-e', '0'],
  });
  const view = (
    await agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: lane.intentId,
      inputs: [{ laneId: lane.laneId, head: lane.head }],
    })
  ).result;
  const result = (await agent.dispatch({ action: 'run', viewId: view.viewId })).result;
  const run = agent.work.store.load().runs.find(run => run.id === result.operationId);
  assert.equal(run.status, 'passed');
  assert.equal(run.backend.cost.runner, 'local');
  assert.equal(run.backend.cost.billedSeconds, 0);
  assert.equal(run.backend.cost.estimatedCostUsd, 0);
  const receipt = JSON.parse(
    readFileSync(join(agent.work.store.directory, `check-${run.id}`, 'result.json')),
  );
  assert.deepEqual(receipt.backend.cost, run.backend.cost);
  const command = {
    action: 'set-policy',
    operationId: randomUUID(),
    checks: {
      runner: 'github-actions',
      repo: 'synthetic/checks',
      runsOn: 'blacksmith-2vcpu-ubuntu-2404',
      shards: 2,
      ratesUsdPerMinute: { 'blacksmith-2vcpu-ubuntu-2404': 0.004 },
    },
  };
  await agent.dispatch(command);
  await agent.dispatch(command);
  assert.equal(agent.work.store.load().policyChanges.length, 1);
  assert.equal((await agent.dispatch({ action: 'policy' })).result.checks.runner, 'github-actions');
  const status = (await agent.dispatch({ action: 'status', detail: true })).result;
  assert.equal(status.autonomyPolicy.checks.shards, 2);
  assert.equal(status.checkRunner.runner, 'github-actions');
  assert.equal(status.checkCosts.months[0].runner, 'local');
  assert.equal(status.checkCosts.months[0].recordedRuns, 1);
});

test('legacy receipt reads remain unchanged and Modal compatibility summaries exclude Actions estimates', () => {
  const original = {
    status: 'passed',
    backend: { requested: 'modal', actual: 'modal', estimatedCostUsd: 1 },
    endedAt: '2026-10-01T00:00:00Z',
    details: 'Legacy synthetic receipt',
  };
  assert.deepEqual(receiptSchema.parse(original), original);
  assert.equal(createRunReceipt(original).backend.cost.estimatedCostUsd, null);
  const summary = modalMonthCost(
    [
      { startedAt: '2026-10-01', backend: { actual: 'github-actions', estimatedCostUsd: 999 } },
      { startedAt: '2026-10-01', backend: { actual: 'modal', estimatedCostUsd: 1 } },
    ],
    new Date('2026-10-20T00:00:00Z'),
  );
  assert.equal(summary.estimatedCostUsd, 1);
  assert.equal(summary.recordedRuns, 1);
});

test('monthly history completes an adopted job observation without double counting it or deducting allowance', () => {
  const early = actionsCost('blacksmith-4vcpu-ubuntu-2404', 0.008, [
    job(73, 61, { status: 'in_progress', completed_at: null }),
  ]);
  const complete = actionsCost('blacksmith-4vcpu-ubuntu-2404', 0.008, [job(73, 61)]);
  const summary = runnerMonthCosts(
    [early, complete].map((cost, index) => ({
      id: `run-${index}`,
      startedAt: '2026-10-01',
      backend: { actual: 'github-actions', cost },
    })),
  );
  assert.equal(summary.months[0].estimatedCostUsd, 0.016);
  assert.equal(summary.months[0].billedMinutes, 2);
  assert.equal(summary.months[0].unknownRuns, 1);
  assert.equal(summary.months[0].netEstimatedCostUsd, null);
});
