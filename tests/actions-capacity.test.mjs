// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readActionsCapacity } from '../scripts/actions-capacity.mjs';

const input = { repository: 'example/fixture', runId: '1', token: 'synthetic', workflow: 'forge-check.yml' };
test('capacity reads two bounded pages, deduplicates transitions and includes its own run', async () => {
  const calls = [];
  const result = await readActionsCapacity({
    ...input,
    request: async (url, options) => {
      calls.push(url);
      assert.equal(new URL(url).hostname, 'api.github.com');
      assert.equal(new URL(url).searchParams.get('per_page'), '20');
      assert.equal(options.redirect, 'error');
      assert(options.signal instanceof AbortSignal);
      const queued = url.includes('status=queued');
      return Response.json({
        workflow_runs: queued
          ? [
              { id: 2, status: 'queued' },
              { id: 3, status: 'queued' },
            ]
          : [
              { id: 3, status: 'in_progress' },
              { id: 4, status: 'completed' },
            ],
      });
    },
  });
  assert.deepEqual(result, { activeChecks: 3, jobCap: 20 });
  assert.equal(calls.length, 2);
});

test('dogfood queue depth remains two API calls, zero Convex calls and bounded memory', async t => {
  let calls = 0;
  const start = performance.now(),
    rss = process.memoryUsage().rss;
  const result = await readActionsCapacity({
    ...input,
    request: async url => {
      calls++;
      const status = new URL(url).searchParams.get('status');
      return Response.json({
        total_count: 6000,
        workflow_runs: Array.from({ length: 20 }, (_, i) => ({ id: i + 2, status })),
      });
    },
  });
  assert.deepEqual(result, { activeChecks: 20, jobCap: 20 });
  assert.equal(calls, 2);
  assert(process.memoryUsage().rss - rss < 32 * 1024 * 1024);
  t.diagnostic(
    JSON.stringify({
      queueRecords: 6000,
      githubCalls: calls,
      convexCalls: 0,
      elapsedMs: performance.now() - start,
      rssBytes: process.memoryUsage().rss,
    }),
  );
});

test('missing credentials, invalid identities and denied or malformed responses preserve timing-only planning', async () => {
  let calls = 0;
  const unexpected = async () => {
    calls++;
    throw new Error('Unexpected request');
  };
  for (const overrides of [
    { token: undefined },
    { repository: 'https://untrusted.invalid' },
    { workflow: '../other.yml' },
    { runId: 'invalid' },
  ])
    assert.equal(await readActionsCapacity({ ...input, ...overrides, request: unexpected }), undefined);
  assert.equal(calls, 0);
  for (const response of [
    () => new Response('', { status: 403 }),
    () => Response.json({}),
    () => new Response('{'),
    () => Response.json({ workflow_runs: Array.from({ length: 21 }, () => ({ id: 2, status: 'queued' })) }),
    () => Response.json({ workflow_runs: [{ id: 'invalid', status: 'queued' }] }),
    () => new Response(' '.repeat(1024 * 1024 + 1)),
  ])
    assert.equal(await readActionsCapacity({ ...input, request: async () => response() }), undefined);
  assert.equal(
    await readActionsCapacity({
      ...input,
      request: async () => {
        throw new Error('Network unavailable');
      },
    }),
    undefined,
  );
});
