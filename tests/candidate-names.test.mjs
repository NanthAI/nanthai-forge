// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolve } from 'node:path';

import { candidateActions, candidateCommand } from '../dist/candidate-names.js';

const cliPath = resolve('dist/cli.js');
test('aliases normalize only actions; stored identifiers and parameter bytes remain stable', () => {
  for (const [old, current] of Object.entries(candidateActions)) {
    const input = {
      action: current,
      viewId: 'unchanged',
      dependencies: [{ kind: 'view', viewId: 'unchanged' }],
    };
    assert.deepEqual(candidateCommand(input), { ...input, action: old });
  }
  assert.equal(candidateCommand(null), null);
});
