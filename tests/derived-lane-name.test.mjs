// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { derivedLaneName, displayLaneName } from '../dist/lane-name.js';
const outcome =
  'Preserve exact check evidence when a long-running agent changes source and the first attempt fails near the end of the retained output';
test('derived Lane names end at a word boundary with an ellipsis, and full outcomes remain displayable', () => {
  const name = derivedLaneName(outcome);
  assert(name.endsWith('…'));
  assert(name.length <= 120);
  assert(outcome.startsWith(name.slice(0, -1) + ' '));
  assert.equal(displayLaneName(name, outcome), outcome);
  assert.equal(displayLaneName(outcome.slice(0, 120), outcome), outcome);
  assert.equal(displayLaneName('Custom Lane', outcome), 'Custom Lane');
  assert.equal(derivedLaneName('Short outcome'), 'Short outcome');
  assert(derivedLaneName('😀 '.repeat(50)).length <= 120);
});
