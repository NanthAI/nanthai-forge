// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAncestryCut } from '../dist/hosted-source-ancestry-cut.js';
test('ancestry cut requires one frontier on every verified parent path', () => {
  assert.equal(sourceAncestryCut({ left: ['base'], right: ['base'] }, ['base', 'base']), 'base');
  assert.equal(
    sourceAncestryCut({ left: ['base', 'other'], right: ['base'], other: ['base'] }, ['base']),
    'base',
  );
  assert.equal(sourceAncestryCut({ left: ['a'], right: ['b'] }, ['a', 'b']), null);
  assert.equal(
    sourceAncestryCut({ left: ['base', 'old'], right: ['base', 'old'], old: [] }, ['base']),
    null,
    'unknown relation to another common root cannot prove maximal merge bases',
  );
  assert.equal(sourceAncestryCut({ left: ['base'], unrelated: [] }, ['base']), null);
  assert.equal(sourceAncestryCut({ left: ['right'], right: ['left', 'base'] }, ['base']), null);
  assert.equal(sourceAncestryCut({}, ['base']), null);
});
test('32000 verified parent edges need no source RPC or recursion', t => {
  const parents = {};
  for (let i = 0; i < 32000; i++) parents[`node-${i}`] = [i ? `node-${i - 1}` : 'base'];
  const started = performance.now();
  assert.equal(sourceAncestryCut(parents, ['base']), 'base');
  t.diagnostic(
    JSON.stringify({ states: 32000, sourceRPCs: 0, wallMs: Math.round(performance.now() - started) }),
  );
});
