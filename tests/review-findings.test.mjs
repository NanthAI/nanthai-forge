// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkService } from '../dist/work.js';
import { fixture, git } from './helpers.mjs';
import { moduleUrl } from './convex-module.mjs';
import { review } from './fixtures/review-findings.mjs';

const { readReview } = await import(moduleUrl('../web/src/app/discussion/ReviewFindings.tsx'));
const { Discussion } = await import(moduleUrl('../web/src/app/discussion/Discussion.tsx'));
const render = text =>
  renderToStaticMarkup(
    h(Discussion, {
      canWrite: false,
      comments: [{ id: randomUUID(), itemId: randomUUID(), at: '2026-11-17T09:00:00Z', text }],
    }),
  );

test('a reviewer batch and a reasoned reply retain exact source evidence through comment replay and export', async t => {
  const root = fixture(t, { 'a.ts': 'export const a = 1;\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Baseline']);
  const work = new WorkService(root);
  const run = async command => (await work.dispatch(command, work.status().revision)).result;
  const itemId = randomUUID();
  await run({
    action: 'put-planning-item',
    operationId: randomUUID(),
    itemId,
    kind: 'issue',
    title: 'Upgrade',
  });
  const command = {
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId,
    text: JSON.stringify(review),
  };
  const first = await run(command);
  assert.deepEqual(readReview(first.text), review);
  assert.deepEqual(await run(command), first, 'unknown-outcome retry adds no duplicate review');
  const resolved = structuredClone(review);
  resolved.head = 'e'.repeat(64);
  resolved.findings[0].outcome = 'fixed';
  resolved.findings[0].reason = 'The example now uses the current call; the upgrade replay passes.';
  await run({ ...command, operationId: randomUUID(), replyTo: first.id, text: JSON.stringify(resolved) });
  const exported = JSON.parse((await run({ action: 'export-planning' })).json);
  assert.equal(exported.comments.length, 2);
  assert.deepEqual(
    readReview(exported.comments[0].text),
    review,
    'a later head never rewrites the original finding',
  );
  assert.deepEqual(readReview(exported.comments[1].text), resolved);
  assert.equal(exported.comments[1].replyTo, first.id);
  await assert.rejects(
    run({ ...command, text: JSON.stringify(resolved) }),
    error => error.code === 'WORK_OPERATION_CHANGED',
  );
});

test('findings draw the complete count, evidence side and origin, outcome and reason as inert text', () => {
  const hostile = structuredClone(review);
  hostile.findings[0].claim = '<img src=x onerror=alert(1)> [run](javascript:alert(2))';
  hostile.findings[0].path = '<script>path</script>';
  const html = render(JSON.stringify(hostile));
  assert.match(html, /Review · 2 findings/);
  assert.match(html, /reported by reviewer/);
  assert.match(html, /R1 · should · open/);
  assert.match(html, /R2 · nit · declined/);
  assert.match(html, /base · pre-existing/);
  assert.match(html, /Outside this change/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|<script|href="javascript:/);
  assert.match(html, /Exact review record/);
  assert.match(html, new RegExp(review.head));
});

test('unknown versions, incomplete evidence and duplicate ids keep the original comment presentation', () => {
  for (const change of [
    value => {
      value.version = 2;
    },
    value => {
      value.head = 'latest';
    },
    value => {
      delete value.findings[0].blob;
    },
    value => {
      value.findings[0].line = 0;
    },
    value => {
      value.findings[1].id = 'R1';
    },
    value => {
      delete value.findings[1].reason;
    },
  ]) {
    const value = structuredClone(review);
    change(value);
    const text = JSON.stringify(value);
    assert.equal(readReview(text), null);
    assert.doesNotMatch(render(text), /Exact review record/);
    assert.match(render(text), /forge-review/);
  }
  assert.equal(readReview('{oops'), null);
  assert.equal(readReview('An ordinary comment.'), null);
  assert.match(render('An ordinary comment.'), /An ordinary comment\./);
  assert.match(render(JSON.stringify({ ...review, findings: [] })), /Review · 0 findings/);
});
