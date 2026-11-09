#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// B1.5d driver: runs the PLAN.md batches end to end and resumes by itself.
//   node scripts/bench-t3code/drive.mjs [--dry] [--reps 1|2] [--only n3-r1] [--tasks K] [--unpinned]
//   node scripts/bench-t3code/drive.mjs --coordination [--dry] [--reps 1|2] [--only convoy-n16-r1]
//     runs the coordination cells instead (cells.mjs: convoy, overlap with the stacking A/B),
//     one arm after the other, with the same holds, guards, void and re-run rules.
//                                       [--fake-version-change]   (dry only: proves the batch guard)
// - Batch = both arms' cells of one (N, rep). N = 1, 3, 5: the two cells run at the same time
//   (2N agents); N = 10: one arm, then the other, the first arm alternating between reps.
//   Never more than DESIGN.maxAgents agents at once.
// - Order: rep 1 with N descending (10, 5, 3, 1), rep 2 ascending, then the rep-3 rule per N
//   (plan.mjs rep3Decision, written once to rep3-n<N>.json) and the selected rep-3 batches,
//   descending (plan.mjs repNs), then the outlier rule per N (plan.mjs outlierDecision, written
//   once to outlier-n<N>.json) and its extra batches. A void batch is re-run once before the next batch starts, and
//   a resume continues at the same place (plan.mjs nextBatch). Every attempt is published.
// - Freeze: the batch holds the CLI installation's .freeze from before its first cell starts until its last
//   cell is graded (dogfood nforge land/finish wait meanwhile; the hold names the bench project, so
//   the bench's own landings pass), and is released between
//   batches. Versions (CLI, GitHub main, deployed Convex, check workflows, harness, agent) are
//   recorded at batch start and end; any change voids the batch, except GitHub main and the
//   deploy head, which builders move while a batch runs: those are recorded (versions.moved),
//   with every deploy run that overlapped the batch (deploys). A deployed convex/ change voids.
// - Resumable: a batch without batch.json whose driver is gone is closed as `interrupted`
//   (void, re-run once). Re-run the same command after any stop. One driver at a time.
// - Quiet rule (exit plan "Quiet rule and deploys"): a batch starts once no Convex deploy
//   (config.forge.deployWorkflow) is queued or running; dogfood landings, Verify Forge and
//   forge-check runs are not waited for.
// - Waits, never stops, on a usage window, a Convex deploy in flight or a gate refusal, printing one
//   CELL line per change for the lead's Monitor. Stops on the Convex budget.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import {
  plan,
  checkPlan,
  DESIGN,
  batch as planBatch,
  batches as planBatches,
  repNs,
  nextBatch,
  SETUP_ONLY,
  rep3Decision,
  outlierDecision,
  extraBatch,
  loadTasks,
} from './plan.mjs';
import {
  snapshot,
  snapshotProblems,
  moved,
  voidingChanges,
  deployInFlight,
  deploysDuring,
  benchFreeze,
  benchHoldText,
} from './versions.mjs';
import { benchRootOrExit } from './bench-root.mjs';
import { productCli } from './cli-install.mjs';
import { drainBatch, landingPathQueue } from './drain.mjs';
import { usageGate, usageProblems, diskFreeGb, diskNeed } from './gates.mjs';
import { agentOf } from './agent.mjs';
import { runnerFairness } from './runners.mjs';
import { oracleBranchRecord } from './oracle-branches.mjs';
import { coordinationBatch, coordinationBatches, parseCoordinationKey } from './cells.mjs';

let B, FREEZE;
const flags = process.argv.slice(2);
const flag = name => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : null);
const dry = flags.includes('--dry');
const reps = Number(flag('--reps') ?? DESIGN.reps);
const only = flag('--only');
const coordination = flags.includes('--coordination');
const fakeChange = dry && flags.includes('--fake-version-change');
// Convex list-price stop for the whole run (lead: report before going past $5).
export const BUDGET_USD = 5;
const RETRY_MS = Number(process.env.BENCH_DRIVE_RETRY_MS ?? 300_000);
const DRAIN_MS = 45 * 60_000;
let lastWait = '';
const say = line => {
  // A repeated wait prints once; any other line resets it.
  const shape = line.replace(/\d+(\.\d+)?%?/g, '#');
  if (line.startsWith('WAIT') && shape === lastWait) return;
  lastWait = line.startsWith('WAIT') ? shape : '';
  console.log(`CELL ${line} (${new Date().toISOString().slice(11, 19)})`);
};
const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

/** The batch guard: every version key, start vs end, a deployed convex/ change on the landing
 * path, plus the freeze itself. `exec` reaches GitHub (tests pass a fake). */
export async function batchGuard(start, end, { unpinned = false, exec } = {}) {
  const { changes, convexFiles } = await voidingChanges(start, end, { unpinned, ...(exec ? { exec } : {}) });
  if (!end.freeze) changes.push('freeze file missing at batch end');
  return Object.assign(changes, { convexFiles });
}

/** A start wait for the batch record (exit plan "Quiet rule and deploys", lead acdbee8b):
 * consecutive waits of the same shape merge into one entry (first, last, polls). */
export function recordWait(list, line, at = new Date().toISOString()) {
  const shape = line.replace(/\d+(\.\d+)?%?/g, '#');
  const last = list.at(-1);
  if (last?.shape === shape) {
    last.last = at;
    last.polls++;
  } else list.push({ first: at, last: at, polls: 1, shape, line });
  return list;
}

/** Freeze file written by a bench process whose pid is gone (left by a kill -9). */
export function staleBenchFreeze(text) {
  const pid = Number(String(text).match(/^bench (?:driver|cell)\b.*?(?:pid )?(\d+)\s*$/m)?.[1]);
  return pid > 0 && !alive(pid);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();

async function main() {
  B = benchRootOrExit();
  const config = readJson(join(B, 'config.json'));
  const cli = productCli({ config });
  FREEZE = benchFreeze(config);
  const problems = checkPlan(B);
  if (problems.length) {
    say(`STOP plan check: ${problems.join('; ')}`);
    process.exit(2);
  }
  const lock = join(B, dry ? 'drive-dry.lock' : 'drive.lock');
  if (existsSync(lock) && alive(Number(readFileSync(lock, 'utf8')))) {
    say(`STOP another driver is running (pid ${readFileSync(lock, 'utf8').trim()})`);
    process.exit(2);
  }
  writeFileSync(lock, String(process.pid));
  if (existsSync(FREEZE) && staleBenchFreeze(readFileSync(FREEZE, 'utf8'))) {
    say(`FREEZE removed a stale bench freeze (${readFileSync(FREEZE, 'utf8').trim()})`);
    rmSync(FREEZE, { force: true });
  }
  let holding = false;
  const release = () => {
    let mine = false;
    try {
      mine = readFileSync(FREEZE, 'utf8').includes(`pid ${process.pid}`);
    } catch {}
    if (holding && mine) rmSync(FREEZE, { force: true });
    holding = false;
  };
  process.on('exit', () => {
    release();
    rmSync(lock, { force: true });
  });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => process.exit(130));

  const runs = join(B, 'runs'),
    batchRoot = join(B, 'batches');
  mkdirSync(runs, { recursive: true });
  mkdirSync(batchRoot, { recursive: true });
  const suffix = dry ? '-dry' : '';
  const ids = loadTasks(B).map(t => t.id);
  plan(B); // fails loudly on a changed task list

  /** Results of a cell id; a cell process gone without one is closed as interrupted. */
  function cellResult(cellId) {
    const dir = join(runs, cellId),
      file = join(dir, 'result.json');
    if (existsSync(file)) return readJson(file);
    if (!existsSync(join(dir, 'cell.json'))) return null;
    const { pid, key } = readJson(join(dir, 'cell.json'));
    if (alive(pid)) return { running: pid };
    const closed = {
      cellId,
      key,
      interrupted: true,
      voided: ['interrupted (process gone without a result)'],
    };
    writeFileSync(file, JSON.stringify(closed, null, 1) + '\n', { flag: 'wx' });
    return closed;
  }
  /** Finished attempts of a batch key, oldest first (interrupted ones closed here). */
  async function attempts(key) {
    const out = [];
    const dirs = readdirSync(batchRoot)
      .filter(d => d.startsWith(`${key}${suffix}-a`))
      .sort((a, b) => Number(a.match(/-a(\d+)/)[1]) - Number(b.match(/-a(\d+)/)[1]));
    for (const d of dirs) {
      const dir = join(batchRoot, d),
        file = join(dir, 'batch.json');
      if (!existsSync(file)) {
        const info = existsSync(join(dir, 'driver.json')) ? readJson(join(dir, 'driver.json')) : {};
        if (info.pid && alive(info.pid)) throw Error(`batch ${d} is still driven by pid ${info.pid}`);
        // Cells outlive a killed driver: wait for them, then close the batch.
        // A coordination batch names its cell slots (arm-stack) in arms.json.
        const slots = existsSync(join(dir, 'arms.json')) ? readJson(join(dir, 'arms.json')) : DESIGN.arms;
        for (const arm of slots) {
          const idFile = join(dir, `${arm}.cell`);
          if (!existsSync(idFile)) continue;
          for (let r; (r = cellResult(readFileSync(idFile, 'utf8').trim()))?.running;) {
            say(`WAIT ${d}: cell pid ${r.running} still running after the driver stopped`);
            await wait(30_000);
          }
        }
        writeFileSync(
          file,
          JSON.stringify(
            { key, batchId: d, interrupted: true, voided: ['interrupted (driver gone)'] },
            null,
            1,
          ) + '\n',
          { flag: 'wx' },
        );
      }
      out.push(readJson(file));
    }
    return out;
  }
  const isVoid = r => Boolean(r.voided?.length);
  /** What an attempt counts as in `nextBatch`. */
  const attemptState = r => (isVoid(r) ? (r.setupOnly ? SETUP_ONLY : true) : false);
  const forgeSpend = () =>
    readdirSync(runs)
      .filter(d => d.startsWith('forge-'))
      .reduce((sum, d) => {
        try {
          return sum + (readJson(join(runs, d, 'result.json')).convex?.costUsd ?? 0);
        } catch {
          return sum;
        }
      }, 0);

  // Queued dogfood landings that change landing-path convex/ (lead acdbee8b); each
  // submission's changed paths are read once per driver run.
  const landingCache = new Map();
  const queuedLandingPath = () =>
    config.dogfood?.projectId
      ? landingPathQueue(
          {
            cli: config.forge.cli,
            url: config.dogfood.url ?? config.forge.url,
            projectId: config.dogfood.projectId,
            root: join(B, '.dogfood-anchor'),
          },
          { cache: landingCache },
        )
      : Promise.reject(Error('config.dogfood.projectId is missing'));

  /** Under the hold, wait until no Convex deploy is queued or running on nanthai-forge and no
   * queued or checking dogfood landing changes landing-path convex/ (the quiet rule; drain.mjs;
   * nothing is cancelled). Other dogfood landings keep going. */
  const drain = (key, sayWait = say) =>
    drainBatch({
      key,
      runs: () => deployInFlight(config),
      queue: queuedLandingPath,
      deadlineMs: DRAIN_MS,
      pauseMs: Math.min(60_000, RETRY_MS),
      say: sayWait,
      wait,
    });

  /** Start rules a batch checks before taking the hold. */
  async function batchRefusals(b) {
    const r = [];
    if (!dry) r.push(...usageProblems(usageGate(agentOf(config).provider)));
    const need = b.cells.reduce((sum, c) => sum + diskNeed(c.arm, b.N, dry).needGb, 0) + 15;
    const free = diskFreeGb();
    if (free < need) r.push(`disk ${free.toFixed(1)} GB free < ${need.toFixed(1)} GB for the batch`);
    // The quiet rule, checked before the hold and again under it (drain): no deploy in flight,
    // no queued landing that changes landing-path convex/ (lead acdbee8b).
    const deploys = await deployInFlight(config).catch(e => [{ name: `unreadable: ${e.message}` }]);
    if (deploys.length)
      r.push(
        `${deploys.length} Convex deploy run(s) in flight (${deploys.map(x => x.workflowName ?? x.name).join(', ')})`,
      );
    const queued = await queuedLandingPath().catch(e => [`queue unreadable: ${e.message}`]);
    if (queued.length)
      r.push(`${queued.length} queued landing(s) change landing-path convex/ (${queued.join('; ')})`);
    if (forgeSpend() >= BUDGET_USD)
      r.push(`STOP Forge Convex spend $${forgeSpend().toFixed(2)} >= $${BUDGET_USD}`);
    return r;
  }

  function spawnCell(cell, dir, attempt, pinFile) {
    const args = [
      join(import.meta.dirname, 'run-cell.mjs'),
      cell.arm,
      String(cell.N),
      String(cell.rep),
      '--attempt',
      String(attempt),
      '--pin',
      pinFile,
      '--batch',
      dir,
      ...(dry ? ['--dry'] : []),
      ...(cell.extra ? ['--extra'] : []),
      ...(cell.kind ? ['--cell', cell.kind] : []),
      ...(cell.stack ? ['--stack', cell.stack] : []),
      ...(flags.includes('--unpinned') ? ['--unpinned'] : []),
      ...(flag('--tasks') ? ['--tasks', flag('--tasks')] : []),
    ];
    const child = spawn('/usr/local/bin/node', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let last = '',
      err = '';
    child.stdout.on('data', d => (last = (last + d).slice(-4000)));
    child.stderr.on('data', d => (err = (err + d).slice(-2000)));
    return new Promise(done =>
      child.on('close', code => {
        const line = last
          .trim()
          .split('\n')
          .filter(l => l.startsWith('{"cellId"'))
          .at(-1);
        say(`DONE ${cell.key} rc=${code} ${line ?? err.trim().slice(-400)}`);
        done({ code, line });
      }),
    );
  }

  async function runBatch(b, attempt) {
    const dir = join(batchRoot, `${b.key}${suffix}-a${attempt}`);
    // What this attempt's start waited on, for batch.json (lead acdbee8b).
    const startWaits = [];
    const sayWait = line => {
      recordWait(startWaits, line);
      say(line);
    };
    for (;;) {
      const refusals = await batchRefusals(b);
      if (refusals.some(r => r.startsWith('STOP'))) {
        say(refusals.find(r => r.startsWith('STOP')));
        process.exit(2);
      }
      if (refusals.length) {
        sayWait(`WAIT ${b.key}: ${refusals.join('; ')}; retry in ${RETRY_MS / 60_000} min`);
        await wait(RETRY_MS);
        continue;
      }
      // Hold first (new dogfood finishes wait), then let landings already submitted drain, so
      // a busy main cannot starve the batch.
      if (existsSync(FREEZE) && !readFileSync(FREEZE, 'utf8').includes(`pid ${process.pid}`)) {
        sayWait(`WAIT ${b.key}: freeze held by someone else (${readFileSync(FREEZE, 'utf8').trim()})`);
        await wait(RETRY_MS);
        continue;
      }
      const hold = benchHoldText(config, `bench driver batch ${b.key} pid ${process.pid}`);
      writeFileSync(FREEZE, hold);
      holding = true;
      const drained = await drain(b.key, sayWait);
      if (!drained) {
        release();
        sayWait(
          `WAIT ${b.key}: a Convex deploy was still in flight after ${DRAIN_MS / 60_000} min under the hold; released, retry`,
        );
        await wait(RETRY_MS);
        continue;
      }
      // Bring the installed CLI to main under the hold: `nforge update` refuses while .freeze
      // exists, so it is moved aside for the update only (a finish that slips in is caught below).
      let start = await snapshot(config);
      if (start.cli.commit !== start.githubMain) {
        renameSync(FREEZE, `${FREEZE}.batch`);
        await promisify(execFile)(process.execPath, [
          join(cli.installation, 'launcher.mjs'),
          'update',
          '--directory',
          cli.installation,
        ]).catch(() => {});
        renameSync(`${FREEZE}.batch`, FREEZE);
        if (!(await drain(b.key, sayWait))) {
          release();
          continue;
        }
        start = await snapshot(config);
      }
      const sp = snapshotProblems(start, { requireFreeze: true });
      if (sp.length) {
        release();
        sayWait(
          `WAIT ${b.key}: under the hold ${sp.join('; ')}; released, retry in ${RETRY_MS / 60_000} min`,
        );
        await wait(RETRY_MS);
        continue;
      }
      mkdirSync(dir);
      writeFileSync(
        join(dir, 'driver.json'),
        JSON.stringify({ pid: process.pid, startedAt: start.at }) + '\n',
      );
      writeFileSync(join(dir, 'arms.json'), JSON.stringify(b.cells.map(c => c.slot ?? c.arm)) + '\n');
      writeFileSync(join(dir, 'mode.json'), JSON.stringify(b.mode) + '\n');
      const pinFile = join(dir, 'pin.json');
      writeFileSync(pinFile, JSON.stringify(start, null, 1) + '\n');
      say(
        `START ${b.key} attempt ${attempt}${dry ? ' dry' : ''} ${b.mode} (${b.agentsAtOnce} agents at once) order ${b.order.join(',')} cli ${start.cli.commit?.slice(0, 12)} deploy ${start.deploy?.headSha?.slice(0, 12)} main ${start.githubMain?.slice(0, 12)}`,
      );
      const outcomes =
        b.mode === 'concurrent'
          ? await Promise.all(b.cells.map(c => spawnCell(c, dir, attempt, pinFile)))
          : [];
      if (b.mode === 'sequential')
        for (const c of b.cells) outcomes.push(await spawnCell(c, dir, attempt, pinFile));
      const end = await snapshot(config);
      if (fakeChange) {
        // A landing mid-batch moves the deploy and the CLI; fake both.
        end.deploy = { ...end.deploy, headSha: `${end.deploy?.headSha}-fake-landing` };
        end.cli = { ...end.cli, commit: `${end.cli?.commit}-fake-update` };
      }
      release();
      const cells = b.cells.map(c => {
        const idFile = join(dir, `${c.slot ?? c.arm}.cell`);
        const cellId = existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : null;
        const r = cellId ? cellResult(cellId) : null;
        return {
          key: c.key,
          arm: c.arm,
          cellId,
          runner: r?.runner ?? null,
          refused: r?.refused ?? null,
          // Crashed in setup: the cell wrote agentsStarted:false (run-cell.mjs).
          setupCrash: Boolean(r?.crashed && r.agentsStarted === false),
          voided: r?.voided ?? ['no result'],
          // A grading branch that could not be deleted is recorded here (02ee5788).
          oracleBranch: oracleBranchRecord(r),
        };
      });
      const changes = await batchGuard(start, end, { unpinned: dry && flags.includes('--unpinned') });
      const runner = runnerFairness(cells, b.mode);
      const voided = [
        ...runner.voided,
        ...(changes.length ? [`versions changed during batch: ${changes.join('; ')}`] : []),
        ...cells.filter(c => c.refused).map(c => `${c.key} refused at start: ${c.refused}`),
        ...cells
          .filter(c => !c.refused && c.voided?.length)
          .map(c => `${c.key} void: ${c.voided.join('; ')}`),
      ];
      const result = {
        key: b.key,
        batchId: `${b.key}${suffix}-a${attempt}`,
        N: b.N,
        rep: b.rep,
        mode: b.mode,
        attempt,
        dry,
        order: b.order,
        seed: b.seed,
        startedAt: start.at,
        endedAt: end.at,
        versions: {
          start,
          end,
          changes: [...changes],
          moved: moved(start, end),
          convexFiles: changes.convexFiles,
          fakeVersionChange: fakeChange || undefined,
        },
        // What the start waited on (deploys, landing-path landings, disk, usage, freeze).
        startWaits: startWaits.map(({ shape, ...w }) => w),
        // Every Convex deploy run that overlapped the batch (lead 2026-11-09: void only cells that
        // overlap a deploy which changed the landing path; such a change voids via `changes`).
        deploys: await deploysDuring(config, start.at, end.at),
        cells,
        runner,
        voided,
        // Every cell crashed before any agent ran: not an attempt (plan.mjs nextBatch).
        setupOnly: cells.length > 0 && cells.every(c => c.setupCrash),
      };
      writeFileSync(join(dir, 'batch.json'), JSON.stringify(result, null, 1) + '\n', { flag: 'wx' });
      say(
        `BATCH ${b.key} attempt ${attempt} ${voided.length ? `VOID${result.setupOnly ? ' (setup only: no agent ran, not counted as an attempt)' : ''} ${voided.join(' | ').slice(0, 600)}` : 'ok'}`,
      );
      return result;
    }
  }

  /** Run the batches in plan order; a void batch is re-run before the next one starts. */
  async function runInOrder(list) {
    for (;;) {
      const history = [];
      for (const b of list) history.push((await attempts(b.key)).map(attemptState));
      const i = nextBatch(history);
      if (i < 0) return;
      await runBatch(list[i], history[i].length + 1);
    }
  }
  const valid = async key => {
    const ok = (await attempts(key)).filter(r => !isVoid(r)).at(-1);
    if (!ok) return null;
    return Object.fromEntries(ok.cells.map(c => [c.arm, readJson(join(runs, c.cellId, 'result.json'))]));
  };

  if (coordination) {
    const c = only && parseCoordinationKey(only);
    if (only && !c) throw Error('--only convoy|overlap-n<N>-r<rep>');
    if (c) await runBatch(coordinationBatch(c.kind, c.N, c.rep), (await attempts(only)).length + 1);
    else
      await runInOrder(
        coordinationBatches(Array.from({ length: Math.min(reps, DESIGN.reps) }, (_, i) => i + 1)),
      );
    say('ALL DONE coordination');
    return;
  }
  if (only) {
    const [, N, rep, x] = only.match(/^n(\d+)-r(\d+)(x?)$/) ?? [];
    if (!N) throw Error('--only n<N>-r<rep>[x]');
    const b = (x ? extraBatch : planBatch)(ids, Number(N), Number(rep));
    await runBatch(b, (await attempts(only)).length + 1);
    return;
  }
  const base = planBatches(
    ids,
    Array.from({ length: Math.min(reps, DESIGN.reps) }, (_, i) => i + 1),
  );
  await runInOrder(base);
  if (reps >= DESIGN.reps) {
    const third = [];
    for (const N of repNs(3)) {
      const file = join(B, `rep3-n${N}${suffix}.json`);
      if (!existsSync(file)) {
        const d = rep3Decision(await valid(`n${N}-r1`), await valid(`n${N}-r2`));
        writeFileSync(
          file,
          JSON.stringify({ N, decidedAt: new Date().toISOString(), ...d }, null, 1) + '\n',
          {
            flag: 'wx',
          },
        );
        say(`REP3 N=${N} ${d.run ? 'RUN' : 'skip'}${d.reasons.length ? `: ${d.reasons.join('; ')}` : ''}`);
      }
      if (readJson(file).run) third.push(planBatch(ids, N, 3));
    }
    await runInOrder(third);
  }
  // Outlier rule (plan.mjs outlierDecision), once all regular reps ran: decided once per N
  // from the valid reps 1-3, written to outlier-n<N>.json, then the extra batches (same seed
  // and order) in N-descending order. Extra batches are never judged again: exactly one each.
  const extras = [];
  if (reps >= DESIGN.reps)
    for (const N of repNs(3)) {
      const file = join(B, `outlier-n${N}${suffix}.json`);
      if (!existsSync(file)) {
        const byRep = {};
        for (let rep = 1; rep <= DESIGN.maxReps; rep++) {
          const v = await valid(`n${N}-r${rep}`);
          if (v) byRep[rep] = v;
        }
        const d = outlierDecision(byRep);
        writeFileSync(
          file,
          JSON.stringify(
            { N, decidedAt: new Date().toISOString(), factor: DESIGN.outlierFactor, ...d },
            null,
            1,
          ) + '\n',
          { flag: 'wx' },
        );
        say(
          `OUTLIER N=${N} ${d.extraReps.length ? `EXTRA rep ${d.extraReps.join(',')}: ${d.outliers.map(o => o.reason).join('; ')}` : 'none'}`,
        );
      }
      for (const rep of readJson(file).extraReps) extras.push(extraBatch(ids, N, rep));
    }
  await runInOrder(extras);
  const all = [
    ...base,
    ...repNs(3).map(N => planBatch(ids, N, 3)),
    ...DESIGN.ns.flatMap(N => [1, 2, 3].map(rep => extraBatch(ids, N, rep))),
  ];
  const summary = [];
  for (const b of all) {
    const a = await attempts(b.key);
    if (a.length) summary.push(`${b.key}:${a.some(r => !isVoid(r)) ? 'ok' : 'void'}x${a.length}`);
  }
  say(`ALL DONE ${summary.join(' ')}`);
}
