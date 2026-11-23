// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 65b6d701 (review): a plan-visibility history row holds the default policy on a project that never stored a
// policy. The live line must not read it as a policy receipt: it would add a free-slot count and a queue read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { lineChecks } = await import(moduleUrl('../convex/projectLiveLineChecks.ts'));
const { policyPreset } = await import(moduleUrl('../src/autonomy-policy.ts'));

const db = latest => {
  const reads = [];
  const query = table => ({
    withIndex: () => ({
      order: () => ({ first: async () => (reads.push(table), latest) }),
      unique: async () => (reads.push(table), null),
    }),
  });
  return { db: { query }, reads };
};

test('a plan-visibility row is not a policy receipt on a legacy project: no free-slot count, no queue read', async () => {
  const row = { planChange: { from: 'public', to: 'members' }, policy: policyPreset('trusted') };
  const legacy = db(row);
  assert.deepEqual(await lineChecks(legacy.db, { _id: 'p' }, []), { runs: [] });
  assert.deepEqual(legacy.reads, ['projectPolicyChanges']);
  // With a stored policy the receipt and the project agree, so the queue is read as before.
  const stored = db(row);
  await lineChecks(stored.db, { _id: 'p', autonomyPolicy: row.policy }, []);
  assert.deepEqual(stored.reads, ['projectPolicyChanges', 'projectHostedLandingQueues']);
});
