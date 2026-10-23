// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  hostedCheckDefinition,
  importedHostedCheck,
  hostedCheckRunnerSchema,
  hostedCheckRequestSchema,
} from '../dist/hosted-check.js';
import { hostedCheckCallbackSchema } from '../dist/hosted-check-evidence.js';
import { recordEvidence } from '../dist/work-evidence.js';
import { command } from './hosted-checks-fixture.mjs';

test('hosted definitions retain the exact local normalization and definition digest', () => {
  const c = {
    ...command,
    env: ['TZ', 'LANG', 'TZ'],
    credentials: ['TOKEN_REF', 'TOKEN_REF'],
    artifactPaths: ['build/result.bin', 'build/result.bin'],
    static: false,
    measureResources: true,
    declaredInputs: [{ kind: 'environment', name: 'TZ' }],
  };
  const at = '2026-01-01T00:00:00.000Z',
    data = { schema: 5, checks: [] };
  const local = recordEvidence(data, { action: 'define-check', ...c }, at);
  const hosted = hostedCheckDefinition(c, local.id, at);
  assert.deepEqual(hosted, local);
  assert.deepEqual(importedHostedCheck(local), local);
  assert.throws(() => importedHostedCheck({ ...local, args: ['changed.mjs'] }), { code: 'EVIDENCE_CHANGED' });
});
test('hosted request/configuration schemas carry references and reject byte or verdict claims', () => {
  assert(!hostedCheckRunnerSchema.safeParse({ provider: 'local', credentials: 'value' }).success);
  assert(!hostedCheckRequestSchema.safeParse({ operationId: randomUUID(), status: 'passed' }).success);
  assert(!hostedCheckCallbackSchema.safeParse({ sourceVerdict: 'passed', stdout: 'untrusted' }).success);
});
