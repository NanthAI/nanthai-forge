// SPDX-License-Identifier: Apache-2.0
// Item 36fd3295, cost: the would-conflict config action compares Candidate listings against main's path entries. Main's State (up to 16 MiB) is fetched
// at most once per main head per warm process, shared with the forge.json lists cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { saveFixture } from './hosted-saves-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';

const merge = await import(moduleUrl('../convex/projectHostedConflictMerge.ts'));
const R2 = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

const located = (s, pin) => ({
  digest: pin.sha256,
  size: pin.size,
  location: 'r2',
  r2Key: `v1/p/${s.projectId}/o/${pin.sha256}`,
  r2Committed: true,
});

/** The real config action with a counting R2 fetch and one queued Candidate whose
 * listing carries main's own bytes at a.txt. */
async function cacheFixture(t) {
  const prior = Object.fromEntries(R2.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const key of R2) process.env[key] = 'synthetic';

  const s = await saveFixture(`cache ${t.name} ${Date.now()}\n`);
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const key = new URL(url).pathname.split('/o/')[1];
    fetched.push(key);
    const bytes = s.objects.get(key);
    return new Response(bytes ?? null, { status: bytes ? 200 : 404 });
  });
  // A queued Candidate whose listing carries main's own bytes at a.txt.
  const listing = s.put(
    canonicalPayload({
      schema: 1,
      kind: 'forge-candidate-files',
      base: '0'.repeat(64),
      head: '1'.repeat(64),
      files: [
        {
          path: 'a.txt',
          status: 'modified',
          before: { path: 'a.txt', blob: s.hidden.sha256, mode: 'file' },
          after: { path: 'a.txt', blob: s.original.sha256, mode: 'file' },
        },
      ],
    }),
  );
  const checks = JSON.stringify([{ candidateId: 'carried', paths: ['a.txt'], listing: located(s, listing) }]);
  let main = { head: s.baseline.sha256, state: located(s, s.baseline) };
  const marks = [];
  const ctx = {
    runQuery: async ref => {
      assert.equal(getFunctionName(ref), 'projectHostedConflicts:mainState');
      return main;
    },
    runMutation: async (ref, args) => {
      assert.equal(getFunctionName(ref), 'projectHostedLandingWouldConflict:mark');
      marks.push(args);
    },
  };
  const input = { projectId: s.projectId, paths: ['a.txt'], landedSubmissionId: 'landed' };
  return {
    s,
    checks,
    marks,
    input,
    pass: args => merge.wouldConflictConfig._handler(ctx, args),
    setMain: next => (main = next),
    fetchesOf: head => fetched.filter(key => key === head).length,
  };
}

test('two config passes on the same main head fetch its State once; a new head once more', async t => {
  const { s, checks, marks, input, pass, setMain, fetchesOf } = await cacheFixture(t);
  let head = s.baseline.sha256;
  const states = () => fetchesOf(head);

  await pass({ ...input, checks });
  await pass({ ...input, checks });
  assert.equal(states(), 1, 'one State fetch for two passes on the same head');
  assert.deepEqual(
    marks.map(mark => mark.same),
    [[{ candidateId: 'carried', paths: ['a.txt'] }], [{ candidateId: 'carried', paths: ['a.txt'] }]],
    'the cached entries give the same byte answer',
  );
  assert.deepEqual(marks[0].declared, marks[1].declared);
  // A lists-only pass on the same head reads no State either.
  await pass(input);
  assert.equal(states(), 1);
  assert.equal(marks[2].same, undefined);

  // Main moves: the new head's State is fetched once, then cached again.
  const moved = s.put(JSON.stringify({ ...s.state, parents: [s.baseline.sha256], message: 'moved' }));
  setMain({ head: moved.sha256, state: located(s, moved) });
  head = moved.sha256;
  await pass({ ...input, checks });
  await pass({ ...input, checks });
  assert.equal(states(), 1, 'the new head is fetched once');
  assert.deepEqual(marks[4].same, [{ candidateId: 'carried', paths: ['a.txt'] }]);
});

test('a lists-only read of a main past the path cap keeps no entries either', async t => {
  const { s, checks, marks, input, pass, setMain, fetchesOf } = await cacheFixture(t);
  // A main of 20,001 paths: past CACHED_MAIN_PATHS (20,000), well under the 16 MiB State cap.
  const files = [
    ...s.state.files,
    ...Array.from({ length: 20_001 - s.state.files.length }, (_, i) => ({
      path: `bulk/${String(i).padStart(5, '0')}.txt`,
      blob: s.hidden.sha256,
      mode: 'file',
    })),
  ].sort((a, b) => a.path.localeCompare(b.path));
  const big = s.put(JSON.stringify({ ...s.state, parents: [s.baseline.sha256], files, message: 'big' }));
  setMain({ head: big.sha256, state: located(s, big) });
  await pass(input);
  assert.equal(fetchesOf(big.sha256), 1);
  // Uncapped, that lists-only read would have kept all 20,001 entries and this pass would read none.
  await pass({ ...input, checks });
  assert.equal(fetchesOf(big.sha256), 2, 'the lists-only read kept no entries past the cap');
  // The checks pass keeps its own paths, so the next one on this head reads nothing.
  await pass({ ...input, checks });
  assert.equal(fetchesOf(big.sha256), 2);
  assert.deepEqual(
    marks.map(mark => mark.same),
    [
      undefined,
      [{ candidateId: 'carried', paths: ['a.txt'] }],
      [{ candidateId: 'carried', paths: ['a.txt'] }],
    ],
  );
});
