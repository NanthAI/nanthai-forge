// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { autonomyPolicySchema, editedPolicy, policyPreset } from '../dist/autonomy-policy.js';

test('owner refresh, runner and GitHub policy edits each mark custom and preserve the other settings', () => {
  const githubMirror = { repo: 'example/project', autoPush: true, laneRefs: false };
  const previous = {
    ...policyPreset('trusted'),
    checks: { runner: 'local' },
    ownerRootUpdates: true,
    githubMirror,
  };
  for (const fields of [
    { ownerRootUpdates: false },
    { checks: { runner: 'github-actions', repo: 'synthetic/checks' } },
    { githubMirror: { ...githubMirror, autoPush: false } },
    { githubMirror: { ...githubMirror, inbound: true } },
  ]) {
    const edited = editedPolicy(previous, {
      action: 'set-policy',
      operationId: randomUUID(),
      ...fields,
    });
    assert.equal(edited.preset, 'custom');
    assert.equal(edited.ownerRootUpdates, fields.ownerRootUpdates ?? previous.ownerRootUpdates);
    // A runner edit also records the default manual laptop fallback.
    assert.deepEqual(
      edited.checks,
      fields.checks ? { fallback: 'manual', ...fields.checks } : previous.checks,
    );
    assert.deepEqual(edited.githubMirror, fields.githubMirror ?? previous.githubMirror);
  }
  // Two-way sync rides on the mirror: inbound without autoPush is refused.
  const mirror = autonomyPolicySchema.shape.githubMirror;
  assert(!mirror.safeParse({ ...githubMirror, autoPush: false, inbound: true }).success);
  assert(mirror.safeParse({ ...githubMirror, inbound: false, autoPush: false }).success);
});

test('acceptance.autoRevert: absent means on, no preset sets it, a field edit merges it', async () => {
  const { autoRevertEnabled, autoRevertHold } = await import('../dist/auto-revert-policy.js');
  for (const preset of ['supervised', 'trusted', 'autonomous'])
    assert.equal(policyPreset(preset).acceptance.autoRevert, undefined, `${preset} leaves it absent`);
  const trusted = policyPreset('trusted');
  assert.equal(autoRevertEnabled(trusted), true);
  const off = editedPolicy(trusted, {
    action: 'set-policy',
    operationId: randomUUID(),
    acceptance: { autoRevert: false },
  });
  assert.equal(off.acceptance.autoRevert, false);
  assert.equal(off.preset, 'custom');
  assert.equal(autoRevertEnabled(off), false);
  assert.equal(off.acceptance.mode, trusted.acceptance.mode, 'other acceptance fields are kept');
  const on = editedPolicy(off, {
    action: 'set-policy',
    operationId: randomUUID(),
    acceptance: { autoRevert: true },
  });
  assert.equal(autoRevertEnabled(on), true);
  // Hold rule: the landing queue's own rule for the owner's agent, on culprit and reverse paths.
  const project = { owner: 'owner' };
  const guarded = editedPolicy(trusted, {
    action: 'set-policy',
    operationId: randomUUID(),
    acceptance: { protectedPaths: ['convex/**'] },
  });
  const hold = (policy, culpritPaths, reversePaths) =>
    autoRevertHold({ project, policy, culpritPaths, reversePaths });
  assert.equal(hold(guarded, ['src/a.ts'], ['src/a.ts']), null);
  assert.match(hold(guarded, ['src/a.ts', 'convex/x.ts'], ['src/a.ts']), /protected paths: convex\/x\.ts/);
  assert.match(hold(guarded, ['src/a.ts'], ['convex/x.ts']), /protected paths: convex\/x\.ts/);
  assert.match(hold(guarded, ['src/a.ts'], null), /coverage is unavailable/);
  assert.match(hold(guarded, null, ['.github/workflows/ci.yml']), /protected/);
  assert.equal(hold(guarded, null, ['src/a.ts']), null, 'unknown culprit paths defer to the reverse paths');
});
