// SPDX-License-Identifier: Apache-2.0
// Bench disk gate: macOS purgeable space counts as free (2026-11-18, the C' smoke cell was
// refused at 20.8 GB by df while 82.7 GB was available).
import test from 'node:test';
import assert from 'node:assert/strict';
import { diskFreeGb } from '../scripts/bench-t3code/gates.mjs';

test('disk gate on macOS uses important-usage capacity, which includes purgeable space', () => {
  assert.equal(diskFreeGb({ platform: 'darwin', important: () => 77, df: () => 19.4 }), 77);
});

test('disk gate falls back to df when the important-usage read fails or is empty', () => {
  const df = () => 19.4;
  assert.equal(
    diskFreeGb({
      platform: 'darwin',
      important: () => {
        throw new Error('no osascript');
      },
      df,
    }),
    19.4,
  );
  assert.equal(diskFreeGb({ platform: 'darwin', important: () => null, df }), 19.4);
  assert.equal(diskFreeGb({ platform: 'linux', important: () => 77, df }), 19.4);
});
