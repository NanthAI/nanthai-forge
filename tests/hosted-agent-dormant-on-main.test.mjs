// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { onMainProof } from '../dist/hosted-agent-dormant.js';

const file = (blob, mode = 'file') => ({ blob, mode });
const main = new Map([
  ['src/a.ts', file('a1')],
  ['bin/run', file('r1', 'executable')],
]);

test('a Lane is on main when every changed path holds the Lane bytes there', () => {
  assert.equal(onMainProof([{ path: 'src/a.ts', after: file('a1') }], main), true);
  assert.equal(
    onMainProof(
      [
        { path: 'src/a.ts', after: file('a1') },
        { path: 'bin/run', after: file('r1', 'executable') },
      ],
      main,
    ),
    true,
  );
});

test('different bytes, a different mode or a path main lacks keep the Lane', () => {
  assert.equal(onMainProof([{ path: 'src/a.ts', after: file('other') }], main), false);
  assert.equal(onMainProof([{ path: 'bin/run', after: file('r1', 'file') }], main), false);
  assert.equal(onMainProof([{ path: 'src/new.ts', after: file('n1') }], main), false);
  assert.equal(
    onMainProof(
      [
        { path: 'src/a.ts', after: file('a1') },
        { path: 'src/new.ts', after: file('n1') },
      ],
      main,
    ),
    false,
    'one path off main keeps the whole Lane',
  );
});

test('a deleted path counts only when main lacks it; no changes left means nothing unlanded', () => {
  assert.equal(onMainProof([{ path: 'gone.ts', after: null }], main), true);
  assert.equal(onMainProof([{ path: 'src/a.ts', after: null }], main), false);
  assert.equal(onMainProof([], main), true);
});
