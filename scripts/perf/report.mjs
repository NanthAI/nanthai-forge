// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export const budgets = { now: 1500, work: 1500, laneFirstDiff: 1000, oneFilePush: 3000 };

export async function runtimeBuildHash(directory) {
  const hash = createHash('sha256');
  const files = (await readdir(directory)).filter(name => name.endsWith('.js')).sort();
  if (!files.length) throw new Error('PERF_BUILD_UNAVAILABLE');
  for (const name of files) hash.update(name).update(await readFile(join(directory, name)));
  return hash.digest('hex');
}

export function measurement(name, samples, reason) {
  const budgetMs = budgets[name] ?? null;
  const valid = samples.length && samples.every(s => Number.isFinite(s.durationMs) && s.durationMs >= 0);
  const sorted = valid ? samples.map(s => s.durationMs).sort((a, b) => a - b) : [];
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length ? (sorted[middle] + sorted[Math.floor((sorted.length - 1) / 2)]) / 2 : null;
  return {
    budgetMs,
    status: !valid
      ? samples.length
        ? 'failed'
        : 'unrun'
      : budgetMs === null || medianMs <= budgetMs
        ? 'pass'
        : 'fail',
    medianMs,
    samples,
    ...(reason ? { reason } : {}),
  };
}

/** Static-import closure only. Dynamic route/worker chunks are counted in totals, not eager bytes. */
export function eagerFiles(manifest, roots) {
  const visited = new Set(),
    files = new Set();
  function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const row = manifest[key];
    if (!row) throw new Error('PERF_MANIFEST_ENTRY');
    files.add(row.file);
    for (const path of row.css ?? []) files.add(path);
    for (const dependency of row.imports ?? []) visit(dependency);
  }
  for (const root of roots) visit(root);
  return [...files].sort();
}

export async function bundleSummary(directory) {
  const manifest = JSON.parse(await readFile(join(directory, '.vite/manifest.json'), 'utf8'));
  const files = [];
  for (const name of (await readdir(join(directory, 'assets'))).sort()) {
    const bytes = await readFile(join(directory, 'assets', name));
    files.push({ file: `assets/${name}`, bytes: bytes.length, gzipBytes: gzipSync(bytes).length });
  }
  const roots = ['index.html', manifest['src/Hosted.tsx'] ? 'src/Hosted.tsx' : 'src/shell/LocalApp.tsx'];
  const eager = new Set(eagerFiles(manifest, roots));
  const sum = (selected, key) => selected.reduce((total, file) => total + file[key], 0);
  const js = files.filter(f => f.file.endsWith('.js'));
  const eagerJs = js.filter(f => eager.has(f.file));
  return {
    buildHash: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    jsBytes: sum(js, 'bytes'),
    jsGzipBytes: sum(js, 'gzipBytes'),
    eagerJsBytes: sum(eagerJs, 'bytes'),
    eagerJsGzipBytes: sum(eagerJs, 'gzipBytes'),
    largestJsBytes: Math.max(0, ...js.map(f => f.bytes)),
    eagerFiles: [...eager],
    files,
  };
}

const elapsed = (start, end) => {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

/** Read recorded evidence only. No command is run and no Work record is changed. */
export function landingTiming(data, landingId) {
  const move = data.channelMoves
    .filter(m => m.status === 'accepted' && (landingId ? m.id === landingId : m.channel === 'main'))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const view = data.views.find(v => v.id === move?.viewId && v.head === move?.head);
  const intent = data.intents.find(i => i.id === view?.intentId);
  if (!move || !view || !intent)
    return { status: 'unrun', reason: 'Accepted landing, exact View or parent Intent is unavailable.' };
  const runs = data.runs
    .filter(r => r.viewId === view.id && r.head === view.head)
    .map(r => ({
      id: r.id,
      status: r.status,
      queuedAt: r.queuedAt ?? null,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
      queueMs: elapsed(r.queuedAt, r.startedAt),
      runMs: elapsed(r.startedAt, r.endedAt),
    }));
  return {
    status: elapsed(intent.createdAt, move.at) === null ? 'failed' : 'recorded',
    landingId: move.id,
    viewId: view.id,
    head: move.head,
    startedAt: intent.createdAt,
    acceptedAt: move.at,
    intentToAcceptMs: elapsed(intent.createdAt, move.at),
    composeToAcceptMs: elapsed(view.at, move.at),
    finishCommandMs: null,
    definition:
      'Full Intent lifetime through acceptance, including author time and waiting. Compose-to-accept and exact-View check times are separate; finish invocation time is not inferred.',
    runs,
  };
}
