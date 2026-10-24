// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
const { readWorkRecord } = await import(moduleUrl('../web/src/hosted-work-index.ts'));
test('browser payload reads retry source returns under the same public generation without combining revisions', async () => {
  let revision = 1,
    details = 0;
  const client = {
    query: async ref => {
      if (getFunctionName(ref) === 'projectWorkIndex:detail') {
        details++;
        return {
          generationId: 'stable',
          revision,
          value: JSON.stringify({ payloadKey: 'payload', payloadParts: 1 }),
        };
      }
      revision = 2;
      return {
        generationId: 'stable',
        revision,
        page: [
          { id: 'part', position: 0, value: JSON.stringify({ id: 'selected', retained: 'new source' }) },
        ],
        isDone: true,
        continueCursor: '',
      };
    },
  };
  const value = await readWorkRecord(client, 'project', { generationId: 'stable' }, 'views', 'selected');
  assert.deepEqual(value, { id: 'selected', retained: 'new source' });
  assert.equal(details, 3, 'rereads the header and confirms the completed payload revision');
});

test('CLI workspace/page and workspace/detail races reject a changed source revision under the stable generation', async () => {
  const { dispatchHostedWork } = await import('../dist/hosted-work-client.js');
  const client = {
    query: async ref => {
      const name = getFunctionName(ref);
      if (name === 'projectWorkIndex:workspace')
        return JSON.stringify({ generationId: 'stable', backupId: 'old', revision: 1, sourceRevision: 1 });
      if (name === 'projectWorkIndex:detail')
        return { generationId: 'stable', revision: 2, value: JSON.stringify({ id: 'selected' }) };
      return { generationId: 'stable', revision: 2, page: [], isDone: true, continueCursor: '' };
    },
  };
  for (const request of [
    { action: 'records', collection: 'views' },
    { action: 'detail', collection: 'views', id: 'selected' },
  ])
    await assert.rejects(
      dispatchHostedWork(client, 'project', request),
      error => error.code === 'WORK_STALE',
    );
});
