// SPDX-License-Identifier: Apache-2.0
// Isolated actual Node handler, with recorded production V8 replies and synthetic R2.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const baselineRssBytes = process.memoryUsage().rss;
const run = await import(moduleUrl('../convex/projectJournalRun.ts'));
const loadedRssBytes = process.memoryUsage().rss,
  objects = new Map(),
  queue = [data.input],
  results = [];
globalThis.fetch = async (url, init) => {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'synthetic.r2.cloudflarestorage.com');
  assert(parsed.pathname.includes('/journal-segments/'));
  if (init?.method === 'PUT') {
    assert(!objects.has(parsed.pathname));
    objects.set(parsed.pathname, Buffer.from(init.body));
    return new Response(null, { status: 200 });
  }
  return new Response(objects.get(parsed.pathname) ?? null, {
    status: objects.has(parsed.pathname) ? 200 : 404,
  });
};
let index = 0;
const ctx = {
  runMutation: async (ref, args) => {
    const step = data.transcript[index++];
    assert.equal(getFunctionName(ref), step?.name);
    assert.equal(canonicalPayload({ ...args, claim: step.args.claim }), canonicalPayload(step.args));
    return step.value;
  },
  scheduler: {
    runAfter: async (_delay, _ref, input) => {
      queue.push(input);
    },
  },
};
while (queue.length) results.push(JSON.parse(await run.pack._handler(ctx, queue.shift())));
assert.equal(index, data.transcript.length);
assert.equal(objects.size, data.objects);
console.log(
  JSON.stringify({
    pages: results.length,
    mutations: index,
    objects: objects.size,
    baselineRssBytes,
    loadedRssBytes,
    peakProcessRssBytes: process.resourceUsage().maxRSS * 1024,
    wallMs: results.reduce((n, result) => n + result.metrics.wallMs, 0),
    scope: 'isolated Node handler with recorded V8 replies and local fake R2, not provider billing',
  }),
);
