// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativeOwner } from '../dist/native-source.js';
import { prepareActionsDrillFiles } from './phase5-hosted-actions-fixture.mjs';
import { setupActionsDrill } from './phase5-hosted-actions-setup.mjs';
import {
  finalizeActionsDrill,
  cleanupActionsDrill,
  recoverActionsDrillCache,
} from './phase5-hosted-actions-recovery.mjs';
import {
  createActionsDrillContext,
  readJson,
  writeJson,
  virtualClientInterruption,
  saveActionsDrillLane,
} from './phase5-hosted-actions-context.mjs';

export { saveActionsDrillLane } from './phase5-hosted-actions-context.mjs';

const modulePath = fileURLToPath(import.meta.url);
export async function freshActionsClient(context, label, request) {
  const path = join(context.directory, `${label}-request.json`);
  const reply = `${label}-reply.json`;
  writeJson(path, { ...request, reply });
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, 'phase5-hosted-actions-client.mjs'), context.directory, path],
    {
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const result = readJson(join(context.directory, reply));
  assert.equal(code, 0, result.error?.code);
  assert.notEqual(result.pid, process.pid);
  return result.result;
}
const finishPayload = (root, operationId) => {
  const journal = readJson(join(`${root}.forge-client`, 'agent', `${operationId}.json`));
  if (journal.values['desired-landing'])
    return {
      endpoint: 'projectHostedLandingDesired:submit',
      payload: journal.values['desired-landing'],
    };
  assert(journal.values['finish-request'], 'retain the original public finish payload');
  return { endpoint: 'projectHostedLanding:enqueue', payload: journal.values['finish-request'] };
};
const landed = value => ['landed', 'terminal-failed'].includes(value.submission.phase);
export const runPins = run => ({
  id: run.id,
  executionId: run.executionId,
  request: run.request,
  planDigest: run.planDigest,
  terminalDigest: run.terminalDigest,
  status: run.status,
  endedAt: run.endedAt,
  counts: run.counts,
});
export async function prepareActionsDrill(context) {
  const { report, directory, step, agent, waitSelected, save } = context;
  assert(!report.prepared, 'prepare is a one-time phase; retain the report');
  const firstRoot = join(directory, 'first-mac');
  const started = await step('start scratch hosted Lane', () =>
    agent(firstRoot).dispatch('start', {
      operationId: randomUUID(),
      outcome: 'Q4 restart during finish',
    }),
  );
  const laneId = started.result.lane.laneId;
  await agent(firstRoot).dispatch('open', { operationId: randomUUID(), laneId });
  writeFileSync(join(firstRoot, 'q4.txt'), 'Q4 saved before Mac offline\n');
  prepareActionsDrillFiles(firstRoot);
  const saved = await step('save scratch hosted Lane', () =>
    agent(firstRoot).dispatch('save', {
      operationId: randomUUID(),
      laneId,
      message: 'Q4 saved source',
    }),
  );
  await waitSelected(
    'projectHostedSaves:progress',
    { operationId: saved.operationId },
    value => !!value.terminal,
  );
  renameSync(firstRoot, join(directory, 'offline-first-mac'));
  const secondRoot = join(directory, 'replacement-mac');
  await step('offline first root; byte-exact resume from another root', async () => {
    await agent(secondRoot).dispatch('open', { operationId: randomUUID(), laneId });
    assert.equal(readFileSync(join(secondRoot, 'q4.txt'), 'utf8'), 'Q4 saved before Mac offline\n');
    assert.equal(nativeOwner(secondRoot), null);
  });
  report.prepared = { laneId, root: secondRoot };
  save();
}
export async function configureActionsDrill(context) {
  const { report, step, agent, directory, query, mutation, save } = context;
  const root = join(directory, 'configuration-client');
  const binding = await query('githubBindingStore:list', { cursor: null });
  assert(
    binding.page.some(row => row.repoId === 1439239054),
    'owner must finish the existing GitHub connection',
  );
  report.ownerBinding = binding;
  report.initialRunner = await query('projectHostedCheckDefinitions:current', { checkId: '' });
  assert.equal(report.initialRunner.configuration, null);
  const policy = await query('projectAutonomy:read');
  report.initialPolicy = policy;
  report.scratchPolicyCommand = {
    action: 'set-policy',
    operationId: randomUUID(),
    expectedPolicy: policy,
    acceptance: { mode: 'auto-on-pass', gate: 'full' },
  };
  save();
  report.scratchPolicy = await step('configure scratch-only full-gated agent acceptance', () =>
    mutation('projectAutonomy:set', { command: JSON.stringify(report.scratchPolicyCommand) }),
  );
  assert.equal(report.scratchPolicy.policy.acceptance.mode, 'auto-on-pass');
  assert.equal(report.scratchPolicy.policy.acceptance.gate, 'full');
  assert.deepEqual(report.scratchPolicy.policy.acceptance.protectedPaths, policy.acceptance.protectedPaths);
  const check = await step('configure portable harmless scratch check', () =>
    agent(root).dispatch('configure-check', {
      operationId: randomUUID(),
      command: {
        name: 'verify',
        executable: 'node',
        args: [
          '-e',
          'if(!require("node:fs").readFileSync("q4.txt","utf8").startsWith("Q4 "))process.exit(1)',
        ],
        environmentLabel: 'Q4 scratch GitHub Actions only',
      },
    }),
  );
  await step('configure bound GitHub Actions ubuntu runner', () =>
    agent(root).dispatch('configure-runner', {
      operationId: randomUUID(),
      provider: 'github-actions',
      repository: 'NanthAI/forge-q4-bench',
      runsOn: 'ubuntu-latest',
    }),
  );
  report.checkId = check.result.key;
  report.runner = (await agent(root).dispatch('check-settings', {})).result;
  assert.equal(report.runner.actions.mode, 'app-direct');
  assert.equal(report.runner.actions.ref, 'main');
  assert.equal(report.runner.actions.repository, 'NanthAI/forge-q4-bench');
  save();
}
export async function interruptionCase(context, name, offlineMs) {
  const { report, directory, agent, step, query, waitSelected, save } = context;
  report.cases ??= [];
  assert(!report.cases.some(item => item.name === name));
  let prepared = name === 'restart' ? report.prepared : null;
  if (!prepared) {
    const root = join(directory, `${name}-mac`);
    const started = await agent(root).dispatch('start', { operationId: randomUUID(), outcome: `Q4 ${name}` });
    prepared = { root, laneId: started.result.lane.laneId };
    await agent(root).dispatch('open', { operationId: randomUUID(), laneId: prepared.laneId });
    writeFileSync(join(root, 'q4-case.txt'), `Q4 ${name}\n`);
    await saveActionsDrillLane(context, root, {
      operationId: randomUUID(),
      laneId: prepared.laneId,
      message: `Q4 ${name} saved source`,
    });
  }
  const operationId = randomUUID();
  const entry = { name, operationId, ...prepared };
  report.cases.push(entry);
  save();
  const input = {
    operationId,
    laneId: prepared.laneId,
    message: `Q4 ${name}`,
    accept: true,
    check: { checkId: report.checkId },
  };
  const finished = await step(`${name}: fresh process submits finish and exits`, () =>
    freshActionsClient(context, `${name}-finish`, {
      root: prepared.root,
      action: 'finish',
      input,
    }),
  );
  assert(finished.result.submission, 'finish must durably submit before disconnection');
  assert(!landed({ submission: finished.result.submission }), 'client exited during a pending finish');
  entry.submissionId = finished.result.submission.id;
  entry.replay = finishPayload(prepared.root, operationId);
  save();
  entry.interruption = await virtualClientInterruption(
    offlineMs,
    () => context.entries().length,
    offline => offline(),
  );
  // The requesting process is gone. This independent observer never drives checks.
  await step(`${name}: hosted authority lands while requester is absent`, async () => {
    const terminal = await waitSelected(
      'projectHostedFinishObserve:page',
      { operationId, nextVersion: 0 },
      landed,
    );
    entry.terminal = terminal.submission;
    save();
    assert.equal(entry.terminal.phase, 'landed', entry.terminal.error?.code);
  });
  const selected = await query('projectHostedLanding:status', { submissionId: entry.submissionId });
  const runId = selected.attempt.check.runId;
  const before = await query('projectHostedCheckRead:status', { runId });
  assert.equal(before.status, 'passed');
  assert.equal(before.configuration.provider, 'github-actions');
  assert(before.executionId && before.terminalDigest);
  const priorMain = await query('projectHostedChannels:current');
  const replayed = await step(`${name}: reconnect new process with original finish payload`, () =>
    freshActionsClient(context, `${name}-replay`, {
      root: join(directory, `${name}-reconnected`),
      replay: entry.replay,
    }),
  );
  assert.equal(replayed.id, entry.submissionId);
  assert.equal(replayed.phase, 'landed');
  assert.deepEqual(replayed.acceptance, entry.terminal.acceptance);
  const after = await query('projectHostedCheckRead:status', { runId });
  assert.deepEqual(runPins(after), runPins(before), 'passed run and execution must be unchanged');
  assert.deepEqual(await query('projectHostedChannels:current'), priorMain);
  const runs = await query('projectHostedCheckRead:list', {
    candidateId: before.request.candidateId,
    cursor: null,
  });
  assert(runs.isDone);
  assert.equal(runs.page.length, 1);
  entry.evidence = {
    ...runPins(after),
    candidateId: before.request.candidateId,
    receipt: replayed.acceptance,
    repeatedPassedChecks: 0,
  };
  save();
}
if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  const [phase, directory] = process.argv.slice(2);
  if (phase === 'setup') {
    const report = await setupActionsDrill(directory);
    console.log(
      JSON.stringify({ projectId: report.project.projectId, projectUrl: report.project.projectUrl }),
    );
    process.exit(0);
  }
  const context = createActionsDrillContext(resolve(directory), phase === 'cleanup');
  try {
    if (phase === 'prepare') await prepareActionsDrill(context);
    else if (phase === 'configure') await configureActionsDrill(context);
    else if (phase === 'restart') await interruptionCase(context, phase, 0);
    else if (phase === 'sleep') await interruptionCase(context, phase, 1_800_000);
    else if (phase === 'wifi-loss') await interruptionCase(context, phase, 600_000);
    else if (phase === 'finalize') await finalizeActionsDrill(context);
    else if (phase === 'recover') await recoverActionsDrillCache(context);
    else if (phase === 'cleanup') await cleanupActionsDrill(context);
    else assert.fail('Choose an explicit drill phase');
  } catch (error) {
    context.report.result = 'failed';
    context.report.errorCode = error.data?.code ?? error.code ?? 'DRILL_FAILED';
    context.save();
    console.log(
      JSON.stringify({ phase, code: context.report.errorCode, message: error.message?.slice(0, 350) }),
    );
    process.exitCode = 1;
  }
}
