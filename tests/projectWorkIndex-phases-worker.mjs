// SPDX-License-Identifier: Apache-2.0
import { readFileSync, writeFileSync } from 'node:fs';
import { progressFixture } from './projectWorkIndex-progress-fixture.mjs';
const sourcePins =
  process.argv[2] === 'action' ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : undefined;
const f = progressFixture(1, undefined, undefined, {
  treeFiles: 3000,
  recipes: true,
  journal: 5000,
  objects: 32000,
  sourcePins,
  consumerOnly: process.argv[2] === 'action',
});
if (process.argv[2] === 'fixture') {
  writeFileSync(process.argv[3], JSON.stringify(f.sourcePins));
  process.exit(0);
}
if (process.argv[2] === 'action') {
  // Measure one resumed coordinator action separately: the full fake database
  // remains outside a real action but otherwise accumulates in this harness.
  const { makeFunctionReference } = await import('convex/server');
  await f.s.ctx.runMutation(makeFunctionReference('projectWorkIndexStore:begin'), {
    projectId: 'project',
    owner: 'owner',
    backupId: 'backup',
    revision: f.data.revision + 5000,
    initialRevision: f.data.revision,
    metadata: JSON.stringify({
      schema: f.data.schema,
      counts: {},
      sourceHead: f.data.nativeHead,
      sourceKind: 'native',
      sourceTransport: 'objects',
      initialRevision: f.data.revision,
    }),
    cursor: JSON.stringify({ phase: 'summaries', field: 0, record: 403, source: 2495 }),
  });
  global.gc?.();
  const baseline = { ...process.memoryUsage(), maxRssBytes: process.resourceUsage().maxRSS * 1024 };
  const started = performance.now();
  const result = await f.drive();
  console.log(
    `ACTION_RESULT ${JSON.stringify({
      pending: result.pending,
      baseline,
      memory: process.memoryUsage(),
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      elapsedMs: performance.now() - started,
      maxSourceWindowBytes: f.metrics.maxSourceWindowBytes,
    })}`,
  );
  process.exit(0);
}
const started = performance.now();
let result;
do {
  result = await f.drive();
} while (typeof result !== 'string');
const phases = ['summaries', 'trees', 'blobs', 'journal', 'cleanup', 'done'];
const remaining = phases.reduce(
  (sum, phase) => {
    const value = f.metrics.phases[phase];
    for (const key of Object.keys(sum)) sum[key] += value?.[key] ?? 0;
    return sum;
  },
  { calls: 0, documentsRead: 0, documentsWritten: 0 },
);
const generation = f.s.tables.projectWorkGenerations.get(result);
console.log(
  `PHASE_RESULT ${JSON.stringify({
    ...f.metrics,
    remaining,
    recipeBindings: f.recipeBindings.size,
    viewCallsPerRecord: f.metrics.summaryCalls.views / f.data.views.length,
    viewResolvesPerRecord: f.metrics.summaryResolves.views / f.data.views.length,
    counts: JSON.parse(generation.metadata).counts,
    elapsedMs: performance.now() - started,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
  })}`,
);
