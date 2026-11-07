// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLandWaitMetrics } from '../dist/land-wait-metrics.js';
import { ForgeError } from '../dist/errors.js';

function lane(t) {
  const parent = mkdtempSync(join(tmpdir(), 'forge-land-wait-metrics-')),
    root = join(parent, 'lane');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return {
    root,
    rows: () =>
      readFileSync(`${root}.forge-metrics.jsonl`, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line)),
  };
}

test('a failed wait records its error code, retries and the last changed state', async t => {
  const { root, rows } = lane(t);
  const forwarded = [];
  const pending = {
    type: 'submission',
    operationId: 'op',
    submission: { phase: 'queued', version: 3, observation: { state: 'pending' } },
  };
  await assert.rejects(
    withLandWaitMetrics(
      root,
      { operationId: 'op', waitingFor: 'acceptance', budgetSeconds: 2 },
      event => forwarded.push(event),
      async observed => {
        observed(pending);
        // A clock-only change (version) is not a change the agent sees.
        observed({ ...pending, submission: { ...pending.submission, version: 4 } });
        observed({ type: 'observation-retry', code: 'EXCHANGE_REQUEST_TIMEOUT', attempt: 1 });
        throw new ForgeError('HOSTED_REQUEST_FAILED', 'synthetic');
      },
    ),
    /synthetic/,
  );
  assert.equal(forwarded.length, 3, 'every event still reaches the caller unchanged');
  const [start, end] = rows();
  assert.equal(start.kind, 'wait');
  assert.equal(start.wait.phase, 'start');
  assert.equal(start.wait.budgetMs, 2000);
  assert.equal(end.errorCode, 'HOSTED_REQUEST_FAILED');
  assert.equal(end.wait.status, 'failed');
  assert.equal(end.wait.events, 3);
  assert.equal(end.wait.retries, 1);
  assert.equal(end.wait.last.phase, 'queued');
  assert.equal(end.wait.last.version, 3, 'the last change is kept, not a later clock-only wake');
});

test('a run wait records its terminal status', async t => {
  const { root, rows } = lane(t);
  const result = await withLandWaitMetrics(
    root,
    { operationId: 'run', waitingFor: 'run', budgetSeconds: 1 },
    () => {},
    async () => ({ result: { status: 'terminal' } }),
  );
  assert.equal(result.result.status, 'terminal');
  const end = rows().at(-1);
  assert.equal(end.wait.waitingFor, 'run');
  assert.equal(end.wait.status, 'terminal');
  assert.equal(end.wait.events, 0);
  assert.equal(end.wait.last, null);
});
