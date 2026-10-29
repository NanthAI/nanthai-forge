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
import {
  githubActionsRunsOnSchema,
  githubActionsRunnerDescription,
} from '../dist/github-actions-runner-label.js';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
import { githubActionsWorkflow } from '../dist/github-actions-workflow.js';
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

test('runner label schemas preserve strings and all-of arrays and reject malformed labels', () => {
  for (const runsOn of [
    'ubuntu-latest',
    'blacksmith-4vcpu-ubuntu-2404',
    'GPU pool A',
    'x'.repeat(256),
    ['self-hosted', 'linux', 'x64'],
    Array(100).fill('linux'),
  ]) {
    assert.deepEqual(githubActionsRunsOnSchema.parse(runsOn), runsOn);
    assert.deepEqual(
      hostedAgentCommandSchemas['configure-runner'].parse({ provider: 'github-actions', runsOn }).runsOn,
      runsOn,
    );
  }
  for (const runsOn of [
    '',
    '  ',
    'bad\nlabel',
    'bad\u0000label',
    [],
    [''],
    ['linux', 42],
    42,
    null,
    {},
    'x'.repeat(257),
    Array(101).fill('linux'),
  ])
    assert.equal(githubActionsRunsOnSchema.safeParse(runsOn).success, false);
  assert.equal(githubActionsRunnerDescription('ubuntu-latest'), 'runner: ubuntu-latest');
  assert.equal(githubActionsRunnerDescription('windows-2025'), 'runner: windows-2025');
  assert.equal(githubActionsRunnerDescription('macos-26'), 'runner: macos-26');
  assert.equal(
    githubActionsRunnerDescription('blacksmith-4vcpu-ubuntu-2404'),
    'runner: blacksmith-4vcpu-ubuntu-2404 (not GitHub-hosted: billed by your runner provider)',
  );
  assert.match(
    githubActionsRunnerDescription(['self-hosted', 'linux', 'x64']),
    /runner: \["self-hosted","linux","x64"\].*billed by your runner provider/,
  );
  // The existing exporter naturally serializes an array as YAML's JSON subset.
  assert.equal(
    (githubActionsWorkflow(['self-hosted', 'linux']).match(/runs-on: \["self-hosted","linux"\]/g) ?? [])
      .length,
    2,
  );
});
