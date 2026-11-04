// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '../scripts/child-env.mjs';

export function cpuMilliseconds(start) {
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
}

export function retainedBytes() {
  assert.equal(typeof globalThis.gc, 'function', 'resource workers must use --expose-gc');
  globalThis.gc();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
}

// A fresh process isolates allocations from the parent test and its fake DB.
export function runResourceWorker(path, input = {}) {
  const worker = new URL(path, import.meta.url).href;
  const directory = mkdtempSync(join(tmpdir(), 'forge-resource-input-'));
  try {
    const path = join(directory, 'input.json');
    writeFileSync(path, JSON.stringify(input), { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        '--expose-gc',
        '--import',
        new URL('./check-runtime.mjs', import.meta.url).href,
        '--input-type=module',
        '-e',
        `
          import { readFileSync } from 'node:fs';
          const { default: run } = await import(${JSON.stringify(worker)});
          const result = await run(JSON.parse(readFileSync(process.argv[1], 'utf8')));
          process.stdout.write(JSON.stringify(result));
        `,
        path,
      ],
      // File delivery avoids a synchronous parent/child stdin pipe deadlock on
      // large transcripts. Only the compact result travels through a pipe.
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: childEnv(), maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function assertMetricResources(measured) {
  assert(measured.calls + measured.objectCalls <= 1500, 'metric query/object work budget');
  assert(measured.documents <= 200000, 'metric document work budget');
  assert.equal(measured.writes, 0);
  assert(
    measured.retainedBytes < 64 * 1024 * 1024,
    `metric retained allocation ${measured.retainedBytes} bytes`,
  );
  assert(
    measured.retainedGrowthBytes < 64 * 1024 * 1024,
    `metric retained allocation growth ${measured.retainedGrowthBytes} bytes`,
  );
  assert(measured.rssMiB <= 500, `metric fresh-process RSS ${measured.rssMiB} MiB`);
  assert(measured.peakRssMiB <= 500, `metric fresh-process peak RSS ${measured.peakRssMiB} MiB`);
  assert(measured.cpuMs <= 30000, `metric CPU ${measured.cpuMs} ms`);
}
