// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeTask, githubTask } from '../scripts/bench-t3code/coordination.mjs';

const forge = calls =>
  forgeTask({
    task: 'synthetic',
    calls,
    landing: { landed: true, operations: [] },
    session: { source: 'none', seen: [], actions: [] },
    laneTask: new Map(),
  });
const call = (verb, n, extra = {}) => ({
  verb: `agent ${verb}`,
  code: 0,
  endedAt: `2026-01-01T00:00:0${n}Z`,
  ...extra,
});
const conflict = n => call('land --save', n, { code: 2, errorCodes: ['COMPOSITION_CONFLICT'] });

test('GitHub coordination counters ignore advisory conflict prose', () => {
  const result = githubTask({
    task: 'synthetic',
    landing: { landed: true },
    runs: [],
    session: { actions: [], seen: ['EXACT CONFLICT (trial merge of saved files): a.ts'] },
  });
  assert.equal(result.conflictEpisodes, 0);
  assert.equal(result.mergeConflictOutputs, 0);
});

test('Forge counts land failure, retries, sync markers and failed resolution as one episode', () => {
  const result = forge([
    conflict(1),
    conflict(2),
    call('sync', 3, { conflictMarkers: true }),
    call('resolve', 4, { resolutionComplete: false }),
    call('sync', 5, { conflictMarkers: true }),
    call('resolve', 6),
    call('finish', 7, { operations: [{ receiptId: 'accepted' }] }),
  ]);
  assert.equal(result.conflictEpisodes, 1);
  assert.equal(result.syncConflicts, 1);
  assert.equal(result.conflictCalls, 4);
  assert.equal(result.clean, false);
});

test('Forge starts a new episode after successful resolution, including out-of-order log entries', () => {
  const result = forge([
    conflict(4),
    call('sync', 5, { conflictMarkers: true }),
    call('resolve', 3),
    conflict(1),
    call('sync', 2, { conflictMarkers: true }),
  ]);
  assert.equal(result.conflictEpisodes, 2);
  assert.equal(result.conflictCalls, 4);
  assert.equal(forge([call('land --help', 1)]).conflictEpisodes, 0);
});

test('GitHub counts files, repeated failed merge outputs and footer as one unresolved episode', () => {
  const result = githubTask({
    task: 'synthetic',
    landing: { landed: true },
    runs: [],
    session: {
      actions: [],
      seen: [
        'CONFLICT (content): Merge conflict in a.ts\nCONFLICT (content): Merge conflict in b.ts\nAutomatic merge failed; fix conflicts and then commit the result.',
        'CONFLICT (content): Merge conflict in a.ts',
        '[branch abcdef123] resolve merge\nCONFLICT (content): Merge conflict in c.ts',
      ],
    },
  });
  assert.equal(result.conflictEpisodes, 2);
  assert.equal(result.mergeConflicts, 2);
  assert.equal(result.mergeConflictOutputs, 3);
  assert.equal(result.reworkBecauseSibling, true);
});
