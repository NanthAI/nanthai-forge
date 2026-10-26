// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api.js';
import { ConvexError } from 'convex/values';

assert.ok(process.env.VITE_CONVEX_URL, 'Load the separate Forge .env.local.');
assert.ok(process.argv[2], 'Pass a licensed public GitHub repository URL.');
const client = new ConvexHttpClient(process.env.VITE_CONVEX_URL);
if (process.argv[2] === '--failed-job') {
  assert.ok(process.argv[3], 'Pass an import whose scheduled worker failed or was canceled.');
  const job = JSON.parse(await client.action(api.hosted.status, { id: process.argv[3] }));
  assert.equal(job.phase, 'error');
  assert.match(job.error, /worker stopped.*Retry/);
  console.log('PASS failed worker reports an explicit retryable error.');
  process.exit(0);
}
const read = async (id, endpoint) => JSON.parse(await client.action(api.hosted.read, { id, endpoint }));
async function importReady() {
  const id = await client.action(api.hosted.start, { url: process.argv[2] });
  const deadline = Date.now() + 930_000;
  while (Date.now() < deadline) {
    let job;
    try {
      job = JSON.parse(await client.action(api.hosted.status, { id }));
    } catch (error) {
      if (error instanceof ConvexError) throw error;
      console.warn('Status read failed; retrying the same import.');
      await new Promise(resolve => setTimeout(resolve, 3000));
      continue;
    }
    if (job.phase === 'error') throw new Error(job.error);
    if (job.phase === 'ready') return id;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error('Smoke check timed out waiting for the worker.');
}
const id = await importReady();
const before = await read(id, 'status');
assert.equal(before.freshness, 'current');
assert.equal(before.hosted.visibility, 'public');
assert.ok((await read(id, 'readme')).text);
const files = await read(id, 'files');
assert.ok(files.results.length, 'Choose a public repository containing TypeScript.');
const source = await read(id, `source?file=${encodeURIComponent(files.results[0].path)}`);
assert.ok(source.results[0].text);
assert.equal(await importReady(), id, 'Same public repository/ref must coalesce.');
const after = await read(id, 'status');
assert.equal(
  after.analysisId,
  before.analysisId,
  'Unchanged revision/compiler/configuration must reuse equivalent analysis.',
);
console.log(`PASS public import, notices, exact source and repeated import: ${after.gitHead}`);
