// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { policyPreset, autonomyPolicySchema, policyWriteSchema } from '../dist/autonomy-policy.js';
import { acceptancePolicyDigest } from '../dist/policy-digest.js';

test('unchecked policy readers retain old and expanded policy evidence and allow the expanded writer after the reader rollout', () => {
  const old = policyPreset('trusted');
  assert.equal(autonomyPolicySchema.parse(old).acceptance.withoutCheck, undefined);
  for (const mode of ['owner', 'selected', 'writers']) {
    const withoutCheck = { mode, people: ['account'], teams: ['team'] };
    const policy = { ...old, acceptance: { ...old.acceptance, withoutCheck } };
    assert.deepEqual(autonomyPolicySchema.parse(policy).acceptance.withoutCheck, withoutCheck);
    assert.equal(
      acceptancePolicyDigest(policy),
      acceptancePolicyDigest(old),
      'live person authority never invalidates checked landing evidence',
    );
  }
});

test('a mode-only CLI selection needs no unused picker lists', () => {
  const command = policyWriteSchema.parse({
    action: 'set-policy',
    operationId: '00000000-0000-4000-8000-000000000001',
    acceptance: { withoutCheck: { mode: 'writers' } },
  });
  assert.deepEqual(command.acceptance.withoutCheck, { mode: 'writers', people: [], teams: [] });
});
