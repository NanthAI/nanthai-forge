// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { recoveryAdviceFindings } from '../scripts/check-recovery-advice.mjs';

test('backend conflict advice rejects ambiguous local commands across conflict kinds and modules', () => {
  for (const code of ['COMPOSITION_CONFLICT', 'CONFLICT_MARKERS', 'RESOLUTION_REQUIRED'])
    for (const root of ['.', 'ROOT', "'.'", '"ROOT"'])
      assert.equal(
        recoveryAdviceFindings('convex/anotherConflictOwner.ts', `${code}: nforge agent ${root} sync '{}'`)
          .length,
        1,
      );
  assert.equal(
    recoveryAdviceFindings(
      'convex/separateAdvice.ts',
      "import { CONFLICT_MARKERS } from './codes'; const message = 'nforge agent . resolve';",
    ).length,
    1,
    'an imported error code must not evade the guard when its value lives elsewhere',
  );
});
test('exact client continuations and backend conflict evidence remain allowed', () => {
  assert.deepEqual(
    recoveryAdviceFindings('convex/help.ts', 'Generic setup help: nforge agent ROOT start'),
    [],
  );
  assert.deepEqual(
    recoveryAdviceFindings('src/client.ts', 'COMPOSITION_CONFLICT: nforge agent ROOT sync'),
    [],
  );
  assert.deepEqual(
    recoveryAdviceFindings(
      'convex/conflict.ts',
      'COMPOSITION_CONFLICT: Candidate synthetic conflicts in a.txt. Continue with the receipt recovery command.',
    ),
    [],
  );
  assert.deepEqual(
    recoveryAdviceFindings(
      'convex/conflict.ts',
      "COMPOSITION_CONFLICT: nforge agent '/synthetic/lane' resolve '{}'",
    ),
    [],
  );
});
