// SPDX-License-Identifier: Apache-2.0
// Isolated Node action qualification: V8 transaction replies come from a production-handler
// fixture transcript, so its DB fake/import heap does not get counted as action memory.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const baselineRssBytes = process.memoryUsage().rss;
const run = await import(moduleUrl('../convex/projectLandingCapsuleRun.ts'));
const loadedRssBytes = process.memoryUsage().rss;
const objects = new Map();
globalThis.fetch = async (url, init) => {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'synthetic.r2.cloudflarestorage.com');
  assert(parsed.pathname.includes('/landing-capsules/'));
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
const result = JSON.parse(
  await run.pack._handler(
    {
      runMutation: async (ref, args) => {
        const selected = data.transcript[index++];
        assert.equal(getFunctionName(ref), selected?.name);
        assert.equal(canonicalPayload(args), canonicalPayload(selected.args));
        return selected.value;
      },
      scheduler: { runAfter: async () => assert.fail('qualified fixture needs no bootstrap continuation') },
    },
    data.input,
  ),
);
assert.equal(index, data.transcript.length);
assert.equal(result.pointer.sha256, data.sha256);
console.log(
  JSON.stringify({
    ...result.metrics,
    baselineRssBytes,
    loadedRssBytes,
    peakProcessRssBytes: process.resourceUsage().maxRSS * 1024,
    scope: 'isolated Node action with recorded V8 replies and local fake R2; not provider billing',
  }),
);
