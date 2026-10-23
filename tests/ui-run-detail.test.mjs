// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { logLines, scopeLabel, cancellationResult, logCommand, liveRun, failureMarker } = await import(
  moduleUrl('../web/src/lane/run-model.ts')
);
const { checkStatus } = await import(moduleUrl('../web/src/ui/status.ts'));
test('terminal check outcomes are static and remain distinct from superseded evidence', () => {
  for (const status of ['cancelled', 'interrupted', 'superseded']) {
    assert.equal(checkStatus(status).tone, 'plain');
    assert.equal(liveRun(status), false);
    assert.equal(checkStatus(status).label.toLowerCase(), status);
  }
  for (const status of ['queued', 'preparing', 'running']) assert.equal(liveRun(status), true);
  assert.equal(checkStatus('failed').tone, 'failed');
});
test('log links use retained byte positions, including multibyte output and ANSI colour', () => {
  const lines = logLines({ offset: 16384, text: 'café\n\x1b[31m✖ failed\x1b[0m\npartial' });
  assert.equal(lines[1].offset, 16390);
  assert.equal(lines[1].text, '✖ failed');
  assert.equal(lines[2].text, 'partial');
  assert.match(logCommand('run', 'stderr', 16384), /"operationId":"run","stream":"stderr","offset":16384/);
});
test('scope is absent unless recorded, and cancellation reports a late original result', () => {
  assert.equal(scopeLabel(), '');
  assert.equal(scopeLabel({ mode: 'scoped', selectedTests: ['a', 'b'] }), 'Scoped · 2 tests');
  assert.equal(scopeLabel({ mode: 'full', selectedTests: [] }), 'Full suite');
  assert.equal(cancellationResult({ status: 'passed', cancelRequested: true }), 'Check passed.');
  assert.equal(cancellationResult({ status: 'cancelled' }), 'Check cancelled.');
  assert.match(cancellationResult({ status: 'running', cancelRequested: true }), /Waiting for the runner/);
});
test('byte pages leave a split UTF-8 failure glyph for the next page', async () => {
  const { checkLogPage } = await import('../dist/check-log-page.js');
  const bytes = Buffer.from('ok\n✖ test failed\n');
  const first = checkLogPage(bytes.subarray(0, 4), 0, bytes.length);
  assert.equal(first.text, 'ok\n');
  assert.equal(first.nextOffset, 3);
  const next = checkLogPage(bytes.subarray(first.nextOffset), first.nextOffset, bytes.length);
  assert.match(next.text, /^✖ test failed/);
  assert.equal(next.nextOffset, bytes.length);
});

test('failure markers cover project compiler and linter output without treating passes as failures', () => {
  assert(failureMarker('src/file.ts(3,1): error TS2322: wrong type'));
  assert(failureMarker('  3:1  error  unused variable  no-unused-vars'));
  assert(failureMarker('✖ source remains pinned'));
  assert(!failureMarker('✔ source remains pinned'));
});

test('Review accepts a compact hosted run summary without assuming a full check object', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ReviewCheck } = await import(moduleUrl('../web/src/lane/ReviewCheck.tsx'));
  const html = renderToStaticMarkup(
    createElement(ReviewCheck, {
      run: {
        id: 'run',
        viewId: 'view',
        head: 'a'.repeat(64),
        status: 'failed',
        checkName: 'verify',
        startedAt: '2026-10-15T10:00:00Z',
      },
      head: 'a'.repeat(64),
    }),
  );
  assert.match(html, /verify/);
  assert.match(html, /Failed/);
  assert.match(html, /exactly this Candidate/);
});
test('failed Lane check metadata is compact and does not repeat empty overlap or banner content', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { CheckPanel } = await import(moduleUrl('../web/src/lane/CheckPanel.tsx'));
  const { NextStep } = await import(moduleUrl('../web/src/lane/LaneParts.tsx'));
  const html = renderToStaticMarkup(
    createElement(CheckPanel, {
      run: {
        id: 'run',
        status: 'failed',
        check: 'verify',
        exitCode: 1,
        startedAt: '2026-10-15T10:00:00Z',
        endedAt: '2026-10-15T10:00:00Z',
      },
      now: Date.parse('2026-10-15T10:00:00Z'),
      overlapCount: 0,
    }),
  );
  assert.match(html, /verify/);
  assert.match(html, /exit 1/);
  assert.match(html, /0 s/);
  assert.doesNotMatch(html, /No overlapping open Lanes|Check failed<\/b>/);
  assert.equal(
    renderToStaticMarkup(
      createElement(NextStep, {
        step: { tone: 'failed', glyph: 'failed', title: 'Not ready to accept', body: 'failure' },
      }),
    ),
    '',
  );
});

test('paged log line numbers count retained newlines from a known start, including deep links and partial lines', async () => {
  const { numberedLogRead } = await import(moduleUrl('../web/src/lane/run-model.ts'));
  const bytes = Buffer.from('one\ncafé\n✖ failed\n');
  const read = numberedLogRead(async (_stream, offset) => {
    const { checkLogPage } = await import('../dist/check-log-page.js');
    return checkLogPage(bytes.subarray(offset, offset + 7), offset, bytes.length);
  });
  const second = await read('stdout', 7);
  assert.equal(second.firstLine, 2);
  assert.equal(logLines(second)[0].number, 2);
  const failure = await read('stderr', 10);
  assert.equal(failure.firstLine, 3);
  assert.equal(logLines(failure)[0].number, 3);
});
test('relative time handles just now centrally with or without an ago suffix', async () => {
  const { age } = await import(moduleUrl('../web/src/ui/status.ts'));
  assert.equal(age(1000, 1000), 'just now');
  assert.equal(age(1000, 1000, true), 'just now');
  assert.equal(age(1000, 41000, true), '40 s ago');
  assert.equal(age(undefined, 41000, true), '');
});
