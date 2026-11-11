// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { landingTransition, readLandingTransition } from '../dist/hosted-landing.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { landingFixture } from './hosted-landing-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));

test('compact landing transitions replay every version identically to full observations with bounded selected reads', async () => {
  const f = await landingFixture();
  const state = await f.enqueue();
  const observed = () =>
    f
      .call('transitionObserve', observe.page, {
        projectId: f.projectId,
        operationId: state.operationId,
        nextVersion: 0,
      })
      .then(JSON.parse);
  await f.claim();
  const before = await observed();
  const compactReads = f.counts.at(-1).documents;
  const current = before.submission;
  const rows = [...f.tables.projectHostedLandingObservations.values()];
  let compactBytes = 0,
    fullBytes = 0;
  for (const row of rows) {
    const stored = JSON.parse(row.value);
    assert.equal(stored.encoding, 'landing-transition-v1');
    assert.equal(stored.submission, undefined);
    assert.equal(stored.transition.request, undefined);
    const event = readLandingTransition(row.value, current);
    const full = canonicalPayload(event);
    compactBytes += Buffer.byteLength(row.value);
    fullBytes += Buffer.byteLength(full);
    f.tables.projectHostedLandingObservations.set(row._id, { ...row, value: full });
  }
  const legacy = await observed();
  assert.deepEqual(legacy, before);
  assert.equal(f.counts.at(-1).documents, compactReads);
  assert(compactBytes < fullBytes, 'entries share the immutable request instead of storing full versions');
});

test('landing transition retains absent fields, pending IO and oversized valid error bytes exactly', async () => {
  const f = await landingFixture();
  const state = await f.enqueue();
  const message = 'synthetic history '.repeat(24000);
  const original = {
    submission: { ...state, error: { code: 'SOURCE_UNAVAILABLE', message } },
    pendingAttempt: { id: 'synthetic' },
    wouldConflict: { predecessor: 'synthetic' },
  };
  const encoded = landingTransition(original);
  const current = { ...state, error: null, batchId: 'later-only', timing: { submittedAt: state.at } };
  assert.deepEqual(readLandingTransition(encoded, current), original);
  assert.deepEqual(readLandingTransition(canonicalPayload(original), current), original);
  const invalid = JSON.parse(encoded);
  invalid.transition.request = {};
  assert.throws(() => readLandingTransition(JSON.stringify(invalid), current), { code: 'EVIDENCE_CHANGED' });
});
