// SPDX-License-Identifier: Apache-2.0
import { ancestryFixture } from './source-ancestry-fixture.mjs';

export function generationGraph(kind, count, conflicting = false) {
  const s = ancestryFixture({ generationMetadata: true }),
    base = [s.file('f', 'base\n')],
    historical = [];
  for (let i = 0; i < count; i++)
    historical.push(s.state([], kind === 'closed-side' && i ? [historical[i - 1]] : [], `H${i}`));
  const c = s.state(base, kind === 'closed-side' ? historical.slice(-1) : historical, 'C'),
    b = s.state(base, [c], 'B');
  let shared = c;
  for (let i = 0; i < (kind === 'closed-side' ? 2 : 10); i++) shared = s.state(base, [shared], `Q${i}`);
  const u = s.state(base, [], 'U'),
    left = s.state([s.file('f', 'left\n')], [shared, b], 'M'),
    right = s.state(
      conflicting ? [s.file('f', 'right\n')] : [...base, s.file('r', 'right\n')],
      kind === 'closed-side' ? [shared, u] : [shared],
      'D',
    );
  return { s, left, right, historical, initial: s.plan(left, [right]) };
}

// Review B1: the failed generation-5 X4 must not starve readable generation-1 Q.
// Fan-out adds one equally common generation-5 sibling with large manifests.
export function generationFailureGraph({ privateBranch = false, fanout = false } = {}) {
  const s = ancestryFixture({ generationMetadata: true }),
    base = [s.file('f', 'base\n')],
    big = fanout
      ? Array.from({ length: 29000 }, (_, i) => ({
          ...base[0],
          path: `src/deep/shared/components/features/generated/module-${String(i).padStart(6, '0')}.ts`,
        }))
      : [];
  let x;
  for (let i = 0; i < 4; i++) x = s.state([], x ? [x] : [], `X${i}`);
  const failed = s.state(big, [x], 'X4'),
    sibling = fanout ? s.state(big, [x], 'Y4') : null,
    q = s.state(base, [], 'Q'),
    left = s.state([s.file('f', 'left\n')], [q, failed, ...(sibling ? [sibling] : [])], 'L'),
    right = s.state(
      [...base, s.file('r', 'right\n')],
      privateBranch ? [q] : [failed, ...(sibling ? [sibling] : [])],
      'R',
    );
  return { s, failed, q, initial: s.plan(left, [right]) };
}
