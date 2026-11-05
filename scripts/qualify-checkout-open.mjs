// SPDX-License-Identifier: Apache-2.0
// Synthetic, local-only real checkout qualification. Run under `nforge heavy`.
// node scripts/qualify-checkout-open.mjs DIST[,CONTROL_DIST] OUTPUT [REPEATS=2] [COUNTS=1,6,12,10]
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.argv[2] === '--worker') {
  const [dist, directory, index] = process.argv.slice(3);
  const { checkoutHostedLane } = await import(pathToFileURL(join(dist, 'hosted-lane-checkout.js')));
  const { head } = JSON.parse(readFileSync(join(directory, 'input.json')));
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
  const calls = { select: 0, objects: 0, downloads: 0 };
  const ready = once(process, 'message');
  process.send({ ready: true });
  await ready;
  const root = join(directory, `lane-${index}`);
  await checkoutHostedLane(
    root,
    { url: 'https://synthetic.invalid', projectId: 'synthetic', laneId, operationId },
    {
      select: async () => {
        calls.select++;
        return selection;
      },
      objects: async () => {
        calls.objects++;
        throw Error('unexpected metadata download');
      },
      downloadToFile: async () => {
        calls.downloads++;
        throw Error('unexpected byte download');
      },
    },
  );
  const { checkout } = JSON.parse(readFileSync(`${root}.forge-metrics.jsonl`, 'utf8').trim());
  assert.deepEqual(calls, { select: 2, objects: 0, downloads: 0 });
  process.send({ checkout, calls });
  process.disconnect();
} else {
  const [distArg, output, repeatsArg = '2', countsArg = '1,6,12,10'] = process.argv.slice(2);
  assert(distArg && output, 'DIST and OUTPUT are required');
  const variants = distArg.split(',').map(path => resolve(path)),
    rows = [];
  const directory = mkdtempSync(join(tmpdir(), 'forge-open-qualification-'));
  try {
    const objects = join(directory, 'objects');
    mkdirSync(objects);
    const put = bytes => {
      const id = hash(bytes);
      writeFileSync(join(objects, id), bytes, { mode: 0o600 });
      return id;
    };
    for (const filesCount of [2942, 28881]) {
      const files = Array.from({ length: filesCount }, (_, i) => ({
        path: `src/d${Math.floor(i / 100)}/file-${i}.txt`,
        mode: 'file',
        blob: put(Buffer.from(`${i}: synthetic source\n`.padEnd(256, '.'))),
      }));
      const head = put(
        Buffer.from(
          JSON.stringify({
            schema: 1,
            kind: 'forge-source-state',
            parents: [],
            files,
            message: 'synthetic',
            at: '2026-01-01T00:00:00Z',
          }),
        ),
      );
      for (let repeat = 0; repeat < Number(repeatsArg); repeat++)
        for (const count of countsArg.split(',').map(Number))
          for (const dist of (count === 6 || count === 10) !== Boolean(repeat % 2)
            ? [...variants].reverse()
            : variants) {
            const cohort = join(directory, `cohort-${filesCount}-${repeat}-${count}`);
            mkdirSync(cohort);
            writeFileSync(join(cohort, 'input.json'), JSON.stringify({ head }));
            const workers = Array.from({ length: count }, (_, index) => {
              const child = fork(new URL(import.meta.url), ['--worker', dist, cohort, String(index)], {
                execArgv: [],
                silent: true,
                env: {
                  ...process.env,
                  FORGE_TEST_MODE: '1',
                  HOME: cohort,
                  USERPROFILE: cohort,
                  XDG_CONFIG_HOME: join(cohort, 'config'),
                  FORGE_OBJECT_CACHE: objects,
                },
              });
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
                  files: filesCount,
                  logicalBytes: filesCount * 256,
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
              console.log(
                JSON.stringify({
                  files: filesCount,
                  count,
                  repeat,
                  waitP50Ms: percentile([...waits], 0.5),
                  waitP95Ms: percentile([...waits], 0.95),
                  firstMs: Math.min(...totals),
                  tailMs: Math.max(...totals),
                  maxRssKiB: Math.max(...cohortRows.map(row => row.checkout.maxRssKiB)),
                }),
              );
              writeFileSync(output, JSON.stringify({ variants, node: process.version, rows }, null, 2));
            } finally {
              for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill('SIGKILL');
              await Promise.allSettled(workers.map(worker => worker.done));
              rmSync(cohort, { recursive: true, force: true });
            }
          }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
