// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { landingAttemptForkFindings } from '../scripts/check-landing-attempt-forks.mjs';

test('8c9b84fc: foundation rejects reintroduced hand-built child ordinals including reserved finish installs', () => {
  for (const parent of ['current.id', 'pending.parentAttemptId']) {
    const source = `const child = { id: next(), parentAttemptId: ${parent}, number: pending.number };`;
    assert.equal(landingAttemptForkFindings('convex/projectHostedFinishCompose.ts', source).length, 1);
  }
  assert.equal(
    landingAttemptForkFindings(
      'convex/projectHostedLandingStore.ts',
      'function otherWriter() { return { parentAttemptId: old.id, number: old.number + 1 }; }',
    ).length,
    1,
  );
});

test('fork guard allows the one allocator, first attempts and non-attempt metadata', () => {
  assert.deepEqual(
    landingAttemptForkFindings(
      'convex/projectHostedLandingStore.ts',
      'export function forkLandingAttempt() { return { parentAttemptId: parent.id, number: parent.number + 1 }; }',
    ),
    [],
  );
  for (const source of [
    'const initial = { parentAttemptId: null, number: 0 };',
    'const retained = { parentAttemptId: pending.parentAttemptId, main: pending.main };',
    '// const wrong = { parentAttemptId: parent.id, number: 1 };',
    'type Pending = { parentAttemptId: string; number: number };',
  ])
    assert.deepEqual(landingAttemptForkFindings('convex/fixture.ts', source), []);
});
