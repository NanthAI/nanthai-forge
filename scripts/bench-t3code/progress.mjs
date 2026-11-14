#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// One finite, read-only snapshot. Never imports the live driver, config, credentials or IO.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { benchRoot, benchRootOrExit } from './bench-root.mjs';
import { DESIGN, batches, batch, extraBatch, nextBatch, SETUP_ONLY } from './plan.mjs';
import { coordinationBatches } from './cells.mjs';

const seconds = (start, end) => {
  const elapsed = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
};
const average = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const group = c => `${c.kind ?? 'scored'} ${c.slot ?? c.arm} N=${c.N}`;
const safeName = name => typeof name === 'string' && /^[\w.-]+$/.test(name) && name !== '.' && name !== '..';

/** Reads only named metadata/result files directly under root, runs/ and batches/.
 * Parse failures during write-once publication are disclosed, never treated as scored. */
export function benchProgress({ root = benchRoot(), now = new Date().toISOString() } = {}) {
  let bytesRead = 0,
    filesRead = 0;
  const unreadable = [];
  const regular = path => {
    try {
      return lstatSync(path).isFile();
    } catch {
      return false;
    }
  };
  const directories = path => {
    try {
      if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) return [];
      return readdirSync(path, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
        .sort();
    } catch {
      return [];
    }
  };
  const read = (...parts) => {
    const path = join(root, ...parts);
    if (!regular(path)) return null; // never follow a file symlink
    try {
      const bytes = readFileSync(path);
      bytesRead += bytes.length;
      filesRead++;
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      unreadable.push(parts.join('/'));
      return null;
    }
  };
  const planned = batches([]);
  let pendingDecisions = 0;
  for (const N of DESIGN.ns) {
    const third = read(`rep3-n${N}.json`),
      outlier = read(`outlier-n${N}.json`);
    if (!third) pendingDecisions++;
    if (!outlier) pendingDecisions++;
    if (third?.run) planned.push(batch([], N, 3));
    for (const rep of outlier?.extraReps ?? []) planned.push(extraBatch([], N, rep));
  }
  planned.push(...coordinationBatches());
  const driver = read('drive-progress.json');
  const batchDirectories = directories(join(root, 'batches')).filter(d => !d.includes('-dry-'));
  const batchResults = batchDirectories
    .map(d => {
      const b = read('batches', d, 'batch.json');
      if (!b || b.dry || b.diagnostic) return null;
      return {
        key: b.key,
        attempt: b.attempt,
        cells: b.cells,
        voided: b.voided,
        setupOnly: b.setupOnly,
        startWaits: b.startWaits,
      };
    })
    .filter(Boolean);
  const results = new Map(),
    current = [];
  for (const directory of directories(join(root, 'runs'))) {
    if (/-dry-|-modelcheck-/.test(directory)) continue;
    const result = read('runs', directory, 'result.json');
    if (result && !result.dry && !result.modelCheck && !result.diagnostic)
      results.set(directory, {
        key: result.key,
        attempt: result.attempt,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        refused: result.refused,
        crashed: result.crashed,
        interrupted: result.interrupted,
        voided: result.voided,
        taskVoids: result.taskVoids?.length ?? 0,
        failed:
          (result.records ?? []).some(t => t.harnessError || t.landing?.landed === false) ||
          (result.oracle?.grade?.strictSuccess != null &&
            result.tasks != null &&
            result.oracle.grade.strictSuccess < result.tasks),
      });
    else if (!result) {
      const cell = read('runs', directory, 'cell.json');
      if (cell && !cell.dry && !cell.modelCheck && !cell.diagnostic)
        current.push({
          cellId: directory,
          key: cell.key,
          elapsedSeconds: seconds(cell.startedAt, now),
        });
    }
  }
  const rows = new Map(),
    durations = new Map(),
    finishedDurations = [];
  const addDuration = (key, duration) => {
    if (duration == null) return;
    if (!durations.has(key)) durations.set(key, []);
    durations.get(key).push(duration);
    finishedDurations.push(duration);
  };
  let done = 0,
    remainingSeconds = 0,
    unknownEta = false;
  for (const b of planned) {
    const history = batchResults.filter(r => r.key === b.key).sort((a, z) => a.attempt - z.attempt);
    for (const c of b.cells)
      for (const r of results.values())
        if (r.key === c.key) addDuration(group(c), seconds(r.startedAt, r.endedAt));
    const settled =
      nextBatch([history.map(r => (r.voided?.length ? (r.setupOnly ? SETUP_ONLY : true) : false))]) < 0;
    const latest = history.find(r => !r.voided?.length) ?? history.at(-1);
    for (const c of b.cells) {
      const key = group(c);
      if (!rows.has(key)) rows.set(key, { group: key, done: 0, total: 0, valid: 0 });
      const row = rows.get(key);
      row.total++;
      if (settled) {
        row.done++;
        done++;
      }
      const slot = latest?.cells?.find(r => r.key === c.key);
      const r = slot && safeName(slot.cellId) ? results.get(slot.cellId) : null;
      if (settled && latest && !latest.voided?.length && r && !r.voided?.length && !r.refused) row.valid++;
    }
  }
  // Estimate each remaining batch in its registered concurrency mode. Unfinished decisions,
  // future retries, setup overhead and gate waits cannot be predicted from finished cells.
  const fallback = average(finishedDurations);
  for (const b of planned) {
    const history = batchResults.filter(r => r.key === b.key);
    if (nextBatch([history.map(r => (r.voided?.length ? (r.setupOnly ? SETUP_ONLY : true) : false))]) < 0)
      continue;
    const outstanding = b.cells.map(c => {
      const completed = [...results.values()].some(
        r =>
          r.key === c.key &&
          r.attempt > Math.max(0, ...history.map(h => h.attempt)) &&
          batchDirectories.includes(`${b.key}-a${r.attempt}`),
      );
      if (completed) return 0;
      const estimate = average(durations.get(group(c)) ?? []) ?? fallback;
      if (estimate == null) {
        unknownEta = true;
        return 0;
      }
      const active = current.find(r => r.key === c.key);
      return Math.max(0, estimate - (active?.elapsedSeconds ?? 0));
    });
    remainingSeconds +=
      b.mode === 'concurrent' ? Math.max(...outstanding) : outstanding.reduce((a, z) => a + z, 0);
  }
  const all = [...results.values()];
  const voids = all.filter(r => r.voided?.length);
  const failures = all.filter(r => r.refused || r.crashed || r.interrupted || r.failed);
  const batchVoids = batchResults.filter(b => b.voided?.length);
  const waits = batchResults.flatMap(b =>
    (b.startWaits ?? []).map(w => ({ batch: b.key, reason: w.line, first: w.first, last: w.last })),
  );
  return {
    at: now,
    done,
    total: planned.reduce((n, b) => n + b.cells.length, 0),
    rows: [...rows.values()],
    driver: driver ? { status: driver.status, at: driver.at, line: driver.line } : null,
    current,
    wait: driver?.status === 'running' && driver.line?.startsWith('WAIT') ? driver.line : null,
    waits,
    voids: voids.map(r => ({ key: r.key, reasons: r.voided })),
    batchVoids: batchVoids.map(b => ({ key: b.key, reasons: b.voided })),
    failures: failures.map(r => ({
      key: r.key,
      reason:
        r.refused ??
        r.crashed ??
        (r.interrupted ? 'interrupted' : 'task did not land, grading failed or harness error'),
    })),
    taskVoids: all.reduce((n, r) => n + (r.taskVoids ?? 0), 0),
    etaSeconds: unknownEta ? null : remainingSeconds,
    pendingDecisions,
    bytesRead,
    filesRead,
    unreadable,
  };
}

const duration = value => (value == null ? 'unknown' : `${Math.round(value)}s`);
export function formatProgress(p) {
  return [
    `BENCH ${p.done}/${p.total} cells settled; driver ${p.driver?.status ?? 'not recorded'} (last record ${p.driver?.at ?? 'none'})`,
    ...p.rows.map(r => `${r.group}: ${r.done}/${r.total} done (${r.valid} valid)`),
    ...p.current.map(c => `CURRENT ${c.key}: elapsed ${duration(c.elapsedSeconds)} (last recorded start)`),
    ...(p.wait ? [`${p.wait}`] : []),
    ...p.waits.map(w => `PAST WAIT ${w.batch}: ${w.reason}`),
    `VOIDS ${p.voids.length} cells, ${p.batchVoids.length} batches, ${p.taskVoids} tasks; FAILURES ${p.failures.length} cells`,
    ...p.voids.map(v => `VOID ${v.key}: ${v.reasons.join('; ')}`),
    ...p.batchVoids.map(v => `VOID BATCH ${v.key}: ${v.reasons.join('; ')}`),
    ...p.failures.map(f => `FAIL ${f.key}: ${f.reason}`),
    `ETA ${duration(p.etaSeconds)} for decided schedule; ${p.pendingDecisions} rep-3/outlier decisions pending; excludes future retries and waits`,
    `READ ${p.bytesRead} bytes in ${p.filesRead} files; unreadable/in-progress ${p.unreadable.length}`,
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = benchRootOrExit();
  const progress = benchProgress({ root });
  console.log(process.argv.includes('--json') ? JSON.stringify(progress, null, 1) : formatProgress(progress));
}
