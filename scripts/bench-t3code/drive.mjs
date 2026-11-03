#!/usr/bin/env node
// B1.5d driver: runs the PLAN.md batches end to end and resumes by itself.
//   node scripts/bench-t3code/drive.mjs [--dry] [--reps 1|2] [--only n3-r1] [--tasks K] [--unpinned]
//                                       [--fake-version-change]   (dry only: proves the batch guard)
// - Batch = both arms' cells of one (N, rep). N = 1, 3, 5: the two cells run at the same time
//   (2N agents); N = 10: one arm, then the other, the first arm alternating between reps.
//   Never more than DESIGN.maxAgents agents at once.
// - Order: rep 1 with N descending (10, 5, 3, 1), rep 2 ascending, then the rep-3 rule per N
//   (plan.mjs rep3Decision, written once to rep3-n<N>.json) and the selected rep-3 batches,
//   descending (plan.mjs repNs). A void batch is re-run once before the next batch starts, and
//   a resume continues at the same place (plan.mjs nextBatch). Every attempt is published.
// - Freeze: the batch holds forge-cli/.freeze from before its first cell starts until its last
//   cell is graded (lane.sh finish and nforge land wait meanwhile), and is released between
//   batches. Versions (CLI, GitHub main, deployed Convex, check workflows, harness, agent) are
//   recorded at batch start and end; any change voids the batch.
// - Resumable: a batch without batch.json whose driver is gone is closed as `interrupted`
//   (void, re-run once). Re-run the same command after any stop. One driver at a time.
// - Waits, never stops, on a usage window, a busy nanthai-forge or a gate refusal, printing one
//   CELL line per change for the lead's Monitor. Stops on the Convex budget.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
  rep3Decision,
  loadTasks,
} from './plan.mjs';
import { snapshot, snapshotProblems, differences, forgeInFlight, FREEZE } from './versions.mjs';
import { usageGate, usageProblems, diskFreeGb, diskNeed } from './gates.mjs';
import { agentOf } from './agent.mjs';
import { runnerFairness } from './runners.mjs';

const B = process.env.BENCH_ROOT || join(homedir(), 'NanthAI/forge-bench/b15d');
const flags = process.argv.slice(2);
const flag = name => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : null);
const dry = flags.includes('--dry');
const reps = Number(flag('--reps') ?? DESIGN.reps);
const only = flag('--only');
const fakeChange = dry && flags.includes('--fake-version-change');
// Convex list-price stop for the whole run (lead: report before going past $5).
export const BUDGET_USD = 5;
const CLI_UPDATE = join(homedir(), 'NanthAI/forge-phase5/agents/tools/cli-update.sh');
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

/** The batch guard: every version key, start vs end, plus the freeze itself. */
export function batchGuard(start, end, { unpinned = false } = {}) {
  const changes = differences(start, end, { unpinned });
  if (!end.freeze) changes.push('freeze file missing at batch end');
  return changes;
}

/** Freeze file written by a bench process whose pid is gone (left by a kill -9). */
export function staleBenchFreeze(text) {
  const pid = Number(String(text).match(/^bench (?:driver|cell)\b.*?(?:pid )?(\d+)\s*$/m)?.[1]);
  return pid > 0 && !alive(pid);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();

async function main() {
  const config = readJson(join(B, 'config.json'));
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
        for (const arm of DESIGN.arms) {
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

  /** Under the hold, wait until nanthai-forge has no workflow queued or running. */
  async function drain(key) {
    const until = Date.now() + DRAIN_MS;
    for (;;) {
      const inFlight = await forgeInFlight().catch(e => [{ name: `unreadable: ${e.message}` }]);
      if (!inFlight.length) return true;
      if (Date.now() > until) return false;
      say(
        `WAIT ${key}: holding; ${inFlight.length} nanthai-forge run(s) still in flight (${inFlight.map(x => x.workflowName ?? x.name).join(', ')})`,
      );
      await wait(Math.min(60_000, RETRY_MS));
    }
  }

  /** Start rules a batch checks before taking the hold. */
  async function batchRefusals(b) {
    const r = [];
    if (!dry) r.push(...usageProblems(usageGate(agentOf(config).provider)));
    const need = b.cells.reduce((sum, c) => sum + diskNeed(c.arm, b.N, dry).needGb, 0) + 15;
    const free = diskFreeGb();
    if (free < need) r.push(`disk ${free.toFixed(1)} GB free < ${need.toFixed(1)} GB for the batch`);
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
    for (;;) {
      const refusals = await batchRefusals(b);
      if (refusals.some(r => r.startsWith('STOP'))) {
        say(refusals.find(r => r.startsWith('STOP')));
        process.exit(2);
      }
      if (refusals.length) {
        say(`WAIT ${b.key}: ${refusals.join('; ')}; retry in ${RETRY_MS / 60_000} min`);
        await wait(RETRY_MS);
        continue;
      }
      // Hold first (new dogfood finishes wait), then let landings already submitted drain, so
      // a busy main cannot starve the batch.
      if (existsSync(FREEZE) && !readFileSync(FREEZE, 'utf8').includes(`pid ${process.pid}`)) {
        say(`WAIT ${b.key}: freeze held by someone else (${readFileSync(FREEZE, 'utf8').trim()})`);
        await wait(RETRY_MS);
        continue;
      }
      const hold = `bench driver batch ${b.key} pid ${process.pid}\n`;
      writeFileSync(FREEZE, hold);
      holding = true;
      const drained = await drain(b.key);
      if (!drained) {
        release();
        say(
          `WAIT ${b.key}: nanthai-forge did not drain within ${DRAIN_MS / 60_000} min under the hold; released, retry`,
        );
        await wait(RETRY_MS);
        continue;
      }
      // Bring the one CLI to main under the hold: the updater skips while .freeze exists, so
      // it is moved aside for the update only (a finish that slips in is caught below).
      let start = await snapshot(config);
      if (start.cli.commit !== start.githubMain) {
        renameSync(FREEZE, `${FREEZE}.batch`);
        await promisify(execFile)('bash', [CLI_UPDATE]).catch(() => {});
        renameSync(`${FREEZE}.batch`, FREEZE);
        if (!(await drain(b.key))) {
          release();
          continue;
        }
        start = await snapshot(config);
      }
      const sp = snapshotProblems(start, { requireFreeze: true });
      if (sp.length) {
        release();
        say(`WAIT ${b.key}: under the hold ${sp.join('; ')}; released, retry in ${RETRY_MS / 60_000} min`);
        await wait(RETRY_MS);
        continue;
      }
      mkdirSync(dir);
      writeFileSync(
        join(dir, 'driver.json'),
        JSON.stringify({ pid: process.pid, startedAt: start.at }) + '\n',
      );
      writeFileSync(join(dir, 'arms.json'), JSON.stringify(b.cells.map(c => c.arm)) + '\n');
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
        const idFile = join(dir, `${c.arm}.cell`);
        const cellId = existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : null;
        const r = cellId ? cellResult(cellId) : null;
        return {
          key: c.key,
          arm: c.arm,
          cellId,
          runner: r?.runner ?? null,
          refused: r?.refused ?? null,
          voided: r?.voided ?? ['no result'],
        };
      });
      const changes = batchGuard(start, end, { unpinned: dry && flags.includes('--unpinned') });
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
        versions: { start, end, changes, fakeVersionChange: fakeChange || undefined },
        cells,
        runner,
        voided,
      };
      writeFileSync(join(dir, 'batch.json'), JSON.stringify(result, null, 1) + '\n', { flag: 'wx' });
      say(
        `BATCH ${b.key} attempt ${attempt} ${voided.length ? `VOID ${voided.join(' | ').slice(0, 600)}` : 'ok'}`,
      );
      return result;
    }
  }

  /** Run the batches in plan order; a void batch is re-run before the next one starts. */
  async function runInOrder(list) {
    for (;;) {
      const history = [];
      for (const b of list) history.push((await attempts(b.key)).map(isVoid));
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

  if (only) {
    const [, N, rep] = only.match(/^n(\d+)-r(\d+)$/) ?? [];
    if (!N) throw Error('--only n<N>-r<rep>');
    await runBatch(planBatch(ids, Number(N), Number(rep)), (await attempts(only)).length + 1);
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
  const all = [...base, ...repNs(3).map(N => planBatch(ids, N, 3))];
  const summary = [];
  for (const b of all) {
    const a = await attempts(b.key);
    if (a.length) summary.push(`${b.key}:${a.some(r => !isVoid(r)) ? 'ok' : 'void'}x${a.length}`);
  }
  say(`ALL DONE ${summary.join(' ')}`);
}
