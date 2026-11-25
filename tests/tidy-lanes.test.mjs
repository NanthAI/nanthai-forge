// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { tidyLanes } from '../scripts/tidy-lanes.mjs';

function fake(calls) {
  let batches = 2;
  return (_root, _verb, action, command) => {
    calls.push([action, command.apply ?? false]);
    if (action === 'lanes')
      return {
        isDone: true,
        page: [
          {
            laneId: 'a'.repeat(36),
            state: 'active',
            landing: null,
            intent: 'goal',
            lastActivityAt: '2026-11-25T10:00:00Z',
          },
        ],
      };
    if (action === 'complete-merged') return { completed: ['x', 'y'] };
    if (!command.apply) return { abandonable: ['l1'], kept: [], next: 'go' };
    return { abandoned: batches-- > 0 ? ['l'] : [] };
  };
}

test('tidy-lanes lists and only reads without --apply (friction fc3fcc3a)', () => {
  const calls = [];
  const lines = [];
  const result = tidyLanes(['--root', '.'], fake(calls), line => lines.push(line));
  assert.deepEqual(result, { completed: 0, abandoned: 0 });
  assert.deepEqual(
    calls.map(call => call[0]),
    ['lanes', 'abandon-dormant'],
  );
  assert(lines.some(line => line.includes('Dry run')));
});

test('tidy-lanes --apply completes merged Lanes and abandons dormant ones until none remain (friction fc3fcc3a)', () => {
  const calls = [];
  const result = tidyLanes(['--root', '.', '--apply'], fake(calls), () => {});
  assert.deepEqual(result, { completed: 2, abandoned: 2 });
  assert.deepEqual(
    calls.map(call => call.join(':')),
    [
      'lanes:false',
      'abandon-dormant:false',
      'complete-merged:false',
      'abandon-dormant:true',
      'abandon-dormant:true',
      'abandon-dormant:true',
    ],
  );
});
