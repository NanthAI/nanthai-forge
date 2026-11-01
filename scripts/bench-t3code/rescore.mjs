// Re-score a finished Forge cell from its agents' recorded nforge output, through the
// same arm.recordLandOps -> arm.landing -> score.mjs path run-cell uses live.
// Usage: node scripts/bench-t3code/rescore.mjs CELL_ID "why"
// Keeps the original as result.before-rescore.json.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { forgeArm } from './forge-arm.mjs';
import { landingFields, cellSummary } from './score.mjs';

const [cellId, reason] = process.argv.slice(2);
if (!cellId || !reason) throw Error('usage: rescore.mjs CELL_ID "why"');
const B = process.env.BENCH_ROOT || join(homedir(), 'NanthAI/forge-bench/b15d');
const config = JSON.parse(readFileSync(join(B, 'config.json'), 'utf8'));
const dir = join(B, 'runs', cellId);
const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
if (result.arm !== 'forge') throw Error('rescore is for Forge cells');
if (existsSync(join(B, 'ws', cellId))) throw Error('cell workspace still exists: is the cell running?');
const forge = forgeArm(config.forge);
const ws = join(B, 'ws', cellId);
const records = result.records.map(record => {
  const root = join(ws, record.task);
  const output = ['stdout.json', 'stderr.txt']
    .map(ext => join(dir, 'agents', `${record.task}.${ext}`))
    .filter(existsSync)
    .map(file => readFileSync(file, 'utf8'))
    .join('\n');
  // landing() addresses the project explicitly; an empty directory stands in for the
  // deleted workspace, as the harness's anchor does.
  mkdirSync(root, { recursive: true });
  forge.recordLandOps(root, output);
  try {
    return {
      ...record,
      ...landingFields(forge.landing(root, record.laneId), Date.parse(record.dispatchedAt)),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
try {
  rmdirSync(ws); // only the empty stand-in parent; never a live cell's workspace
} catch {}
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
    perTask: records.map(r => [
      r.task,
      r.landing.landed,
      r.landing.receiptId ?? r.landing.state,
      r.timeToMainSeconds,
    ]),
  }),
);
