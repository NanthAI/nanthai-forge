// SPDX-License-Identifier: Apache-2.0
// Re-run the contamination audit over finished cells with the current rules (e7e7428c): the
// same inputs run-cell gave scanTask, rebuilt from a cell's result.json, kept transcripts and
// relay call log. Read-only on BENCH_ROOT: nothing there is written; the comparison goes to
// stdout, or to --out FILE (outside BENCH_ROOT).
// Usage: node scripts/bench-t3code/rescore.mjs --contamination CELL_ID... [--out FILE]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { benchRootOrExit } from './bench-root.mjs';
import { scanTask } from './contamination.mjs';
import { readCalls } from './forge-arm.mjs';
import { repository } from './github-arm.mjs';
import { loadTasks } from './plan.mjs';
import { readSession } from './transcripts.mjs';

/** The old and the new verdict of every task of one cell. */
export function rescanCell(B, cellId, tasks) {
  const dir = join(B, 'runs', cellId);
  const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  if (!Array.isArray(result.records)) return []; // refused or crashed before any task: nothing scored
  const calls = result.arm === 'forge' ? readCalls(join(dir, 'nforge-calls.jsonl')) : [];
  const ws = join(B, 'ws', cellId);
  const rows = [];
  for (const r of result.records) {
    const old = result.contamination?.[r.task] ?? {};
    const scan = scanTask({
      session: readSession(join(dir, 'agents', r.task)),
      calls: calls.filter(c => c.task === r.task),
      ownIds: new Set([r.laneId].filter(Boolean)),
      prNumbers: tasks.map(t => t.pr),
      mergeShas: tasks.map(t => t.mergeCommit),
      ownPrs: r.landing?.prs ?? [],
      workspace: join(ws, r.task),
      ownRepo: result.arm === 'github' ? repository : null,
      ownBranches: [r.branch].filter(Boolean),
      toolPaths: [join(ws, 'bin'), join(ws, 'vp'), join(ws, 'hub'), join(B, 'deps')],
      benchRoot: B,
    });
    const ids = hits => [...new Set(hits.map(h => h.id))];
    rows.push({
      cell: cellId,
      task: r.task,
      oldVoid: Boolean(old.void),
      newVoid: scan.void,
      oldHits: ids(old.hits ?? []),
      newHits: ids(scan.hits),
      newExcerpts: scan.hits.map(h => `${h.id}: ${h.excerpt}`.slice(0, 220)),
    });
  }
  return rows;
}

export function main(args) {
  const B = benchRootOrExit();
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args[outAt + 1] : null;
  const cells = outAt >= 0 ? args.filter((_, i) => i !== outAt && i !== outAt + 1) : args;
  if (!cells.length) throw Error('usage: rescore.mjs --contamination CELL_ID... [--out FILE]');
  if (out && (!isAbsolute(out) || !relative(B, out).startsWith('..')))
    throw Error('--out must be an absolute path outside BENCH_ROOT (the rescan is read-only there)');
  const tasks = loadTasks(B);
  const rows = cells.flatMap(cell => rescanCell(B, cell, tasks));
  const report = {
    rows,
    cleared: rows.filter(r => r.oldVoid && !r.newVoid).map(r => `${r.cell}/${r.task}`),
    stillVoid: rows.filter(r => r.newVoid).map(r => `${r.cell}/${r.task}`),
    newlyVoid: rows.filter(r => !r.oldVoid && r.newVoid).map(r => `${r.cell}/${r.task}`),
  };
  if (out) writeFileSync(out, JSON.stringify(report, null, 1) + '\n');
  console.log(
    JSON.stringify(
      { ...report, rows: rows.filter(r => r.oldVoid || r.newVoid).map(({ newExcerpts, ...r }) => r) },
      null,
      1,
    ),
  );
}
