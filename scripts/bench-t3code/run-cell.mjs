#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// B1.5d cell: N concurrent agents land the 10 frozen tasks on one arm in the PLAN.md order,
// then the oracle grades the exact final main. Usage:
//   node scripts/bench-t3code/run-cell.mjs ARM N REP [--dry | --model-check] [--attempt K] [--pin FILE] [--batch DIR] [--unpinned] [--tasks K]
// --batch DIR (the driver): the batch holds the freeze and checked nanthai-forge before it
// started; this cell writes DIR/<arm>.cell, and before grading waits until every cell of the
// batch has settled (DIR/<arm>.settled or a result), so no oracle branch is pushed while any
// agent of either arm still runs.
// --model-check runs the real agent under the dry run's gates (main may move, no qualified
// harness needed) to prove the agent adapter end to end; it is never scored.
// Always writes runs/<cellId>/result.json (refused, voided, crashed or complete) and exits 0
// once a result exists, 3 when a gate refused (nothing ran). A task's harness error is
// recorded on that task; the cell continues. Results are write-once.
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { loadavg } from 'node:os';
import { benchRootOrExit } from './bench-root.mjs';
import { launchAgent, agentOf, killAgents, claudeTokenFile, claudeTokenProblem } from './agent.mjs';
import { prompt } from './prompt.mjs';
import * as github from './github-arm.mjs';
import { forgeArm, readCalls, openLanes } from './forge-arm.mjs';
import { convexMeter } from './meter.mjs';
import { landingFields, cellSummary } from './score.mjs';
import { oracleCommit, runOracle, grade } from './oracle.mjs';
import { cellFinished } from './oracle-branches.mjs';
import { attribute, gitShow } from './attribution.mjs';
import { sharedDeps, linkDepsAsync } from './deps.mjs';
import { loadTasks, schedule, cellKey } from './plan.mjs';
import {
  snapshot,
  differences,
  snapshotProblems,
  pinProblems,
  forgeInFlight,
  benchFreeze,
  benchHoldText,
} from './versions.mjs';
import { startSampler, rateLimit, clockOffsets } from './samplers.mjs';
import { keepTranscript, readSession } from './transcripts.mjs';
import { scanTask } from './contamination.mjs';
import { forgeTask, githubTask, cellCoordination } from './coordination.mjs';
import { cellFallbacks } from './fallbacks.mjs';
import { captureChanges, realConflicts } from './hunks.mjs';
import { scriptedForge, dryGroup } from './scripted.mjs';
import { removeWorkspace } from './evidence.mjs';
import { gates as cellGates, diskFreeGb } from './gates.mjs';
import { writeCellResult } from './result.mjs';
import { collectRunners } from './runners.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';

const B = benchRootOrExit();
const config = JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
const [arm, nText, repText, ...flags] = process.argv.slice(2);
const flag = name => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : null);
const N = Number(nText),
  rep = Number(repText),
  dry = flags.includes('--dry'),
  modelCheck = !dry && flags.includes('--model-check'),
  trial = dry || modelCheck,
  attempt = Number(flag('--attempt') ?? 1),
  // The outlier rule's extra rep of (N, rep): same seed and order, key suffix x (plan.mjs extraBatch).
  extra = flags.includes('--extra'),
  taskLimit = flag('--tasks') ? Number(flag('--tasks')) : null;
if (!['github', 'forge'].includes(arm) || !(N >= 1) || !(rep >= 1))
  throw Error('usage: run-cell.mjs github|forge N REP [--dry] [--extra]');
const all = loadTasks(B);
const byId = new Map(all.map(t => [t.id, t]));
const planned = schedule(all.map(t => t.id)).find(c => c.key === cellKey(arm, N, rep) + (extra ? 'x' : ''));
if (!planned) throw Error(`cell ${cellKey(arm, N, rep)} is not in PLAN.md`);
const tasks = planned.order.map(id => byId.get(id)).slice(0, taskLimit ?? undefined);
const base = config.github.mainBase;
// A Claude agent logs in only through the plan's token, handed over a pipe (agent.mjs). Read it
// once before any folder is made; a dry cell runs the scripted agent and needs none.
const tokenFile = claudeTokenFile(B, config);
const tokenProblem = !dry && agentOf(config).provider === 'claude' ? claudeTokenProblem(tokenFile) : null;
if (tokenProblem) throw Error(tokenProblem);
const claudeToken =
  !dry && agentOf(config).provider === 'claude' ? readFileSync(tokenFile, 'utf8').trim() : null;
const batchDir = flag('--batch');
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const cellId = `${planned.key}${dry ? '-dry' : modelCheck ? '-modelcheck' : ''}-a${attempt}-${stamp}`;
const dir = join(B, 'runs', cellId),
  ws = join(B, 'ws', cellId);
mkdirSync(join(B, 'runs'), { recursive: true });
mkdirSync(dir); // write-once
mkdirSync(ws, { recursive: true });
writeFileSync(
  join(dir, 'cell.json'),
  JSON.stringify({
    pid: process.pid,
    key: planned.key,
    attempt,
    dry,
    modelCheck,
    extra,
    seed: planned.seed,
    order: planned.order,
    startedAt: new Date().toISOString(),
  }) + '\n',
);
if (batchDir) writeFileSync(join(batchDir, `${arm}.cell`), cellId + '\n');
const event = entry =>
  writeFileSync(
    join(dir, 'events.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
    { flag: 'a' },
  );
const result = {
  cellId,
  key: planned.key,
  arm,
  N,
  rep,
  attempt,
  dry,
  modelCheck,
  extra,
  seed: planned.seed,
  order: tasks.map(t => t.id),
};
const writeResult = more => writeCellResult(dir, result, more);
const callLog = join(dir, 'nforge-calls.jsonl');
const ledger = join(B, 'forge-lanes.jsonl');
const forge = arm === 'forge' ? forgeArm(config.forge, { callLog, ws, ledger, cellDir: dir }) : null;
const lanes = new Map(); // laneId -> { task, root }
let records = [];
let crashing = false;
// True from the first dispatch on. A crash before it left no agent run in either arm, which
// the driver does not count as a batch attempt (drive.mjs).
let agentsStarted = false;
// Crash safety: any escape writes a voided result, abandons idle Lanes and removes the cell's
// checkouts, so the driver can re-run the cell from a clean state.
// Agents run detached (own process groups) and are killed first; a Lane whose landing is
// still in flight is left to finish, never abandoned (B7).
async function crash(reason) {
  if (forge) {
    if (crashing) return;
    crashing = true;
  }
  event({ event: 'crash', reason });
  const killed = killAgents();
  writeResult({
    crashed: reason,
    agentsStarted,
    records,
    killedAgents: killed,
    voided: [`harness crash: ${reason}`],
  });
  let retained = false;
  for (const [laneId, { root, task }] of lanes) {
    const now = await forge?.landing(task, laneId, { deadlineMs: 0 }).catch(() => null);
    const closed = await forge?.closeTask(root, laneId, now).catch(() => null);
    if (!closed || closed.skipped || Object.values(closed).some(r => r.error)) retained = true;
  }
  forge?.stopBroker();
  try {
    await cleanupWorkspace('abnormal-exit', retained);
  } catch (error) {
    event({ event: 'evidence-incomplete', error: error.message, retainedWorkspace: ws });
  }
  process.exit(0);
}
process.on('uncaughtException', e => crash(String(e?.stack ?? e).slice(0, 800)));
process.on('unhandledRejection', e => crash(String(e?.stack ?? e).slice(0, 800)));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(signal, () => crash(`interrupted by ${signal}`));

// The cell holds the CLI installation's measurement hold for its whole run (the product updater
// would switch `current` mid-cell); the driver may already hold it. Released on every exit. The
// hold names the bench project, so the cell's own agents land while dogfood landings wait.
const FREEZE = benchFreeze(config);
const ownsFreeze = !existsSync(FREEZE);
if (ownsFreeze) writeFileSync(FREEZE, benchHoldText(config, `bench cell ${cellId} pid ${process.pid}`));
process.on('exit', () => {
  if (ownsFreeze) rmSync(FREEZE, { force: true });
});

// ---- Gates (nothing has run yet; a refusal leaves no trace beyond result.json).
const start = await snapshot(config);
const gates = await cellGates({
  arm,
  N,
  dry: trial,
  config,
  start,
  flags,
  B,
  pinProblems,
  snapshotProblems,
  differences,
  // In a batch the driver checked nanthai-forge before either cell started; the sibling
  // Forge cell's own check runs would otherwise refuse this one.
  forgeInFlight: batchDir ? async () => [] : forgeInFlight,
  pinFile: flag('--pin'),
});
if (batchDir) gates.inFlightCheckedBy = 'batch';
result.gates = gates;
if (gates.refusals.length) {
  writeResult({ refused: gates.refusals.join('; ') });
  console.log(JSON.stringify({ cellId, refused: gates.refusals }));
  rmSync(ws, { recursive: true, force: true });
  process.exit(3);
}

// ---- Setup and reset (outside cell timing).
const shared = sharedDeps(B, config.baseCheckout);
const objectCache = join(B, 'forge-cache', 'objects');
if (arm === 'forge') process.env.FORGE_OBJECT_CACHE = objectCache;
const bin = join(ws, 'bin');
mkdirSync(bin, { recursive: true });
if (forge) await forge.binDir(bin);
const scripted = arm === 'github' ? github.scriptedAgent(bin) : scriptedForge(bin);
const vpHome = join(ws, 'vp');
if (shared) await promisify(execFile)('cp', ['-cR', shared.vpHome, vpHome]);
const depsEnv = shared
  ? {
      VP_HOME: vpHome,
      npm_config_store_dir: join(shared.home, 'Library/pnpm/store'),
      PLAYWRIGHT_BROWSERS_PATH: shared.browsers,
    }
  : {};
const sampler = startSampler(join(dir, 'samples.jsonl'));
result.load = {
  before: { rateLimit: await rateLimit(), clock: await clockOffsets(config.forge.url), load: loadavg() },
};
try {
  result.githubClock = { start: await github.measureSkew(config.github.mainBase) };
} catch (error) {
  await crash(`GitHub clock probe failed: ${String(error.message).slice(0, 300)}`);
}
// Lanes an earlier cell left open (a crash while a landing was in flight) would raise notices
// and hold files in this one: close them first; one that will not close voids the cell.
if (forge) {
  result.leftoverLanes = [];
  for (const l of openLanes(ledger)) {
    const prior =
      l.callLog && l.task ? forgeArm(config.forge, { callLog: l.callLog, ws, ledger, cellDir: dir }) : null;
    const landing = prior ? await prior.landing(l.task, l.laneId, { deadlineMs: 0 }) : null;
    const r = landing?.inFlight?.length
      ? { error: 'Earlier task landing still in flight; Lane kept' }
      : await forge.abandonById(l.laneId, 'bench: Lane left open by an earlier cell');
    result.leftoverLanes.push({
      laneId: l.laneId,
      since: l.at,
      closed: !r.error,
      error: r.error?.slice(-200),
    });
  }
  const stuck = result.leftoverLanes.filter(l => !l.closed);
  if (stuck.length)
    await crash(`Lanes left open by an earlier cell would not close: ${stuck.map(l => l.laneId).join(',')}`);
}
event({ event: 'reset-start' });
try {
  result.resetReceipt =
    arm === 'github'
      ? await github.reset(base, { finishedCell: id => cellFinished(join(B, 'runs'), id) })
      : await forge.reset({ meta: config.meta, baseCommit: base, root: join(ws, 'reset') });
} catch (error) {
  await crash(`reset failed: ${String(error.message).slice(0, 400)}`);
}
event({ event: 'reset-done', resetReceipt: result.resetReceipt });
let meter = null;
if (forge) {
  meter = convexMeter({
    deployment: config.forge.deployment,
    projectId: config.forge.projectId,
    name: config.forge.projectName,
    cwd: start.harness.dir,
  });
  try {
    // `capabilities` answers from the CLI cache; `metrics` always reads the project.
    result.meterReady = await meter.ready(() =>
      forge.nf(join(ws, '.anchor'), 'metrics', {
        url: config.forge.url,
        projectId: config.forge.projectId,
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date().toISOString(),
      }),
    );
  } catch (error) {
    meter.stop();
    await crash(`Convex meter not live: ${error.message}`);
  }
}
const hub = join(ws, 'hub');
if (arm === 'github') await github.prepareHub(hub);
try {
  result.floors = await github.markFloors([arm === 'github' ? github.repository : 'NanthAI/nanthai-forge']);
} catch (error) {
  await crash(`PR and run floors unreadable: ${String(error.message).slice(0, 300)}`);
}

// ---- Start barrier: concurrent cells of a batch dispatch together (setup and resets differ
// in length per arm: GitHub's is a force push, Forge's a landing), so both arms share the load.
if (batchDir) {
  writeFileSync(join(batchDir, `${arm}.ready`), new Date().toISOString() + '\n');
  result.startBarrier = await waitForArms(batchDir, 'ready', { deadlineMs: 60 * 60_000 });
  if (!result.startBarrier.ok) {
    meter?.stop();
    await crash(
      `start barrier: ${result.startBarrier.waiting.join(',')} ${result.startBarrier.siblingEnded ? 'ended before dispatch' : 'never became ready'}`,
    );
  }
}

// ---- Cell.
agentsStarted = true;
const queue = [...tasks];
const settling = [];
const cellStart = Date.now();
const prefixOf = taskId => join(dir, 'agents', taskId);
async function dispatch(task, k) {
  const root = join(ws, task.id),
    branch = `agent-${k}/${task.id}`;
  const prepStart = Date.now();
  const record = {
    task: task.id,
    overlap: task.overlap,
    worker: k,
    laneId: null,
    branch: arm === 'github' ? branch : null,
  };
  try {
    let env = {
      PATH: `${bin}:${shared ? join(vpHome, 'bin') + ':' : ''}/usr/local/bin:${process.env.PATH}`,
      ...depsEnv,
    };
    // Prep phases, both arms (PLAN.md, Same workspace-prep rule): seconds per step.
    record.prep = {};
    if (arm === 'github') {
      record.prep = await github.workspace(hub, root, branch);
      env = { ...env, GH_REPO: github.repository, GIT_TERMINAL_PROMPT: '0' };
    } else {
      record.laneId = await forge.startLane(
        root,
        `${task.id}: ${task.prompt.split('\n')[0]}`,
        record.prep,
        task.id,
      );
      lanes.set(record.laneId, { task: task.id, root });
      const t = Date.now();
      env = { ...env, ...(await forge.agentEnv(root, task.id, { ...env, FORGE_OBJECT_CACHE: objectCache })) };
      record.prep.relay = (Date.now() - t) / 1000;
    }
    const depsAt = Date.now();
    record.deps = shared ? await linkDepsAsync(shared, root) : null;
    record.prep.deps = (Date.now() - depsAt) / 1000;
    const dispatchedAt = Date.now();
    record.dispatchedAt = new Date(dispatchedAt).toISOString();
    record.prepSeconds = (dispatchedAt - prepStart) / 1000;
    event({
      event: 'dispatch',
      worker: k,
      task: task.id,
      laneId: record.laneId,
      prepSeconds: record.prepSeconds,
      prep: record.prep,
    });
    const text = prompt(
      task,
      arm,
      arm === 'github'
        ? { repository: github.repository, branch }
        : { projectName: config.forge.projectName },
    );
    record.agent = await launchAgent({
      workspace: root,
      benchRoot: B,
      prefix: prefixOf(task.id),
      prompt: text,
      env,
      timeoutMs: config.agentTimeoutMinutes * 60_000,
      agent: agentOf(config),
      claudeToken,
      extraReads: [
        ...(arm === 'github' ? [hub] : [...forgeCliReads(config.forge.cli), objectCache]),
        ...(shared ? [shared.deps] : []),
      ],
      extraWrites: shared ? [vpHome] : [],
      scripted: dry
        ? {
            command: scripted,
            args: arm === 'github' ? [branch, task.id, dryGroup(task)] : [task.id, dryGroup(task)],
          }
        : null,
    });
    const agentExitedAt = Date.now();
    record.transcript =
      record.agent.transcript ??
      (record.agent.provider === 'claude' && record.agent.sessionId
        ? keepTranscript(record.agent.sessionId, prefixOf(task.id))
        : null);
    // Settle and clean up in the background: the worker takes its next task right away.
    settling.push(
      (async () => {
        try {
          const landing =
            arm === 'github'
              ? await github.landing(branch, new Date(prepStart).toISOString(), { agentExitedAt })
              : await forge.landing(task.id, record.laneId, { agentExitedAt });
          Object.assign(record, landingFields(landing, dispatchedAt));
          // The task's own files at agent exit, for Metric 4's real-conflict check.
          record.changes = await captureChanges({
            arm,
            meta: config.meta,
            baseCommit: base,
            root,
            out: join(dir, 'agents', `${task.id}.files`),
          }).catch(error => ({ error: String(error.message).slice(0, 300) }));
          // Close every Lane of the task (its own and resolve Lanes) but the one it landed from.
          if (forge) record.abandon = await forge.closeTask(root, record.laneId, landing);
        } catch (error) {
          record.harnessError = `settle: ${String(error.message).slice(0, 400)}`;
          record.landing ??= { landed: false, state: 'harness-error' };
        }
        event({ event: 'task-done', ...record });
        record.evidence = await (forge
          ? record.landing?.inFlight?.length || record.harnessError || record.abandon?.skipped
            ? { retainedWorkspace: root }
            : forge.removeRoot(root, 'task-done')
          : rm(root, { recursive: true, force: true }));
        if (record.laneId && !record.evidence?.retainedWorkspace) lanes.delete(record.laneId);
      })(),
    );
  } catch (error) {
    record.harnessError = String(error.message).slice(0, 400);
    record.landing = { landed: false, state: 'harness-error' };
    event({ event: 'task-error', task: task.id, error: record.harnessError });
    if (record.laneId) {
      try {
        const landing = await forge.landing(task.id, record.laneId, { agentExitedAt: Date.now() });
        Object.assign(record, landingFields(landing, Date.parse(record.dispatchedAt) || prepStart));
        record.abandon = await forge.closeTask(root, record.laneId, landing);
      } catch {
        record.abandon = { skipped: 'landing state unknown' };
      }
    }
    record.evidence = await (forge
      ? record.landing?.inFlight?.length || record.abandon?.skipped
        ? { retainedWorkspace: root }
        : forge.removeRoot(root, 'task-error')
      : rm(root, { recursive: true, force: true }));
  }
  return record;
}
async function worker(k) {
  while (!crashing && queue.length) records.push(await dispatch(queue.shift(), k));
}
await Promise.all(Array.from({ length: N }, (_, k) => worker(k + 1)));
await Promise.all(settling);
const settled =
  arm === 'github'
    ? await github.settleQueue()
    : {
        settled: !records.some(r => r.landing?.inFlight?.length),
        queued: records.filter(r => r.landing?.inFlight?.length).map(r => r.task),
      };
const cellEnd = Date.now();
const convex = meter?.stop() ?? null;
records = tasks.map(
  t =>
    records.find(r => r?.task === t.id) ?? {
      task: t.id,
      overlap: t.overlap,
      harnessError: 'not dispatched',
      landing: { landed: false, state: 'not-dispatched' },
    },
);
const summary = cellSummary(records, tasks.length, cellStart);
// The window starts at cell start: the reset's own check or push run happened before it.
const since = new Date(cellStart).toISOString();
const ciKeep =
  arm === 'github'
    ? r => r.event !== 'workflow_dispatch' && !String(r.head_branch).startsWith('oracle/')
    : r => String(r.name).startsWith('forge-check/');
// Whole minutes only: wait for runs still going (e.g. the push run after the last merge).
const ciSettled = await github
  .settleRuns(arm === 'github' ? github.repository : 'NanthAI/nanthai-forge', since, ciKeep)
  .catch(e => ({ settled: false, error: e.message }));
const until = new Date().toISOString();

// ---- Observations after the cell (CI, runner, coordination, contamination).
const branchPrs = new Map(
  records.filter(r => r.branch && r.landing?.prs?.length).map(r => [r.branch, r.landing.prs.at(-1)]),
);
const ci = await (
  arm === 'github' ? github.windowMetrics(since, until, branchPrs) : forgeCi(since, until)
).catch(e => ({ error: e.message }));
ci.settled = ciSettled;
// Every job, including explicit skipped/unreadable evidence; logs fetched once per job.
const runner = await collectRunners(ci.jobRecords ?? [], jobId =>
  github.runnerInfo(ci.repo ?? github.repository, jobId),
);
const calls = readCalls(callLog);
const laneTask = new Map([...records].filter(r => r.laneId).map(r => [r.laneId, r.task]));
const prNumbers = all.map(t => t.pr);
const mergeShas = all.map(t => t.mergeCommit);
const perTask = [],
  contamination = {};
for (const r of records) {
  // One task's unreadable transcript or odd record is that task's harness error, never a crash.
  try {
    const session = readSession(prefixOf(r.task));
    const mine = calls.filter(c => c.task === r.task);
    perTask.push(
      arm === 'forge'
        ? forgeTask({ task: r.task, calls: mine, landing: r.landing, session, laneTask })
        : githubTask({ task: r.task, landing: r.landing, session, runs: ci.runList ?? [] }),
    );
    contamination[r.task] = scanTask({
      session,
      calls: mine,
      ownIds: new Set([r.laneId].filter(Boolean)),
      prNumbers,
      mergeShas,
      ownPrs: r.landing?.prs ?? [],
      workspace: join(ws, r.task),
      // The agent's own fork and branch, and the tools the harness gave it: reads of those
      // are not reaches for the answer (d8cf81b4).
      ownRepo: arm === 'github' ? github.repository : null,
      ownBranches: [r.branch].filter(Boolean),
      toolPaths: [bin, vpHome, hub, shared?.deps].filter(Boolean),
      benchRoot: B,
    });
  } catch (error) {
    r.harnessError ??= `post-cell audit: ${error.message}`;
    contamination[r.task] = {
      void: true,
      hits: [{ id: 'audit-failed', excerpt: error.message.slice(0, 200) }],
    };
  }
}
let coordination;
try {
  coordination = cellCoordination(arm, perTask, records, {
    realConflicts: await realConflicts({
      meta: config.meta,
      baseCommit: base,
      tasks: records.map(r => ({ task: r.task, changes: r.changes })),
    }),
  });
} catch (error) {
  coordination = { error: String(error.message).slice(0, 300) };
}
// Per-reason fast-path fallback counts, from the same metrics reply (7c2e69e1).
let forgeFallbacks = null;
if (forge)
  try {
    const metrics = await forge.nf(join(ws, '.anchor'), 'metrics', {
      url: config.forge.url,
      projectId: config.forge.projectId,
      from: since,
      to: until,
    });
    writeFileSync(join(dir, 'forge-metrics.json'), JSON.stringify(metrics, null, 1));
    forgeFallbacks = cellFallbacks(metrics);
  } catch (error) {
    coordination.forgeMetricsError = String(error.stdout ?? error.message).slice(0, 300);
  }

// ---- Batch barrier: grade only when no agent of any cell in the batch runs (leak control).
if (batchDir) {
  writeFileSync(join(batchDir, `${arm}.settled`), new Date().toISOString() + '\n');
  result.batchBarrier = await batchBarrier(batchDir);
}

// ---- Grade the exact final main (no agent runs now; the grading branch is deleted after).
let oracle = null;
const oracleReport = {};
try {
  if (result.batchBarrier && !result.batchBarrier.ok)
    throw Error(`batch barrier: ${result.batchBarrier.waiting.join(',')} still running`);
  const meta = config.meta;
  let c;
  if (arm === 'github')
    c = await oracleCommit({
      meta,
      tasks,
      label: cellId,
      fromCommit: await github.mainHead(),
      baseCommit: base,
    });
  else {
    const root = join(ws, 'final-main');
    const laneId = await forge.startLane(root, 'bench oracle export');
    c = await oracleCommit({ meta, tasks, label: cellId, fromDirectory: root, baseCommit: base });
    await forge.abandon(root, laneId);
    await forge.removeRoot(root);
  }
  const ran = await runOracle({ meta, ...c }, join(dir, 'oracle-log.txt'), oracleReport);
  oracle = {
    commit: c.commit,
    changedFromBase: c.changedFromBase,
    runId: ran.runId,
    conclusion: ran.conclusion ?? ran.status,
    grade: ran.cases ? grade(tasks, ran, attribute(tasks, gitShow(meta))) : null,
  };
} catch (error) {
  oracle = { error: String(error.message).slice(0, 500) };
}
// A grading branch that could not be deleted is disclosed here; the next reset removes it.
if (oracleReport.branch) oracle.branchCleanup = oracleReport.branch;

// ---- Versions at the end, voids, result.
const end = await snapshot(config);
sampler.stop();
result.load.after = {
  rateLimit: await rateLimit(),
  clock: await clockOffsets(config.forge.url),
  load: loadavg(),
};
result.githubClock.end = await github.measureSkew(config.github.mainBase).catch(e => ({ error: e.message }));
const clockDriftMs =
  result.githubClock.end.skewMs == null
    ? null
    : Math.abs(result.githubClock.end.skewMs - result.githubClock.start.skewMs);
const unpinned = dry && flags.includes('--unpinned');
const versionChanges = differences(start, end, { liveMain: trial, unpinned });
const waivedChanges = trial
  ? differences(start, end, { unpinned }).filter(d => !versionChanges.includes(d))
  : [];
const voided = [];
if (versionChanges.length) voided.push(`versions changed during cell: ${versionChanges.join('; ')}`);
// A usage, rate or provider-capacity stop voids that task (listed in taskVoids), not the cell.
const quotaTasks = dry ? [] : records.filter(r => r.agent?.quotaHit).map(r => r.task);
if (convex && !convex.valid) voided.push(`Convex meter under-reported: ${convex.problems.join(', ')}`);
voided.push(...runner.voided);
// GitHub times are corrected by the probe at the start; a moving offset makes them unreliable.
if (clockDriftMs === null || clockDriftMs > 5000)
  voided.push(`GitHub clock offset moved during cell (${clockDriftMs ?? 'unreadable'} ms)`);
if (!settled.settled) voided.push(`landing still in flight at grading: ${settled.queued.join(',')}`);
if (!oracle?.grade) voided.push(`grading failed: ${oracle?.error ?? oracle?.conclusion}`);
const harnessErrors = records.filter(r => r.harnessError).map(r => r.task);
if (harnessErrors.length) voided.push(`harness error on ${harnessErrors.join(',')}`);
const tokens = dry
  ? null
  : [
      'inputTokens',
      'cacheCreationInputTokens',
      'cacheReadInputTokens',
      'outputTokens',
      'reasoningOutputTokens',
      'numTurns',
    ].reduce(
      (sum, key) => ({ ...sum, [key]: records.reduce((a, r) => a + (r.agent?.usage?.[key] ?? 0), 0) }),
      {},
    );
writeResult({
  versions: { start, end, changes: versionChanges, waivedWhileMainLive: waivedChanges },
  startedAt: new Date(cellStart).toISOString(),
  endedAt: new Date(cellEnd).toISOString(),
  ...summary,
  records,
  taskVoids: [
    ...new Set([
      ...Object.entries(contamination)
        .filter(([, c]) => c.void)
        .map(([task]) => task),
      ...quotaTasks,
    ]),
  ],
  quotaTasks,
  agent: dry ? 'scripted-no-model' : agentOf(config),
  contamination,
  coordination,
  forgeFallbacks,
  tokens,
  // Claude reports model API time; Codex does not (null), wall time per task is elapsedSeconds.
  agentApiSeconds: records.some(r => r.agent?.usage?.durationApiMs != null)
    ? records.reduce((a, r) => a + (r.agent?.usage?.durationApiMs ?? 0), 0) / 1000
    : null,
  agentSeconds: dry ? null : records.reduce((a, r) => a + (r.agent?.elapsedSeconds ?? 0), 0),
  ci,
  runner,
  convex,
  oracle,
  settled,
  upstreamAudit:
    arm === 'github'
      ? await github.upstreamAudit(new Date(cellStart).toISOString()).catch(e => ({ error: e.message }))
      : null,
  diskAfterGb: diskFreeGb(),
  voided,
});
forge?.stopBroker();
await cleanupWorkspace('cell-done');
console.log(
  JSON.stringify({
    cellId,
    landed: summary.landed,
    wallSeconds: summary.wallSecondsToAllLanded,
    strict: oracle?.grade?.strictSuccess ?? null,
    voided,
  }),
);
process.exit(0);

/** Keep active CLI working directories through the final sweep, too. */
async function cleanupWorkspace(reason, retained = records.some(r => r.evidence?.retainedWorkspace)) {
  if (forge && retained) event({ event: 'cleanup-deferred', retainedWorkspace: ws });
  else if (forge) await removeWorkspace({ ws, cellDir: dir, reason });
  else rmSync(ws, { recursive: true, force: true });
}

/** Every arm of the batch has settled or ended (a sibling that crashed or refused has a
 * result). Bounded: past the deadline grading is refused, not risked. */
function batchBarrier(dirPath) {
  return waitForArms(dirPath, 'settled', { deadlineMs: 120 * 60_000 });
}

/** Wait until every arm of a batch wrote DIR/<arm>.<mark> or has a result. Only concurrent
 * batches share a barrier; sequential cells (N = 10) run alone and pass straight through. */
async function waitForArms(dirPath, mark, { deadlineMs, pollMs = mark === 'ready' ? 2_000 : 15_000 }) {
  const mode = JSON.parse(readFileSync(join(dirPath, 'mode.json'), 'utf8'));
  const arms = mode === 'concurrent' ? JSON.parse(readFileSync(join(dirPath, 'arms.json'), 'utf8')) : [arm];
  const startedAt = Date.now();
  for (;;) {
    const ended = [];
    const waiting = arms.filter(a => {
      if (existsSync(join(dirPath, `${a}.${mark}`))) return false;
      const idFile = join(dirPath, `${a}.cell`);
      const id = existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : null;
      const done = Boolean(id && existsSync(join(B, 'runs', id, 'result.json')));
      if (done) ended.push(a);
      return !done;
    });
    // Before dispatch, a sibling that already ended (refused, crashed) makes the batch void:
    // stop here rather than run one arm alone.
    if (mark === 'ready' && ended.length) return { ok: false, waiting: ended, siblingEnded: true };
    if (!waiting.length) return { ok: true, waitedSeconds: (Date.now() - startedAt) / 1000 };
    if (Date.now() - startedAt > deadlineMs) return { ok: false, waiting };
    await new Promise(r => setTimeout(r, pollMs));
  }
}

function forgeCliReads(cli) {
  const pkg = join(cli, '..', '..');
  return [...new Set([pkg, realpathSync(pkg), realpathSync(join(pkg, 'node_modules'))])];
}

/** Forge check runs of the window, in the same shape as the GitHub arm (S2). Landings on
 * nanthai-forge are frozen during cells, so every forge-check run here is the bench's. */
async function forgeCi(sinceIso, untilIso) {
  const repo = 'NanthAI/nanthai-forge';
  // Only this project's checks: other builders' landings also run forge-check/<id>.
  const { runs, otherProjectRuns } = await github.projectCheckRuns(
    repo,
    config.forge.projectId,
    sinceIso,
    untilIso,
  );
  return { repo, otherProjectRuns, ...(await github.jobMetrics(repo, runs)) };
}
