// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { workSchema } from '../dist/work-types.js';
import {
  applyHostedEvent,
  metadataRequest,
  parseWorkBytes,
  validateWorkSize,
  workBytes,
  workDigest,
} from '../dist/work-metadata.js';
import { ConvexExchange } from '../dist/exchange-client.js';
import { CUTOVER_UPGRADE } from '../dist/cutover-version.js';

const retired = await import(moduleUrl('../convex/projectSourceReturn.ts'));
const supersede = await import(moduleUrl('../convex/projectReturnSupersede.ts'));

// The old RPCs cannot discover authority, resume a cursor or publish old staging.
test('installed source-return and supersede clients receive the cutover upgrade error without IO', async () => {
  let accesses = 0;
  const ctx = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === 'auth') return { getUserIdentity: async () => ({ subject: 'owner' }) };
        accesses++;
        throw Error('retired endpoint performed IO');
      },
    },
  );
  for (const mode of ['server', 'native-owner', 'server-shadow']) {
    for (const epoch of [0, 1, 2]) {
      const input = {
        projectId: 'project',
        backupId: 'candidate',
        expectedBackupId: 'old',
        revision: 3,
        operationId: randomUUID(),
        continuation: true,
        statusOnly: true,
      };
      for (const invoke of [
        () => retired.returnSource._handler(ctx, input),
        () =>
          supersede.supersede._handler(ctx, {
            projectId: 'project',
            operationId: input.operationId,
            pushOperationId: randomUUID(),
            expectedBackupId: 'old',
            revision: 3,
            replacementId: randomUUID(),
          }),
      ]) {
        for (let retry = 0; retry < 2; retry++)
          await assert.rejects(invoke(), error => {
            assert.equal(error.data?.code, 'CLI_UPGRADE_REQUIRED', `${mode} epoch ${epoch}`);
            assert.equal(error.data.message, CUTOVER_UPGRADE);
            return true;
          });
      }
    }
  }
  assert.equal(accesses, 0);
  assert.equal(ConvexExchange.prototype.returnSource, undefined);
});

test('historic source-return journal events retain original digest and replay validation', () => {
  const data = workSchema.parse({
    schema: 11,
    revision: 3,
    nativeHead: 'a'.repeat(64),
    intents: [],
    lanes: [],
    views: [],
  });
  const command = {
    action: 'source-return',
    archiveSha256: 'b'.repeat(64),
    workSha256: workDigest(data),
    previousArchiveSha256: 'c'.repeat(64),
    previousRevision: 2,
  };
  const event = {
    id: randomUUID(),
    projectKey: randomUUID(),
    actor: 'owner',
    at: '2026-01-01T00:00:00.000Z',
    archiveSha256: command.archiveSha256,
    previousRevision: 3,
    command,
    request: metadataRequest(command),
  };
  const tampered = structuredClone(data);
  tampered.revision++;
  assert.throws(() => applyHostedEvent(tampered, { ...event, previousRevision: 4 }), {
    code: 'INVALID_WORK_JOURNAL',
  });
  applyHostedEvent(data, event);
  validateWorkSize(data);
  const restored = parseWorkBytes(Buffer.from(workBytes(data)));
  assert.deepEqual(restored.hostedEvents, [event]);
  assert.equal(restored.revision, 4);
});
