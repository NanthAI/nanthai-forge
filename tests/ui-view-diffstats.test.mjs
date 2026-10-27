// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
const { readHostedView } = await import(moduleUrl('../web/src/views/source.ts'));
const args = {
  projectId: 'project',
  generationId: 'generation',
  action: 'view',
  viewId: 'view',
  paginationOpts: { cursor: null, numItems: 30 },
};
const metadata = {
  head: 'head',
  generationId: 'generation',
  changes: null,
  files: { items: [{ path: 'one' }] },
};

test('first View open uses one lazy action; subsequent opens reuse saved metadata', async () => {
  const counts = { files: 1, add: 2, del: 1, exact: true, provenance: 'server-computed' };
  let saved = null,
    actions = 0;
  const client = {
    query: async (ref, request) => {
      assert.equal(getFunctionName(ref), 'projectViewReads:read');
      assert.deepEqual(request, args);
      return JSON.stringify({ ...metadata, changes: saved });
    },
    action: async (ref, request) => {
      assert.equal(getFunctionName(ref), 'projectViewDiffstats:compute');
      assert.deepEqual(request, { projectId: 'project', generationId: 'generation', viewId: 'view' });
      actions++;
      saved = counts;
      return JSON.stringify(counts);
    },
  };
  assert.deepEqual((await readHostedView(client, args)).changes, counts);
  assert.deepEqual((await readHostedView(client, args)).changes, counts);
  assert.equal(actions, 1);
});

test('unavailable optional counts retain the View after a fresh authorized metadata read', async () => {
  let reads = 0,
    actions = 0;
  const client = {
    query: async () => {
      reads++;
      return JSON.stringify({ ...metadata, marker: reads });
    },
    action: async () => {
      actions++;
      throw new Error('SOURCE_UNAVAILABLE');
    },
  };
  const result = await readHostedView(client, args);
  assert.equal(result.changes, null, 'the detail shows not computed yet');
  assert.equal(result.marker, 2);
  assert.equal(result.files.items[0].path, 'one');
  assert.equal(actions, 1);
});

test('a revocation or generation race during optional computation remains an explicit read failure', async () => {
  for (const code of ['PROJECT_UNAVAILABLE', 'WORK_STALE']) {
    let reads = 0;
    const client = {
      query: async () => {
        if (++reads === 1) return JSON.stringify(metadata);
        throw new Error(code);
      },
      action: async () => {
        throw new Error('SOURCE_UNAVAILABLE');
      },
    };
    await assert.rejects(readHostedView(client, args), new RegExp(code));
    assert.equal(reads, 2);
  }
});
