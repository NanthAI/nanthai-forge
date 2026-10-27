// SPDX-License-Identifier: Apache-2.0
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeFunctionReference, getFunctionName } from 'convex/server';
import { progressFixture } from './projectWorkIndex-progress-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
if (process.argv[2] === 'action') {
  // Only the action lives here. The fake database and storage live in the parent,
  // as they do outside a real Convex action; producer RSS is measured separately.
  let sequence = 0;
  const pending = new Map();
  process.on('message', ({ id, value, error }) => {
    const promise = pending.get(id);
    pending.delete(id);
    if (error) promise.reject(new Error(error));
    else promise.resolve(value);
  });
  const rpc = (kind, args) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      process.send({ id, kind, args });
    });
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    ...Object.fromEntries(
      ['runQuery', 'runMutation', 'runAction'].map(kind => [
        kind,
        (ref, args) => rpc(kind, { name: getFunctionName(ref), args }),
      ]),
    ),
    storage: {
      get: async id => {
        const bytes = await rpc('storage', id);
        return bytes ? new Blob([Buffer.from(bytes, 'base64')]) : null;
      },
      getMetadata: id => rpc('metadata', id),
    },
  };
  const { ensure } = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
  global.gc();
  const baseline = { ...process.memoryUsage(), maxRssBytes: process.resourceUsage().maxRSS * 1024 };
  const started = performance.now();
  const result = await ensure._handler(ctx, { projectId: 'project' });
  console.log(
    `ACTION_RESULT ${JSON.stringify({ pending: result.pending, baseline, memory: process.memoryUsage(), maxRssBytes: process.resourceUsage().maxRSS * 1024, elapsedMs: performance.now() - started, maxSourceWindowBytes: await rpc('window') })}`,
  );
  process.exit(0);
}
const f = progressFixture(1, undefined, undefined, {
  treeFiles: 3000,
  recipes: true,
  largeFiles: true,
  ownerViews: true,
  ownerStats: process.argv[2] !== 'absent',
  journal: 5000,
  objects: 32000,
});
if (process.argv[2] === 'memory') {
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
    cursor: JSON.stringify({ phase: 'summaries', field: 1, record: 403, source: 2495 }),
  });
  const child = fork(fileURLToPath(import.meta.url), ['action'], {
    execArgv: ['--expose-gc', '--max-old-space-size=128'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: process.env,
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on('message', async ({ id, kind, args }) => {
    try {
      let value;
      if (kind === 'storage') {
        const blob = await f.s.ctx.storage.get(args);
        value = blob && Buffer.from(await blob.arrayBuffer()).toString('base64');
      } else if (kind === 'metadata') value = await f.s.ctx.storage.getMetadata(args);
      else if (kind === 'window') value = f.metrics.maxSourceWindowBytes;
      else value = await f.s.ctx[kind](makeFunctionReference(args.name), args.args);
      child.send({ id, value });
    } catch (error) {
      child.send({ id, error: String(error) });
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  process.exit(code);
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
