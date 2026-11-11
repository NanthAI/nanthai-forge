// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { metadataRequest } from '../dist/work-metadata.js';
const work = await import(moduleUrl('../convex/projectWorkStore.ts'));

test('Work projection replay reuses compact original command facts and rejects changed commands', async () => {
  const f = recordsFixture(),
    auth = await f.setup();
  const command = { action: 'note', kind: 'comment', intentId: randomUUID(), text: 'Original rationale' };
  const provenance = {
    projectId: auth.projectId,
    operationId: randomUUID(),
    request: metadataRequest(command),
    revision: 1,
    actor: 'owner',
    at: '2026-01-01T00:00:00.000Z',
    command: canonicalPayload(command),
  };
  const id = await f.ctx.db.insert('projectHostedRecordBodies', { ...provenance, value: '' });
  const before = await f.run('original projection reply', () =>
    work.storeProjection(f.ctx, auth.projectId, 'owner', [], undefined, provenance),
  );
  await f.ctx.db.patch(id, {
    command: undefined,
    journalSegment: '1',
    journalCommand: canonicalPayload({ action: 'note' }),
  });
  const replay = await f.run('compact projection reply', () =>
    work.storeProjection(f.ctx, auth.projectId, 'owner', [], undefined, provenance),
  );
  assert.deepEqual(
    { ...replay, command: JSON.parse(replay.command) },
    { ...before, command: JSON.parse(before.command) },
  );
  await assert.rejects(
    f.run('changed projection command', () =>
      work.storeProjection(f.ctx, auth.projectId, 'owner', [], undefined, {
        ...provenance,
        command: canonicalPayload({ ...command, text: 'Changed rationale' }),
      }),
    ),
    error => error.code === 'WORK_OPERATION_CHANGED',
  );
});
