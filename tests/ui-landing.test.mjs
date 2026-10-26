// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { hubs, exampleWork, exampleBriefContext, exampleIds } = await import(
  moduleUrl('../web/src/landing/example.ts')
);
const { cockpitLanes } = await import(moduleUrl('../web/src/cockpit/model.ts'));
const { renderBriefing } = await import('../dist/agent-brief-render.js');

const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'test/a.test.ts', 'README.md'];
const edges = [
  { from: 'src/a.ts', to: 'src/b.ts' },
  { from: 'src/c.ts', to: 'src/b.ts' },
  { from: 'test/a.test.ts', to: 'src/a.ts' },
];

test('hubs rank source files by importers and leave tests and docs out', () => {
  assert.deepEqual(hubs(files, edges), ['src/b.ts', 'src/a.ts', 'src/c.ts']);
  assert.deepEqual(hubs(['README.md'], []), ['README.md']);
});

test('the example is deterministic, uses real paths and overlaps on the busiest file', () => {
  const input = {
    repository: 'owner/repo',
    files,
    edges,
    instructionFiles: ['AGENTS.md'],
    now: Date.parse('2026-10-14T12:00:00Z'),
  };
  const a = exampleWork(input),
    b = exampleWork(input);
  assert.deepEqual(a, b);
  const lanes = cockpitLanes(a.records);
  assert.deepEqual(lanes.map(lane => lane.tone).sort(), ['active', 'failed', 'passed']);
  const claimed = a.claims.map(claim => claim.paths);
  assert.ok(
    claimed.every(paths => paths.includes('src/a.ts')),
    'both agents claim the same real file',
  );
  assert.equal(a.unacked[0].command.kind, 'message');
});

test('the example briefing names detected instruction files and plain paths', () => {
  const input = {
    repository: 'owner/repo',
    files,
    edges,
    instructionFiles: ['AGENTS.md', 'CLAUDE.md'],
    now: 0,
  };
  const brief = renderBriefing(
    {
      situation: 'fix-failed-check',
      laneId: exampleIds.lanes[1],
      runId: exampleIds.runs[0],
      agent: 'claude-code',
    },
    exampleBriefContext(input, exampleWork(input)),
    './repo',
    '2026-10-14T12:00:00Z',
  );
  assert.match(brief.copyText, /Follow this repo's AGENTS\.md and CLAUDE\.md/);
  assert.match(brief.copyText, /Files: src\/a\.ts, src\/c\.ts/);
  assert.doesNotMatch(brief.copyText, /\[|✖/);
  const none = renderBriefing(
    { situation: 'fix-failed-check', laneId: exampleIds.lanes[1], agent: 'codex' },
    exampleBriefContext({ ...input, instructionFiles: [] }, exampleWork(input)),
    './repo',
    '2026-10-14T12:00:00Z',
  );
  assert.doesNotMatch(none.copyText, /Follow this repo/);
});

const { createRiver, aliveDefaults } = await import(moduleUrl('../web/src/landing/alive-world.ts'));
const riverColors = {
  trunk: '#777777',
  agent: '#888888',
  person: '#2fb8a9',
  you: '#ff6b3d',
  passed: '#5fd39a',
  conflict: '#c79bff',
};

test('the seeded hero stays finite through handoff, conflict and landing, with bounded history', () => {
  const options = { ...aliveDefaults, conflictChance: 1, acceptChance: 1 };
  const world = createRiver(1500, 700, riverColors, options);
  const replay = createRiver(1500, 700, riverColors, options);
  const seen = new Set();
  for (let frame = 0; frame < 120 * 60; frame++) {
    world.step(1 / 60);
    replay.step(1 / 60);
    for (const effect of world.effects) seen.add(effect.kind);
    for (const thread of world.threads) {
      assert.ok(Number.isFinite(thread.x) && Number.isFinite(thread.y));
      assert.ok(thread.trail.length <= 542, 'old trail samples are released');
    }
  }
  assert.deepEqual([...seen].sort(), ['conflict', 'hand', 'land', 'pulse']);
  assert.ok(world.threads.length < 30, 'completed threads are released');
  assert.deepEqual(world.threads, replay.threads, 'same seed and steps give the same film');
});

test('the hero remains composed on a narrow screen with people, agents and an orange handoff', () => {
  const world = createRiver(390, 460, riverColors);
  for (let frame = 0; frame < 14 * 60; frame++) world.step(1 / 60);
  assert.equal(world.trunkY, Math.round(460 * 0.58));
  assert.ok(world.threads.some(t => t.kind === 'you'));
  assert.ok(world.threads.some(t => t.kind === 'agent' && t.nodes.length));
  assert.ok(world.threads.some(t => t.kind === 'person'));
});
