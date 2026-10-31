#!/usr/bin/env node
// B1.5d cell: N concurrent agents land the 10 frozen tasks on one arm, then the oracle
// grades the exact final main. Usage:
//   node scripts/bench-t3code/run-cell.mjs ARM N REP [--dry] [--label TEXT] [--tasks K]
// ARM github|forge. --dry replaces the model with a scripted trivial edit through the
// full land/merge path. Results are write-once under BENCH_ROOT/runs/<cellId>/.
// Gates (brief): claude-usage 5h <= 40% and weekly < 85% to start a model cell; the
// deployed Forge commit is recorded before and after (a change voids the cell).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { launchAgent } from './agent.mjs';
import { prompt } from './prompt.mjs';
import * as github from './github-arm.mjs';
import { forgeArm, convexMeter } from './forge-arm.mjs';
import { oracleCommit, runOracle, grade } from './oracle.mjs';

const B = process.env.BENCH_ROOT || join(homedir(), 'NanthAI/forge-bench/b15d');
const config = JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
const [arm, nText, repText, ...flags] = process.argv.slice(2);
const N = Number(nText),
  rep = Number(repText),
  dry = flags.includes('--dry'),
  label = flags.includes('--label') ? flags[flags.indexOf('--label') + 1] : null,
  taskLimit = flags.includes('--tasks') ? Number(flags[flags.indexOf('--tasks') + 1]) : null;
if (!['github', 'forge'].includes(arm) || !(N >= 1) || !(rep >= 0))
  throw Error('usage: run-cell.mjs github|forge N REP [--dry]');
const tasks = JSON.parse(readFileSync(join(B, 'tasks.json'), 'utf8')).tasks.slice(0, taskLimit ?? undefined);
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const cellId = `${arm}-n${N}-r${rep}${dry ? '-dry' : ''}-${stamp}`;
const dir = join(B, 'runs', cellId),
  ws = join(B, 'ws', cellId);
mkdirSync(join(B, 'runs'), { recursive: true });
mkdirSync(dir); // write-once: an existing cell directory fails here
mkdirSync(ws, { recursive: true });
// Each cell's checkouts and temp dirs go away on every exit path (refusal, crash, signal).
process.on('exit', () => rmSync(ws, { recursive: true, force: true }));
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(130));
const event = entry =>
  appendFileSync(
    join(dir, 'events.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
  );
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 }).trim();

/** GiB available on the data volume, the same figure `df -g /System/Volumes/Data` prints. */
function diskFreeGb() {
  const line = sh('df', ['-k', '/System/Volumes/Data']).split('\n').at(-1).trim().split(/\s+/);
  return Number(line[3]) / 1024 / 1024;
}
/** Estimated peak disk of this cell (handoff table); first runs record the real delta.
 * One shared dependency install keyed by the lockfile is counted until it exists. */
function diskNeed() {
  const parts = {};
  if (arm === 'github') {
    parts.hub = 0.3;
    parts.checkouts = N * 0.14;
  } else {
    parts.laneRoots = N * 0.5;
    parts.resetAndOracleRoots = 1.0;
  }
  if (!dry) {
    parts.buildAndTestCaches = N * (arm === 'forge' ? 0.5 : 0.3);
    if (!existsSync(join(B, 'deps'))) parts.sharedDependencyInstallAndToolchain = 2.4;
  }
  const needGb = Object.values(parts).reduce((a, b) => a + b, 0);
  return { parts, needGb, floorGb: 15, requiredGb: 15 + needGb };
}
function usageGate() {
  try {
    const u = JSON.parse(sh('claude-usage', ['--json']));
    return {
      session5h: u.session5h?.usedPercent ?? null,
      weekly: u.weekly?.usedPercent ?? null,
      checkedAt: u.checkedAt,
    };
  } catch {
    return { session5h: null, weekly: null, error: 'unreadable' };
  }
}
/** The Convex build the Forge arm measures: latest successful dev deploy on main. */
function forgeBuild() {
  try {
    const [run] = JSON.parse(
      sh('gh', [
        'run',
        'list',
        '-R',
        'NanthAI/nanthai-forge',
        '--workflow',
        config.forge.deployWorkflow,
        '--status',
        'success',
        '-L',
        '1',
        '--json',
        'headSha,updatedAt,databaseId',
      ]),
    );
    return run ?? null;
  } catch {
    return null;
  }
}

const gates = {
  usage: usageGate(),
  forgeBuild: forgeBuild(),
  disk: { freeGb: diskFreeGb(), ...diskNeed() },
};
const refuse = reason => {
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ cellId, refused: reason, gates }, null, 1));
  console.log(JSON.stringify({ cellId, refused: reason }));
  process.exit(3);
};
if (!dry) {
  if (gates.usage.session5h === null || gates.usage.session5h > 40)
    refuse('claude 5h usage above 40% (quota isolation)');
  if (gates.usage.weekly === null || gates.usage.weekly >= 85) refuse('claude weekly usage at or above 85%');
  if (arm === 'forge' && !config.forge.qualifiedAt) refuse('Forge adapter not qualified by a dry run');
}
// Lead's hard disk gate (2026-10-31, builders hit ENOSPC): free >= 15 GB + this cell's need.
if (gates.disk.freeGb < gates.disk.requiredGb)
  refuse(
    `disk ${gates.disk.freeGb.toFixed(1)} GB free < ${gates.disk.requiredGb.toFixed(1)} GB required (15 GB floor + ${gates.disk.needGb.toFixed(1)} GB cell need: ${JSON.stringify(gates.disk.parts)})`,
  );

const forge = arm === 'forge' ? forgeArm(config.forge) : null;
const bin = join(ws, 'bin');
mkdirSync(bin, { recursive: true });
const armEnv =
  arm === 'github' ? { GH_REPO: github.repository, GIT_TERMINAL_PROMPT: '0' } : forge.binDir(bin);
const scripted = arm === 'github' ? github.scriptedAgent(bin, 'github') : null;

// Reset to the frozen base (outside cell timing).
event({ event: 'reset-start' });
const resetReceipt =
  arm === 'github'
    ? github.reset(config.github.mainBase)
    : await forge.reset({
        meta: config.meta,
        baseCommit: config.forge.mainBase,
        baseCheckout: config.baseCheckout,
        anchor: join(ws, 'anchor'),
        root: join(ws, 'reset'),
      });
event({ event: 'reset-done', resetReceipt });
const meter =
  arm === 'forge'
    ? convexMeter({
        deployment: config.forge.deployment,
        projectId: config.forge.projectId,
        name: config.forge.projectName,
        cwd: config.forge.lane,
      })
    : null;

const hub = join(ws, 'hub');
if (arm === 'github') await github.prepareHub(hub);
const queue = [...tasks];
const records = [];
const cellStart = Date.now();
async function worker(k) {
  while (queue.length) {
    const task = queue.shift();
    const root = join(ws, `${task.id}`),
      branch = `agent-${k}/${task.id}`;
    const prepStart = Date.now();
    let laneId = null,
      env = { PATH: `${bin}:/usr/local/bin:${process.env.PATH}` };
    if (arm === 'github') {
      await github.workspace(hub, root, branch);
      env = { ...env, ...armEnv };
    } else
      laneId = await forge.startLane(join(ws, 'anchor'), root, `${task.id}: ${task.prompt.split('\n')[0]}`);
    const dispatchedAt = Date.now();
    event({
      event: 'dispatch',
      worker: k,
      task: task.id,
      laneId,
      prepSeconds: (dispatchedAt - prepStart) / 1000,
    });
    const text = prompt(
      task,
      arm,
      arm === 'github'
        ? { repository: github.repository, branch }
        : { projectName: config.forge.projectName },
    );
    const receipt = await launchAgent({
      workspace: root,
      benchRoot: B,
      prefix: join(dir, 'agents', task.id),
      prompt: text,
      env,
      timeoutMs: config.agentTimeoutMinutes * 60_000,
      // GitHub: the hub is the shared clone's object store (read-only for the agent).
      // Forge: the nforge CLI bundle lives beside the denied control checkouts.
      extraReads: arm === 'github' ? [hub] : [dirname(dirname(config.forge.cli))],
      scripted: dry
        ? arm === 'github'
          ? { command: scripted, args: [branch, task.id] }
          : {
              command: '/bin/bash',
              args: [
                '-c',
                `mkdir -p .bench/dry && echo "dry run ${task.id}" > .bench/dry/${task.id}.md && nforge agent . land --save '{"message":"bench dry run: ${task.id}"}'`,
              ],
            }
        : null,
    });
    const landing =
      arm === 'github'
        ? github.landing(branch, new Date(prepStart).toISOString())
        : forge.landing(root, laneId);
    const landedAtMs = landing.mergedAt
      ? Date.parse(landing.mergedAt)
      : landing.acceptedAt
        ? Number(landing.acceptedAt) || Date.parse(landing.acceptedAt)
        : null;
    const record = {
      task: task.id,
      overlap: task.overlap,
      worker: k,
      laneId,
      branch: arm === 'github' ? branch : null,
      dispatchedAt: new Date(dispatchedAt).toISOString(),
      agent: receipt,
      landing,
      timeToMainSeconds: landedAtMs ? (landedAtMs - dispatchedAt) / 1000 : null,
    };
    records.push(record);
    event({ event: 'task-done', ...record });
    if (arm === 'forge' && laneId && !landing.landed) forge.abandon(root, laneId);
    rmSync(root, { recursive: true, force: true });
    if (arm === 'forge') forge.removeRoot(root);
  }
}
await Promise.all(Array.from({ length: N }, (_, k) => worker(k + 1)));
const cellEnd = Date.now();
const landedTimes = records
  .map(r => r.landing.mergedAt ?? r.landing.acceptedAt)
  .filter(Boolean)
  .map(t => (typeof t === 'number' ? t : Date.parse(t)));
const wallSeconds =
  landedTimes.length === tasks.length ? (Math.max(...landedTimes) - cellStart) / 1000 : null;
const convex = meter?.stop() ?? null;

// Grade the exact final main.
let oracle = null;
try {
  const meta = config.meta;
  if (arm === 'github') {
    const head = github.mainHead();
    const c = oracleCommit({ meta, tasks, setup: join(B, 'setup'), label: cellId, fromCommit: head });
    oracle = { finalMain: head, ...c, result: await runOracle(c) };
  } else {
    const root = join(ws, 'final-main');
    const laneId = await forge.startLane(join(ws, 'anchor'), root, 'bench oracle export');
    const c = oracleCommit({
      meta,
      tasks,
      setup: join(B, 'setup'),
      label: cellId,
      fromDirectory: root,
      sgCommit: config.github.mainBase,
    });
    forge.abandon(root, laneId);
    forge.removeRoot(root);
    oracle = { ...c, result: await runOracle(c) };
  }
  oracle.grade = grade(tasks, oracle.result);
} catch (error) {
  oracle = { error: String(error.message).slice(0, 500) };
}
const until = new Date().toISOString();
const ci = arm === 'github' ? github.windowMetrics(new Date(cellStart).toISOString(), until) : null;
const after = { usage: usageGate(), forgeBuild: forgeBuild() };
const voided = [];
if (!dry && records.some(r => r.agent.quotaHit)) voided.push('agent quota hit during cell');
// A dev redeploy changes the Forge arm's system under test; the GitHub arm records it only.
const deployChanged = gates.forgeBuild?.headSha !== after.forgeBuild?.headSha;
if (arm === 'forge' && deployChanged) voided.push('Forge dev deploy changed during cell');
const result = {
  cellId,
  arm,
  N,
  rep,
  dry,
  label,
  gates,
  after,
  resetReceipt,
  startedAt: new Date(cellStart).toISOString(),
  endedAt: new Date(cellEnd).toISOString(),
  wallSecondsToAllLanded: wallSeconds,
  landed: records.filter(r => r.landing.landed).length,
  tasks: tasks.length,
  landingsPerHour: wallSeconds ? (tasks.length / wallSeconds) * 3600 : null,
  records,
  tokens: dry
    ? null
    : records.reduce(
        (sum, r) => {
          for (const key of [
            'inputTokens',
            'cacheCreationInputTokens',
            'cacheReadInputTokens',
            'outputTokens',
          ])
            sum[key] += r.agent.usage?.[key] ?? 0;
          return sum;
        },
        { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
      ),
  ci,
  convex,
  oracle,
  upstreamAudit: arm === 'github' ? github.upstreamAudit(new Date(cellStart).toISOString()) : null,
  forgeDeployChanged: deployChanged,
  diskAfterGb: diskFreeGb(),
  voided,
};
writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 1) + '\n', { flag: 'wx' });
rmSync(ws, { recursive: true, force: true });
console.log(
  JSON.stringify({
    cellId,
    landed: result.landed,
    wallSeconds,
    strict: oracle?.grade?.strictSuccess ?? null,
    voided,
  }),
);
