// SPDX-License-Identifier: Apache-2.0
// Runs the actual action and database handlers. Only auth, storage and the
// provider's indexed database are local substitutes; unknown steps fail closed.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getFunctionName } from 'convex/server';
import { preparedMetadata } from '../dist/native-exchange-prepared.js';
import { parseJsonStream } from '../dist/json-stream.js';
import { ownerDerivedPages } from '../dist/owner-derived-pages.js';
import { ownerDiffstat } from '../dist/owner-derived.js';
import { digest } from '../dist/hash.js';
const [scratch, capture, rowsFile, generationsFile, configFile, mode] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configFile));
const prepared = preparedMetadata(capture, readFileSync(join(capture, 'manifest.json')));
const objectPath = hash => join(scratch, hash);
const bytes = hash =>
  hash === digest(prepared.bytes) ? prepared.bytes : (prepared.read(hash) ?? readFileSync(objectPath(hash)));
if (mode === 'prepare-display') {
  const derived = await parseJsonStream(createReadStream(join(capture, 'owner-derived.json')));
  const { NativeSource } = await import('../dist/native-source.js');
  const source = new NativeSource(join(capture, '../../..'));
  const after = JSON.parse(readFileSync(join(scratch, 'after.json')));
  const known = new Set(derived.stats.map(([key]) => key));
  let comparisons = 0;
  for (const field of after.fields.filter(f => ['lanes', 'views'].includes(f.name))) {
    for (const pin of field.records) {
      const row = JSON.parse(bytes(pin.sha256));
      if (!row.head || row.status === 'conflict') continue;
      const key = `${row.base}:${row.head}`;
      if (known.has(key)) continue;
      derived.stats.push([
        key,
        ownerDiffstat(source.state(row.base).files, source.state(row.head).files, hash =>
          source.object(hash),
        ),
      ]);
      known.add(key);
      comparisons++;
    }
  }
  const pages = ownerDerivedPages(Buffer.from(JSON.stringify(derived)));
  for (const [hash, body] of pages.objects) writeFileSync(objectPath(hash), body);
  const hash = digest(pages.root);
  writeFileSync(objectPath(hash), pages.root);
  writeFileSync(
    join(scratch, 'fresh-display.json'),
    JSON.stringify({ sha256: hash, size: pages.root.length, comparisons }),
  );
  console.log(JSON.stringify({ preparedComparisons: comparisons, stats: known.size }));
  process.exit(0);
}
const provider = fork(
  new URL('./return-offline-provider.mjs', import.meta.url),
  [scratch, rowsFile, generationsFile, configFile],
  {
    execArgv: ['--max-old-space-size=128', '--max-semi-space-size=4'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  },
);
let nextId = 0;
const requests = new Map();
const ready = new Promise((resolve, reject) => {
  provider.on('message', message => {
    if (message.ready) return resolve();
    const pending = requests.get(message.id);
    if (!pending) return;
    requests.delete(message.id);
    if (message.error) pending.reject(Object.assign(Error(message.error.message), message.error));
    else pending.resolve(message.value);
  });
  provider.on('exit', code => {
    const error = Error(`Offline provider exited ${code}`);
    reject(error);
    for (const request of requests.values()) request.reject(error);
  });
});
const rpc = request =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    requests.set(id, { resolve, reject });
    provider.send({ id, ...request });
  });
try {
  await ready;
  const run = (ref, args) => rpc({ name: getFunctionName(ref), args });
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: 'owner' }) },
    runQuery: run,
    runMutation: run,
    runAction: run,
    storage: {
      get: async hash => new Blob([bytes(hash)]),
      getMetadata: async hash => ({ size: bytes(hash).length, sha256: hash }),
    },
  };
  const { returnSource } = await import(config.action);
  let result,
    invocations = 0;
  const actionMs = [];
  const start = performance.now();
  do {
    const started = performance.now();
    result = await returnSource._handler(ctx, config.input);
    actionMs.push(Math.round(performance.now() - started));
    invocations++;
    assert(invocations < 20, 'Unmodeled offline step: action made no final publication');
  } while (result.pending);
  const project = await rpc({ control: 'read', args: config.input.projectId });
  assert.equal(project.work.backupId, config.input.backupId, 'Final publication did not select backup');
  assert.equal(
    project.work.revision,
    config.seed.projectBackups[1].preview.revision + 1,
    'Final publication lost returned Work revision',
  );
  const index = await rpc({ control: 'read', args: config.generation._id });
  assert.equal(index.backupId, config.input.backupId, 'Index was not atomically published');
  assert(index.recordsGenerationId, 'Retained rows were not privately copied');
  const hostedMain = JSON.parse(
    await rpc({ name: 'projectMain:current', args: { projectId: config.input.projectId } }),
  );
  assert.equal(
    hostedMain.backupId,
    config.input.backupId,
    'Hosted main read did not select the returned backup',
  );
  const validationCalls = 1;
  const beforeCleanup = await rpc({ control: 'accounting' });
  const cleanupCalls = await rpc({ control: 'drain' });
  const accounting = await rpc({ control: 'accounting' });
  const foreground =
    Object.values(beforeCleanup.calls).reduce((a, b) => a + b, 0) + invocations - validationCalls;
  const peakRssMiB = Math.ceil(process.resourceUsage().maxRSS / 1024);
  assert(peakRssMiB < 400, `Action exceeded 400 MiB: ${peakRssMiB}`);
  assert(Math.max(...actionMs) < 30000, `Action exceeded 30 s: ${Math.max(...actionMs)}`);
  assert(
    foreground + cleanupCalls <= 400,
    `Remaining return and cleanup exceeded 400 calls: ${foreground + cleanupCalls}`,
  );
  console.log(
    JSON.stringify({
      status: 'PASS',
      result: `hosted main would equal backup ${project.work.backupId}`,
      invocations,
      actionMs,
      elapsedMs: Math.round(performance.now() - start),
      peakRssMiB,
      providerPeakRssMiB: accounting.providerPeakRssMiB,
      predictedCalls: { foreground, cleanup: cleanupCalls, total: foreground + cleanupCalls },
      calls: accounting.calls,
      validationCalls,
      hostedMain,
      documents: accounting.documents,
      realConvexWrites: 0,
      retainedPartitionCleanup: 'completed',
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      status: 'FAIL',
      step: 'returnSource',
      code: error.data?.code ?? error.code,
      reason: error.data?.message ?? error.message,
    }),
  );
  process.exitCode = 1;
} finally {
  provider.kill();
}
