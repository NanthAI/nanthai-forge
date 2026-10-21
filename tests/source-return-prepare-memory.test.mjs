// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moduleUrl } from './convex-module.mjs';
const exec = promisify(execFile);
// Compile outside the measured action process; no compiler heap is part of production actions.
moduleUrl('../convex/projectSourceReturnPrepare.ts');
moduleUrl('../convex/projectSourceReturnCursor.ts');
test('100 MB / 22,845-record compatibility candidate loads, stores and cold-validates below 512 MB', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-prepare-memory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const worker = new URL('./source-return-prepare-memory-worker.mjs', import.meta.url).pathname;
  await exec(process.execPath, [worker, 'fixture', directory], { maxBuffer: 1024 * 1024 });
  const { stdout } = await exec(
    process.execPath,
    ['--expose-gc', '--trace-gc-nvp', '--max-old-space-size=384', worker, 'after', directory],
    {
      env: { ...process.env, FORGE_TEST_PRECOMPILED: '1' },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout.match(/MEMORY_RESULT (.+)/)[1]);
  const peakHeap = Math.max(
    result.sampledHeap,
    ...Array.from(stdout.matchAll(/(?:start_object_size|total_size_before)=(\d+)/g), m => Number(m[1])),
  );
  assert.ok(result.workBytes >= 100_000_000, JSON.stringify(result));
  assert.equal(result.objects, 22845);
  assert.equal(result.records, 22845);
  assert.equal(result.validationChunks, 376);
  assert.equal(result.invocations, 48);
  assert.ok(peakHeap < 320 * 1024 * 1024, `peak heap ${peakHeap}`);
  assert.ok(result.maxRSS < 512 * 1024 * 1024, `peak RSS ${result.maxRSS}`);
  t.diagnostic(JSON.stringify({ ...result, peakHeap }));
});

test('streamed snapshot compression rejects encoder failures without storing partial state', async () => {
  const { storeReturnJson } = await import(moduleUrl('../convex/projectSourceReturnCursor.ts'));
  let stores = 0;
  await assert.rejects(
    storeReturnJson(
      {
        storage: {
          store: async () => {
            stores++;
          },
        },
      },
      { invalid: 1n },
    ),
    TypeError,
  );
  assert.equal(stores, 0);
});

// Keep fixture creation and compilation outside the action's measured process.
test('journal export hashes 100 MB of retained Work without a whole Work string below 512 MB', async t => {
  moduleUrl('../convex/projectWorkActions.ts');
  const directory = mkdtempSync(join(tmpdir(), 'forge-journal-memory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const worker = new URL('./source-return-prepare-memory-worker.mjs', import.meta.url).pathname;
  await exec(process.execPath, [worker, 'fixture', directory], { maxBuffer: 1024 * 1024 });
  const { stdout } = await exec(
    process.execPath,
    ['--expose-gc', '--max-old-space-size=384', worker, 'journal', directory],
    { env: { ...process.env, FORGE_TEST_PRECOMPILED: '1' }, maxBuffer: 1024 * 1024 },
  );
  const result = JSON.parse(stdout.match(/MEMORY_RESULT (.+)/)[1]);
  assert.ok(result.workBytes >= 100_000_000);
  assert.ok(result.maxRSS < 512 * 1024 * 1024, `peak RSS ${result.maxRSS}`);
  t.diagnostic(JSON.stringify(result));
});
