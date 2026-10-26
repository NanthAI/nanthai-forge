// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
const model = await import(moduleUrl('../web/src/cockpit/delegate-model.ts'));
const { DelegateSubject } = await import(moduleUrl('../web/src/cockpit/DelegateSheet.tsx'));

const context = extra => ({
  paths: [],
  conflictPaths: [],
  instructionFiles: [],
  main: { head: null, changedPaths: [], merged: null },
  claims: [],
  messages: [],
  guidance: { project: '', personal: '' },
  coverage: [],
  ...extra,
});

test('the agent will know the conflict, main, overlaps, repo rules and guidance, and what it will not', () => {
  const rows = model.knowRows({
    situation: 'resolve-conflict',
    context: context({
      laneId: 'l1',
      paths: ['a.ts', 'b.ts'],
      conflictPaths: ['scripts/forge-check.mjs'],
      main: { head: 'h', changedPaths: ['scripts/forge-check.mjs', 'docs/a.md', 'docs/b.md'], merged: false },
      instructionFiles: ['AGENTS.md', '.cursor/rules/x.mdc'],
      guidance: { project: 'Keep changes small.', personal: '' },
    }),
  });
  assert.deepEqual(
    rows.map(row => row.key),
    ['conflict', 'main', 'claims', 'rules', 'guidance', 'off'],
  );
  assert.equal(rows[0].detail, 'scripts/forge-check.mjs');
  assert.equal(rows[1].detail, 'scripts/forge-check.mjs, docs/a.md and 1 more');
  assert.equal(rows[2].detail, 'no one right now');
  assert.equal(rows.at(-1).off, true);
  assert.ok(
    rows.every(row => row.source),
    'every fact names where it came from',
  );
  assert.match(
    model.goalNote({ situation: 'resolve-conflict', context: context({ conflictPaths: ['x.ts'] }) }),
    /main changed x\.ts after this Lane started/,
  );
  assert.equal(model.goalNote({ situation: 'continue-lane', context: context() }), '');
});

test('a failed check carries its first failure line; a new Intent carries its outcome', () => {
  const [failure] = model.knowRows({
    situation: 'fix-failed-check',
    context: context({
      run: { status: 'failed', check: 'verify', failureSummary: '\n✖ totals round (2ms)\nmore' },
    }),
  });
  assert.equal(failure.detail, '✖ totals round (2ms)');
  const [outcome] = model.knowRows({
    situation: 'start-intent',
    context: context({ intent: { outcome: 'Round tax', constraints: '', notes: [], status: 'active' } }),
  });
  assert.equal(outcome.detail, 'Round tax');
});

test('the continuing session picks its own agent type from the reported harness or tool', () => {
  assert.equal(model.agentOf('Codex CLI · build-box'), 'codex');
  assert.equal(model.agentOf('anything', 'claude-code'), 'claude-code');
  assert.equal(model.agentOf('VS Code'), 'generic');
});

test('the sheet header names the work by status, Lane and Intent', () => {
  const html = renderToStaticMarkup(
    h(DelegateSubject, {
      subject: { tone: 'conflict', label: 'Conflict', lane: 'check-scope', intent: 'Scope checks' },
    }),
  );
  assert.match(html, /Conflict/);
  assert.match(html, /check-scope/);
  assert.match(html, /Scope checks/);
});
