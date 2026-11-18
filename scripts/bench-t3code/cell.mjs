#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// One cell, with the automatic infrastructure rerun (Item 368ac54f, guard 5). Same arguments as
// run-cell.mjs (any --attempt is replaced):
//   BENCH_ROOT=... node scripts/bench-t3code/cell.mjs forge 10 1 --dry --scenario withdraw-join
// Run one cell per background command, with the runner's maximum timeout. A cell stopped from
// outside (signal, runner limit, process gone) is void-infrastructure, not crashed, and is rerun
// once: here at once when this runner survived, or by the next identical command when the runner
// limit stopped this one too (its attempts are kept in runs/.cell-commands/<key>/). Two
// infrastructure stops in a row are reported and not rerun again.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { benchRootOrExit } from './bench-root.mjs';
import { executeStage } from './run.mjs';
import { cellOutcome, orphanResult, rerunDecision } from './cell-outcome.mjs';

/** The command's identity: its run-cell arguments without --attempt. */
export function commandKey(args) {
  const kept = args.filter((a, i) => a !== '--attempt' && args[i - 1] !== '--attempt');
  return { kept, key: createHash('sha256').update(JSON.stringify(kept)).digest('hex').slice(0, 16) };
}

const alivePid = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Results of this command's attempts, oldest first; a gone process without a result is closed
 * here as void-infrastructure (write-once, as drive.mjs does). */
export function readAttempts(root, ledger, { alive = alivePid } = {}) {
  if (!existsSync(ledger)) return [];
  return readdirSync(ledger)
    .filter(f => /^a\d+\.cell$/.test(f))
    .sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5)))
    .flatMap(f => {
      const cellId = readFileSync(join(ledger, f), 'utf8').trim();
      if (!cellId) return [];
      const dir = join(root, 'runs', cellId),
        file = join(dir, 'result.json');
      if (existsSync(file)) return [JSON.parse(readFileSync(file, 'utf8'))];
      if (!existsSync(join(dir, 'cell.json'))) return [];
      const { pid, key } = JSON.parse(readFileSync(join(dir, 'cell.json'), 'utf8'));
      if (alive(pid)) throw Error(`BENCH_CELL_RUNNING: ${cellId} is still running (pid ${pid})`);
      const closed = orphanResult({ cellId, key });
      writeFileSync(file, JSON.stringify(closed, null, 1) + '\n', { flag: 'wx' });
      return [closed];
    });
}

/** Run one attempt, then the one automatic rerun when it (or the previous command's last attempt)
 * ended void-infrastructure. Returns run-cell's exit code of the last attempt. */
export async function runCell(args, { root, execute = executeStage, log = console.log, alive } = {}) {
  const { kept, key } = commandKey(args);
  const ledger = join(root, 'runs', '.cell-commands', key);
  mkdirSync(ledger, { recursive: true });
  let attempts = readAttempts(root, ledger, { alive });
  const pending = rerunDecision(attempts);
  if (pending.rerun) log(`CELL rerun of ${pending.rerunOf} (void-infrastructure, rerun once)`);
  for (;;) {
    const k = readdirSync(ledger).filter(f => /^a\d+\.cell$/.test(f)).length + 1;
    const code = await execute('run-cell.mjs', [...kept, '--attempt', String(k)], {
      root,
      env: { BENCH_CELL_ID_OUT: join(ledger, `a${k}.cell`) },
    });
    attempts = readAttempts(root, ledger, { alive });
    const last = attempts.at(-1);
    log(
      `CELL ${last?.cellId ?? 'none'} ${cellOutcome(last)}${last?.voided?.length ? `: ${last.voided[0]}` : ''}`,
    );
    const next = rerunDecision(attempts);
    if (!next.rerun) {
      if (next.reason) log(`CELL STOP ${next.reason}`);
      return code;
    }
    log(`CELL rerun of ${next.rerunOf} (void-infrastructure, rerun once)`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await runCell(process.argv.slice(2), { root: benchRootOrExit() });
}
