// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from 'convex-helpers/validators';
import { moduleUrl } from './convex-module.mjs';
import { autonomyPolicySchema, editedPolicy, policyPreset } from '../dist/autonomy-policy.js';

const { autonomyPolicy } = await import(moduleUrl('../convex/autonomyFields.ts'));

test('every policy field the CLI can write is storable in the hosted project document', () => {
  assert.deepEqual(
    Object.keys(autonomyPolicySchema.shape).filter(key => !(key in autonomyPolicy.fields)),
    [],
  );
});

test('the hosted GitHub mirror policy round-trips through the Convex validator', () => {
  const policy = editedPolicy(policyPreset('trusted'), {
    action: 'set-policy',
    operationId: crypto.randomUUID(),
    githubMirror: { repo: 'NanthAI/nanthai-forge', autoPush: true, laneRefs: false },
  });
  assert.equal(policy.githubMirror?.autoPush, true);
  assert.equal(validate(autonomyPolicy, policy), true);
});
