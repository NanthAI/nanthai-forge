// SPDX-License-Identifier: Apache-2.0
// Synthetic, local-only real checkout qualification. Run under `nforge heavy`.
// node scripts/qualify-checkout-open.mjs DIST[,CONTROL_DIST] OUTPUT [REPEATS=2] [COUNTS=1,6,12,10]
// Environment (all optional):
//   FORGE_QUALIFY_SIZES=2942,28881  file counts per tree
//   FORGE_QUALIFY_CONTENT=tiny|mixed  tiny: 256 B files; mixed: 128 B-30 KB, ~2x compressible
//   FORGE_QUALIFY_MODE=warm|cold|both  warm: verified machine store present (a second open);
//     cold: empty machine store per cohort, bytes from a loopback pack/object server (a first open)
// No network beyond 127.0.0.1, no hosted project, no CLI inside a measured checkout.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  copyFileSync,
  createReadStream,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.argv[2] === '--worker') {
  const [dist, directory, index, mode] = process.argv.slice(3);
  const { checkoutHostedLane } = await import(pathToFileURL(join(dist, 'hosted-lane-checkout.js')));
  const { head, objects, pack, server } = JSON.parse(readFileSync(join(directory, 'input.json')));
  const laneId = randomUUID(),
    operationId = randomUUID();
  const selection = {
    schema: 2,
    projectId: 'synthetic',
    laneId,
    intentId: randomUUID(),
    head,
    version: 0,
    sourceVersion: 0,
    lifecycleVersion: 0,
    state: 'active',
    base: { head, receiptId: 'synthetic' },
    authority: { mode: 'server', epoch: 1 },
  };
  // Hosted calls a real open would make: select (query), objects (signing mutation),
  // sourcePack (query); object/pack GETs and their bytes stand in for R2 reads.
  const calls = { select: 0, objects: 0, sourcePack: 0, objectGets: 0, objectBytes: 0 };
  const ready = once(process, 'message');
  process.send({ ready: true });
  await ready;
  const root = join(directory, `lane-${index}`);
  const cold = mode === 'cold';
  const fail = name => async () => {
    calls[name]++;
    throw Error(`unexpected ${name} on a warm open`);
  };
  const transport = cold
    ? {
        select: async () => (calls.select++, selection),
        objects: async digests => {
          calls.objects++;
          return digests.map(sha256 => ({ sha256, size: statSync(join(objects, sha256)).size }));
        },
        downloadToFile: async (pin, path) => {
          calls.objectGets++;
          calls.objectBytes += pin.size;
          copyFileSync(join(objects, pin.sha256), path);
        },
        sourcePack: async () => {
          calls.sourcePack++;
          return { ...pack, url: `${server}/pack` };
        },
      }
    : {
        select: async () => (calls.select++, selection),
        objects: fail('objects'),
        downloadToFile: fail('objectGets'),
      };
  const opened = await checkoutHostedLane(
    root,
    { url: 'https://synthetic.invalid', projectId: 'synthetic', laneId, operationId },
    transport,
  );
  const { checkout } = JSON.parse(readFileSync(`${root}.forge-metrics.jsonl`, 'utf8').trim());
  if (!cold) assert.deepEqual(calls, { select: 2, objects: 0, sourcePack: 0, objectGets: 0, objectBytes: 0 });
  process.send({
    checkout,
    calls,
    machineObjects: opened.machineObjects ?? 0,
    packObjects: opened.packObjects ?? 0,
    sourcePackResult: opened.sourcePack ?? null,
  });
  process.disconnect();
} else {
  const [distArg, output, repeatsArg = '2', countsArg = '1,6,12,10'] = process.argv.slice(2);
  assert(distArg && output, 'DIST and OUTPUT are required');
  const variants = distArg.split(',').map(path => resolve(path)),
    rows = [];
  const sizes = (process.env.FORGE_QUALIFY_SIZES ?? '2942,28881').split(',').map(Number),
    content = process.env.FORGE_QUALIFY_CONTENT ?? 'tiny',
    modes =
      (process.env.FORGE_QUALIFY_MODE ?? 'warm') === 'both'
        ? ['warm', 'cold']
        : [process.env.FORGE_QUALIFY_MODE ?? 'warm'];
  assert(['tiny', 'mixed'].includes(content) && modes.every(mode => ['warm', 'cold'].includes(mode)));
  const directory = mkdtempSync(join(tmpdir(), 'forge-open-qualification-'));
  // Loopback pack server: counts GETs and bytes, serves only the current fixture pack.
  const served = { gets: 0, bytes: 0, path: null };
  const server = createServer((request, response) => {
    if (request.url !== '/pack' || !served.path) return response.writeHead(404).end();
    served.gets++;
    served.bytes += statSync(served.path).size;
    response.writeHead(200, { 'content-length': statSync(served.path).size });
    createReadStream(served.path).pipe(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const { createSourcePack } = await import(pathToFileURL(join(variants[0], 'source-pack-archive.js')));
    const sizeCycle = [128, 512, 1500, 3000, 6000, 12000, 30000, 1200, 800, 4000];
    for (const filesCount of sizes) {
      const objects = join(directory, `objects-${filesCount}`);
      mkdirSync(objects, { mode: 0o700 });
      const put = bytes => {
        const id = hash(bytes);
        writeFileSync(join(objects, id), bytes, { mode: 0o600 });
        return id;
      };
      let logicalBytes = 0;
      const body = i => {
        if (content === 'tiny') return Buffer.from(`${i}: synthetic source\n`.padEnd(256, '.'));
        const size = sizeCycle[i % sizeCycle.length],
          bytes = Buffer.alloc(size);
        // Alternate pseudo-random and repeated text blocks: roughly source-like 2x gzip.
        for (let at = 0, block = 0; at < size; at += 32, block++) {
          const chunk =
            block % 2
              ? createHash('sha256').update(`${i}:${block}`).digest()
              : Buffer.from(`line ${i} ${block} const x = 1;\n`.padEnd(32, ' '));
          chunk.copy(bytes, at, 0, Math.min(32, size - at));
        }
        return bytes;
      };
      const files = Array.from({ length: filesCount }, (_, i) => {
        const bytes = body(i);
        logicalBytes += bytes.length;
        return { path: `src/d${Math.floor(i / 100)}/file-${i}.txt`, mode: 'file', blob: put(bytes) };
      });
      const state = {
        schema: 1,
        kind: 'forge-source-state',
        parents: [],
        files,
        message: 'synthetic',
        at: '2026-01-01T00:00:00Z',
      };
      const head = put(Buffer.from(JSON.stringify(state)));
      const packPath = join(directory, `pack-${filesCount}.gz`);
      const created = modes.includes('cold') ? await createSourcePack(head, state, objects, packPath) : null;
      const pack = created && { ...created, objectKey: 'synthetic', createdAt: 0 };
      served.path = created ? packPath : null;
      for (const mode of modes)
        for (let repeat = 0; repeat < Number(repeatsArg); repeat++)
          for (const count of countsArg.split(',').map(Number))
            // Alternate variant order by repeat and concurrency so neither always runs first.
            for (const dist of (count === 6 || count === 10) !== Boolean(repeat % 2)
              ? [...variants].reverse()
              : variants) {
              const cohort = join(directory, `cohort-${filesCount}-${mode}-${repeat}-${count}`);
              mkdirSync(cohort);
              writeFileSync(
                join(cohort, 'input.json'),
                JSON.stringify({ head, objects, pack, server: serverUrl }),
              );
              const machine = mode === 'cold' ? join(cohort, 'machine') : objects;
              const getsBefore = served.gets,
                bytesBefore = served.bytes;
              const workers = Array.from({ length: count }, (_, index) => {
                const child = fork(
                  new URL(import.meta.url),
                  ['--worker', dist, cohort, String(index), mode],
                  {
                    execArgv: [],
                    silent: true,
                    env: {
                      ...process.env,
                      FORGE_TEST_MODE: '1',
                      HOME: cohort,
                      USERPROFILE: cohort,
                      XDG_CONFIG_HOME: join(cohort, 'config'),
                      FORGE_OBJECT_CACHE: machine,
                    },
                  },
                );
                let stderr = '';
                child.stderr.on('data', chunk => {
                  stderr += chunk;
                });
                const done = once(child, 'exit').then(([code]) => {
                  assert.equal(code, 0, stderr);
                });
                const ready = Promise.race([
                  once(child, 'message'),
                  done.then(() => {
                    throw Error('worker exited before readiness');
                  }),
                ]);
                return { child, ready, done };
              });
              try {
                await Promise.all(workers.map(worker => worker.ready));
                const results = workers.map(async ({ child, done }, index) => {
                  const [[result]] = await Promise.all([once(child, 'message'), done]);
                  const row = {
                    dist,
                    mode,
                    content,
                    files: filesCount,
                    logicalBytes,
                    count,
                    repeat,
                    index,
                    ...result,
                  };
                  rows.push(row);
                  return row;
                });
                for (const worker of workers) worker.child.send('go');
                const cohortRows = await Promise.all(results);
                const percentile = (values, p) =>
                  values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
                const waits = cohortRows.map(row => row.checkout.phasesMs.slotWait);
                const totals = cohortRows.map(row => row.checkout.totalMs);
                const sum = key => cohortRows.reduce((total, row) => total + row.calls[key], 0);
                const summary = {
                  variant: variants.indexOf(dist),
                  mode,
                  files: filesCount,
                  count,
                  repeat,
                  wallP50Ms: Math.round(percentile([...totals], 0.5)),
                  wallP95Ms: Math.round(percentile([...totals], 0.95)),
                  waitP50Ms: Math.round(percentile([...waits], 0.5)),
                  waitP95Ms: Math.round(percentile([...waits], 0.95)),
                  firstMs: Math.round(Math.min(...totals)),
                  tailMs: Math.round(Math.max(...totals)),
                  maxRssKiB: Math.max(...cohortRows.map(row => row.checkout.maxRssKiB)),
                  hostedCalls: sum('select') + sum('objects') + sum('sourcePack'),
                  r2Gets: sum('objectGets') + served.gets - getsBefore,
                  r2Bytes: sum('objectBytes') + served.bytes - bytesBefore,
                  machineObjects: cohortRows.reduce((total, row) => total + row.machineObjects, 0),
                };
                rows.push({ summary });
                console.log(JSON.stringify(summary));
                writeFileSync(output, JSON.stringify({ variants, node: process.version, rows }, null, 2));
              } finally {
                for (const worker of workers)
                  if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
                await Promise.allSettled(workers.map(worker => worker.done));
                rmSync(cohort, { recursive: true, force: true });
              }
            }
      rmSync(objects, { recursive: true, force: true });
      rmSync(packPath, { force: true });
    }
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
