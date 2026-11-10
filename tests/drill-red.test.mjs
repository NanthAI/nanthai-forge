// SPDX-License-Identifier: Apache-2.0
// Red-audit drill (Issue fe7d67a8): this test passes alone and fails once its pair file lands, so the
// two landings together make one deliberate red main audit for the recovery path to fix. The path
// is built at run time on purpose (no static edge). Removed after the drill.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

test('red-audit drill (fe7d67a8): fails only while its pair file is on main', () => {
  const pair = new URL(`./${['drill', 'red', 'pair'].join('-')}.txt`, import.meta.url);
  assert.equal(existsSync(pair), false);
});
