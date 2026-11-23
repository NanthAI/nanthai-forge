#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgeArm } from './forge-arm.mjs';
import { scriptedForge, dryGroup } from './scripted.mjs';
import { convexMeter } from './meter.mjs';
import { projectCheckRuns, jobMetrics } from './github-arm.mjs';
import { MICRO, compareMicro, microWaves, publicMicroResult } from './micro-report.mjs';
import { prepareMicro, microPins } from './micro-setup.mjs';
import { benchRoot } from './bench-root.mjs';
import { taskIdentity, withTaskIdentity } from './task-identity.mjs';
const exec = promisify(execFile);
const sourceRoot = dirname(dirname(import.meta.dirname));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export async function runMicro({ root, config, sha, baseline }) {
  const cfg = await prepareMicro(root, config, sourceRoot, sha);
  const before = await microPins(sha);
  const ws = join(root, 'ws'),
    evidence = join(root, 'evidence'),
    bin = join(root, 'bin');
  mkdirSync(evidence, { recursive: true });
  const arm = forgeArm(cfg.forge, {
    ws,
    cellDir: root,
    callLog: join(evidence, 'calls.jsonl'),
    ledger: join(evidence, 'lanes.jsonl'),
  });
  const anchor = join(ws, '.anchor');
  mkdirSync(anchor, { recursive: true });
  const address = { url: cfg.forge.url, projectId: cfg.forge.projectId };
  const settings = (await arm.nf(anchor, 'check-settings', address)).result;
  if (
    settings?.actions?.repository !== 'NanthAI/nanthai-forge' ||
    settings?.actions?.runsOn !== 'ubuntu-latest' ||
    settings?.agentLandsOnPass !== true
  )
    throw Error(
      'Bench requires its existing free Actions runner and trusted checked acceptance; setup does not change policy',
    );
  const open = (await arm.nf(anchor, 'lanes', { ...address, limit: 1 })).result;
  if (!Array.isArray(open?.page) || open.page.length || !open.isDone)
    throw Error('Bench has open work; retain it and settle it before reset');
  const verify = settings.definitions?.find(d => d.name === 'verify');
  const { benchCheckDigest } = await import('./env.mjs');
  if (verify?.definition !== benchCheckDigest())
    throw Error('Bench check differs from the qualified B1.5d check');
  const alertPolicy = (
    await arm.nf(anchor, 'policy', { ...address, projectId: cfg.alerts?.projectId ?? cfg.forge.projectId })
  ).result;
  if (!alertPolicy?.agentDefaults?.stallAlerts)
    throw Error('Existing project stallAlerts settings unavailable');
  const meter = convexMeter({
    deployment: cfg.forge.deployment,
    projectId: cfg.forge.projectId,
    name: cfg.forge.projectName,
    cwd: sourceRoot,
  });
  const startedAt = new Date().toISOString();
  const result = {
    schema: 1,
    startedAt,
    tasks: [],
    pins: before,
    pinsStable: false,
    scenario: {
      fixtureCommit: cfg.fixture.commit,
      checkDefinition: verify.definition,
      runner: settings.actions.runsOn,
    },
  };
  try {
    await meter.ready(() => arm.nf(anchor, 'capabilities', address));
    result.reset = await arm.reset({
      meta: cfg.meta,
      baseCommit: cfg.fixture.commit,
      root: join(ws, 'reset'),
    });
    await arm.binDir(bin);
    const script = scriptedForge(bin);
    const taskStart = new Date().toISOString();
    result.tasks = await microWaves(
      async task => {
        const root = join(ws, task.id),
          receipt = join(evidence, `${task.id}.json`);
        const identity = taskIdentity();
        const taskEnv = withTaskIdentity(process.env, identity);
        const laneId = await arm.startLane(root, `rung 2 ${task.id}`, {}, task.id, identity);
        const env = {
          ...taskEnv,
          PATH: bin + delimiter + process.env.PATH,
          ...(await arm.agentEnv(root, task.id, taskEnv)),
          BENCH_SCRIPTED_RESULT: receipt,
        };
        return { ...task, root, receipt, laneId, env };
      },
      async task => {
        const { root, receipt, laneId, env } = task;
        const dispatch = Date.now();
        // No model, repository scripts, local package install or macOS sandbox dependency.
        let output;
        try {
          output = await exec('bash', [script, task.id, dryGroup(task)], {
            cwd: root,
            env,
            maxBuffer: 64 << 20,
          });
        } catch (error) {
          save(join(evidence, `${task.id}-output.json`), {
            stdout: String(error.stdout ?? ''),
            stderr: String(error.stderr ?? ''),
          });
          // An unknown or in-flight landing is retained; never abandon it on an agent error.
          throw Error('Scripted task failed');
        }
        save(join(evidence, `${task.id}-output.json`), output);
        const landed = JSON.parse(readFileSync(receipt, 'utf8'));
        const submission = landed.submission;
        if (submission?.phase !== 'landed' || !submission.acceptance?.receiptId)
          throw Error('No accepted receipt');
        const timeToMainSeconds = (Date.parse(submission.timing?.committedAt) - dispatch) / 1000;
        const closed = await arm.closeTask(root, laneId, { inFlight: [] });
        if (Object.values(closed ?? {}).some(value => value?.error))
          throw Error('Bench Lane cleanup failed; retain evidence and resolve before another run');
        return {
          id: task.id,
          receiptId: submission.acceptance.receiptId,
          timeToMainSeconds,
          dispatchedAt: new Date(dispatch).toISOString(),
          acceptedAt: submission.timing?.committedAt,
        };
      },
    );
    result.wallSeconds = (Date.now() - Date.parse(taskStart)) / 1000;
    const until = new Date().toISOString();
    const checks = await projectCheckRuns('NanthAI/nanthai-forge', cfg.forge.projectId, taskStart, until);
    result.ci = await jobMetrics('NanthAI/nanthai-forge', checks.runs);
    result.checkRunsPerTask = result.ci.runs / MICRO.tasks.length;
    result.afterPins = await microPins(sha);
    result.pinsStable = JSON.stringify(before) === JSON.stringify(result.afterPins);
  } catch {
    result.error = 'Benchmark incomplete; inspect private evidence and setup preconditions';
  } finally {
    // Relay drains CLI children; unknown tasks retain their Lane and journals for recovery.
    arm.stopBroker();
    result.convex = meter.stop();
    result.totalMinutes = (Date.now() - Date.parse(startedAt)) / 60_000;
    result.parentPeakRssBytes = process.resourceUsage().maxRSS * 1024;
    result.memoryCoverage = 'parent harness only; CLI child and hosted worker peaks are not measured';
    result.verdict = compareMicro(result, baseline);
    save(join(root, 'result.json'), result);
  }
  if (!result.verdict.passed) {
    const text = `Rung 2: ${JSON.stringify(result.verdict)} Run ${process.env.GITHUB_RUN_ID ?? 'local'}.`;
    try {
      await exec(
        'npx',
        [
          '--no-install',
          'convex',
          'run',
          '--deployment',
          cfg.forge.deployment,
          'projectHostedLandingStallAlert:deliver',
          JSON.stringify({
            subject: 'Forge rung 2 regression',
            text,
            settings: JSON.stringify(alertPolicy.agentDefaults.stallAlerts),
          }),
        ],
        { cwd: sourceRoot, maxBuffer: 1 << 20 },
      );
      result.alertDelivery = 'requested through existing stallAlerts delivery';
    } catch {
      result.alertDelivery = 'failed; inspect Actions summary and existing channel configuration';
    }
    save(join(root, 'result.json'), result);
  }
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const root = benchRoot();
    const config = JSON.parse(process.env.FORGE_MICRO_SETUP ?? '{}');
    const baseline = JSON.parse(
      readFileSync(process.argv[2] ?? join(import.meta.dirname, 'micro-baseline.json'), 'utf8'),
    );
    const result = await runMicro({ root, config, sha: process.env.GITHUB_SHA, baseline });
    // The public result contains metrics only, never raw source, logs, config or channel routes.
    const publicResult = publicMicroResult(result);
    save(join(root, 'summary.json'), publicResult);
    if (result.verdict.passed) save(join(root, 'baseline.json'), publicResult);
    console.log(
      JSON.stringify({
        verdict: result.verdict,
        minutes: result.totalMinutes,
        convexUsd: result.convex?.costUsd,
        actionsMinutes: result.ci?.billedMinutes,
      }),
    );
    process.exitCode = result.verdict.passed ? 0 : 1;
  } catch {
    console.error(
      'Rung 2 setup unavailable. Follow docs/agents/regression-ladder.md#rung-2-path-triggered-dry-micro-bench; no baseline was established.',
    );
    process.exitCode = 1;
  }
}
