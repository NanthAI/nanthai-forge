// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { hubs, exampleWork, exampleBriefContext, exampleIds } = await import(
  moduleUrl('../web/src/explore/example.ts')
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

// J34-4/J34-7/J34-8: links lead to the mirror and the docs destination; the first-run guide covers either landing policy.
test('public frame links to the current mirror and status; signed-out app routes point back to the public page', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { PublicFrame } = await import(moduleUrl('../web/src/shell/PublicFrame.tsx'));
  const html = renderToStaticMarkup(createElement(PublicFrame, { children: 'Example' }));
  assert.match(html, /href="https:\/\/github.com\/NanthAI\/nanthai-forge#readme"/);
  assert.match(html, /href="\/docs\/status\/">Development status/);
  assert.doesNotMatch(html, /github.com\/nanthai\/forge/);
  // The public page itself is static HTML; tests/landing-page.test.mjs checks its links.
  const { SignedOut } = await import(moduleUrl('../web/src/explore/SignedOut.tsx'));
  const signedOut = renderToStaticMarkup(createElement(SignedOut, {}));
  assert.match(signedOut, /Sign in to open your projects/);
  assert.match(signedOut, /href="\/">What Forge is/);
});

test('first-run step three explains automatic landings and approvals only when required', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { FirstRun } = await import(moduleUrl('../web/src/cockpit/FirstRun.tsx'));
  const html = renderToStaticMarkup(createElement(FirstRun, { newIntent: () => {} }));
  assert.match(html, /Watch it land/);
  assert.match(html, /lands automatically if the project allows it/);
  assert.match(html, /If approval is required/);
  assert.doesNotMatch(html, /When the check passes, Needs you asks for one decision/);
});
