// SPDX-License-Identifier: Apache-2.0
// Read-only replay: retained source is parsed as data, never imported or executed.
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { sourceFiles, standardSelection } from './test-impact.mjs';
import { testImportGraph } from './test-import-graph.mjs';
import { shardDuration } from './test-shards.mjs';

export function retainedDurations(text, tests) {
  const selected = new Set(tests),
    durations = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('__FORGE_TESTS__');
    if (at < 0) continue;
    try {
      const item = JSON.parse(line.slice(at + '__FORGE_TESTS__'.length));
      if (
        selected.has(item.file) &&
        item.complete === true &&
        Number.isFinite(item.durationMs) &&
        item.durationMs > 0
      )
        durations[item.file] = item.durationMs;
    } catch {
      /* Truncated machine report is not timing evidence. */
    }
  }
  return durations;
}

export function literalConsumers(graph, paths, kinds) {
  if (graph.error) return null;
  const queue = [...paths],
    seen = new Set(queue);
  for (let i = 0; i < queue.length; i++)
    for (const importer of graph.reverse.get(queue[i]) ?? []) {
      if (seen.has(importer) || !kinds.includes(graph.evidence.get(queue[i]).get(importer).kind)) continue;
      seen.add(importer);
      queue.push(importer);
    }
  return [...seen].filter(path => /^tests\/[^/]+\.test\.mjs$/.test(path)).sort();
}

export function replaySelection(directory, fallbackDurations = {}) {
  const read = name => JSON.parse(readFileSync(join(directory, name), 'utf8'));
  const comparison = read('changes.json'),
    before = read('selection.json'),
    plan = read('modal-plan.json');
  const files = sourceFiles(join(directory, 'modal-source'));
  const after = standardSelection({ ...comparison, files, env: { FORGE_CHECK_SCOPED: '1' } });
  const graph = testImportGraph(files);
  const modules = comparison.paths.filter(path => /^(?:src|web\/src|convex|netlify)\//.test(path));
  const ownDurations = retainedDurations(readFileSync(join(directory, 'stdout.log'), 'utf8'), before.tests);
  const durations = { ...fallbackDurations, ...ownDurations };
  const groups = plan.groups ?? [],
    workers = 2;
  const selected = new Set(after.tests);
  const newGroups = groups.map(group => group.filter(file => selected.has(file)));
  const retained = new Set(newGroups.flat());
  for (const file of after.tests.filter(file => !retained.has(file))) {
    if (!newGroups.length) newGroups.push([]);
    const costs = newGroups.map(group => shardDuration(group, durations, workers));
    newGroups[costs.indexOf(Math.min(...costs))].push(file);
  }
  const minutes = value => Math.round(value / 600) / 100;
  const beforeMs = groups.reduce((sum, group) => sum + shardDuration(group, durations, workers), 0);
  const afterMs = newGroups.reduce((sum, group) => sum + shardDuration(group, durations, workers), 0);
  const missing = [...new Set([...before.tests, ...after.tests])].filter(file => !durations[file]);
  const reasons = {};
  for (const reason of Object.values(after.reasons ?? {}))
    reasons[reason.kind] = (reasons[reason.kind] ?? 0) + 1;
  return {
    run: basename(directory),
    base: comparison.base,
    head: comparison.head,
    before: before.tests.length,
    after: after.tests.length,
    scope: after.scope,
    staticImportConsumers: literalConsumers(graph, modules, ['import'])?.length ?? null,
    literalRuntimeConsumers:
      literalConsumers(graph, modules, ['import', 'runtime-path', 'package-command'])?.length ?? null,
    reasons,
    removed: before.tests.filter(file => !after.tests.includes(file)),
    added: after.tests.filter(file => !before.tests.includes(file)),
    estimatedShardMinutes: {
      before: minutes(beforeMs),
      after: minutes(afterMs),
      saved: minutes(beforeMs - afterMs),
      shards: groups.length,
      workers,
      ownTimingFiles: Object.keys(ownDurations).length,
      missingTimingFiles: missing.length,
      basis:
        'FIFO simulation of retained file durations, retained shard membership/order minus removed files, additions appended; excludes static/build/startup/retry costs',
    },
    selection: after,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directories = process.argv.slice(2);
  if (!directories.length) throw new Error('Expected retained check directories (read-only).');
  const pooled = {};
  // Older reports first, so the newest complete per-file observation wins.
  for (const directory of [...directories].reverse()) {
    const selection = JSON.parse(readFileSync(join(directory, 'selection.json'), 'utf8'));
    Object.assign(
      pooled,
      retainedDurations(readFileSync(join(directory, 'stdout.log'), 'utf8'), selection.tests),
    );
  }
  const timingDigest = createHash('sha256')
    .update(JSON.stringify(Object.entries(pooled).sort()))
    .digest('hex');
  for (const directory of directories) {
    const { selection, ...report } = replaySelection(directory, pooled);
    console.log(JSON.stringify({ ...report, timingDigest }));
  }
}
