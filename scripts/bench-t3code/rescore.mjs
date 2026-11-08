// SPDX-License-Identifier: Apache-2.0
// Re-score a finished Forge cell from its relay call log, through the same arm.landing ->
// score.mjs path run-cell uses live (no waiting: the cell is over).
// Usage: node scripts/bench-t3code/rescore.mjs CELL_ID "why"
// Keeps the original as result.before-rescore.json.
//        node scripts/bench-t3code/rescore.mjs --contamination CELL_ID... [--out FILE]
// re-runs only the contamination audit with the current rules, read-only on BENCH_ROOT
// (rescan-contamination.mjs).
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { benchRootOrExit } from './bench-root.mjs';
import { forgeArm } from './forge-arm.mjs';
import { landingFields, cellSummary } from './score.mjs';

if (process.argv[2] === '--contamination') {
  (await import('./rescan-contamination.mjs')).main(process.argv.slice(3));
  process.exit(0);
}
const [cellId, reason] = process.argv.slice(2);
if (!cellId || !reason) throw Error('usage: rescore.mjs CELL_ID "why"');
const B = benchRootOrExit();
const config = JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
const dir = join(B, 'runs', cellId);
const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
if (result.arm !== 'forge') throw Error('rescore is for Forge cells');
if (existsSync(join(B, 'ws', cellId))) throw Error('cell workspace still exists: is the cell running?');
const ws = join(B, 'ws', `rescore-${cellId}`);
mkdirSync(ws, { recursive: true });
const forge = forgeArm(config.forge, { callLog: join(dir, 'nforge-calls.jsonl'), ws });
const records = [];
try {
  for (const record of result.records)
    records.push({
      ...record,
      ...landingFields(
        await forge.landing(record.task, record.laneId, { deadlineMs: 0 }),
        Date.parse(record.dispatchedAt),
      ),
    });
} finally {
  rmSync(ws, { recursive: true, force: true });
}
if (!existsSync(join(dir, 'result.before-rescore.json')))
  copyFileSync(join(dir, 'result.json'), join(dir, 'result.before-rescore.json'));
const rescored = {
  ...result,
  ...cellSummary(records, result.tasks, Date.parse(result.startedAt)),
  records,
  rescore: { at: new Date().toISOString(), reason },
};
writeFileSync(join(dir, 'result.json'), JSON.stringify(rescored, null, 1) + '\n');
console.log(
  JSON.stringify({
    cellId,
    landed: rescored.landed,
    tasks: rescored.tasks,
    wallSeconds: rescored.wallSecondsToAllLanded,
  }),
);
