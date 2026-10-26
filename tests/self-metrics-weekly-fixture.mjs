// SPDX-License-Identifier: Apache-2.0
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeMetricWeek } from '../dist/self-metrics-weekly-worker.js';
import { snapshotMetricWeek, weeklyMetricTestHooks } from '../dist/self-metrics-weekly.js';

const [owner, at, token] = process.argv.slice(2);
if (token === 'schedule') {
  weeklyMetricTestHooks.worker = fileURLToPath(import.meta.url);
  snapshotMetricWeek(join(owner, '.forge', 'work'), at);
} else {
  appendFileSync(join(owner, 'weekly-worker-starts.jsonl'), JSON.stringify({ pid: process.pid }) + '\n');
  const reader = {
    read() {
      appendFileSync(join(owner, 'weekly-reader-starts.jsonl'), JSON.stringify({ pid: process.pid }) + '\n');
      const { delay = 0, fail = false } = JSON.parse(readFileSync(join(owner, 'weekly-reader.json'), 'utf8'));
      // Deliberately block for seconds: this must never execute in the writer.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      if (fail) throw new Error('Injected metric reader failure');
      return {
        moves: [],
        submissions: [],
        runs: [],
        gaps: [],
        receipts: [
          {
            schema: 1,
            kind: 'mutation',
            action: 'work-write',
            operationId: 'fixture',
            actor: { kind: 'system', name: 'fixture' },
            origin: 'system',
            at: '2026-10-20T00:00:00.000Z',
          },
        ],
      };
    },
  };
  process.exitCode = (await writeMetricWeek(owner, at, token, reader)) ? 0 : 1;
}
