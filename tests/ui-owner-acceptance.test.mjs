// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { moduleUrl } from './convex-module.mjs';
import { variantProps, variants, landingRead } from './fixtures/landing-review.mjs';
const { LandingDecision } = await import(moduleUrl('../web/src/lane/LandingDecision.tsx'));
const { landingState } = await import(moduleUrl('../web/src/lane/landing-model.ts'));
for (const name of variants)
  test(`hosted decision renders ${name}`, () => {
    const html = render(h(LandingDecision, variantProps(name)));
    assert.match(html, /fx-decide/);
    assert.doesNotMatch(html, /Connect owner|Waiting for .*Mac|Requested|<dialog|role="dialog"|[a-f0-9]{64}/);
    const expected = {
      '01-ready': 'Accept into main',
      '01b-viewer': 'A project owner or maintainer accepts',
      '02-queued': 'Queued',
      '02-accepting': '3 of 8 shards',
      '02b-behind': 'waits for Candidate 3',
      '02c-landing': 'Land on main',
      '02d-runner': 'Waiting for a runner',
      '03-landed': 'Landed',
      '04-failed': 'verify failed · exit 1',
      '04b-conflict': 'Resolve in Lane',
      '04c-not-run': 'Try again',
      '04d-superseded': 'Superseded by Candidate 5',
      '05-request-changes': 'What should change?',
      '05b-sent': 'sent to Codex',
      '06-revert': 'Revert into main',
      '06b-reverting': 'Reverting',
      '06c-reverted': 'Reverted',
    }[name];
    assert.ok(html.includes(expected), expected);
    if (name === '01b-viewer') {
      assert.doesNotMatch(html, /Accept into main/);
      assert.match(html, /Ask for changes/);
    }
    if (name === '02d-runner') {
      assert.doesNotMatch(html, /fx-decide-failed/);
      assert.match(html, /Checks settings/);
      assert.match(html, /href="[^"]*\/settings\/checks"/);
    }
    if (name === '04-failed') {
      assert.match(html, /\+1/);
      assert.doesNotMatch(html, /fourth test/);
    }
    if (name === '04d-superseded') assert.doesNotMatch(html, /<button/);
    if (name === '06c-reverted') assert.doesNotMatch(html, /Revert…/);
  });
test('all pending observation reasons and terminal causes share the header model', () => {
  for (const reason of [
    'queued',
    'checking',
    'waiting-for-review',
    'waiting-for-dependency',
    'pending-infra',
  ]) {
    const state = landingState(landingRead(reason));
    assert.equal(state.title, 'Landing');
    assert.equal(state.pending, true);
    if (reason === 'pending-infra') assert.equal(state.state, 'waiting-for-runner');
  }
  assert.equal(landingState(landingRead('landing')).label, 'Landing');
  assert.equal(landingState(variantProps('04b-conflict').read).tone, 'conflict');
  assert.equal(landingState(variantProps('04c-not-run').read).kind, 'not-run');
  assert.equal(landingState(variantProps('03-landed').read).label, 'Landed');
});
// Landing machine 1 B2 (Issue 68361cd5): a ready entry parked by the main-red gate (observation
// queued + MAIN_RED) read "Landing" with a running tone while nothing moved.
test('landing B2: a main-red hold reads as held with its next step, not Landing', () => {
  const read = landingRead('landing');
  read.request.error = {
    code: 'MAIN_RED',
    message: 'Main audit is red; contract acceptance resumes when main is green.',
  };
  const state = landingState(read);
  assert.equal(state.state, 'held-main-red');
  assert.equal(state.label, 'Held: main is red');
  assert.notEqual(state.tone, 'running');
  assert.equal(state.pending, true);
  const html = render(h(LandingDecision, { ...variantProps('02c-landing'), read }));
  assert.match(html, /Held: main is red/);
});
// Landing machine 1 (W2): stale-head and policy rejection used different words in the cockpit
// ("Not run · recovery pending") and the review page ("Not landed"). Both now say "Not landed".
test('landing W2: stale-head and rejected endings read Not landed on the review page and the cockpit', async () => {
  const { landingStateOf } = await import('../dist/landing-state.js');
  for (const [cause, code, state] of [
    ['stale-head', 'LANDING_SUPERSEDED', 'stale-head'],
    ['rejected', 'REVIEW_DECLINED', 'rejected'],
  ]) {
    const read = landingRead('checking');
    read.request.phase = 'terminal-failed';
    read.request.observation = { state: 'terminal-failed', pendingReason: null, cause };
    read.request.error = { code, message: 'ended' };
    assert.equal(landingState(read).label, 'Not landed');
    assert.equal(landingStateOf(read.request).state, state);
    // The projection shape the cockpit reads gives the same word and state.
    const projected = landingStateOf({ state: 'terminal-failed', pendingReason: null, cause });
    assert.deepEqual([projected.state, projected.label], [state, 'Not landed']);
  }
});
// Web W5 (Issue 68361cd5): with no submission the review pill was a green "Ready" even when this
// Candidate's own check failed or was missing.
test('review pill W5: green Ready only with a passing check before any submission', () => {
  assert.deepEqual(
    ['passed', 'failed', null, 'running'].map(status => {
      const state = landingState(null, false, status);
      return [state.label, state.tone, state.kind];
    }),
    [
      ['Ready', 'passed', 'ready'],
      ['Check failed', 'failed', 'ready'],
      ['Needs a check', 'waiting', 'ready'],
      ['Needs a check', 'waiting', 'ready'],
    ],
  );
});
test('legacy review decision modules and their production callers are deleted', () => {
  for (const file of ['OwnerDecision.tsx', 'owner-decision-model.ts', 'RevertAcceptance.tsx'])
    assert.equal(existsSync(new URL(`../web/src/lane/${file}`, import.meta.url)), false);
  for (const file of ['../web/src/review/HostedReview.tsx', '../web/src/lane/LandingDecision.tsx']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /ownerAcceptance|acceptChannel|HostedRevertAcceptance|<OwnerDecision\b/);
  }
});

test('feedback resumes Working only on a new save, leaving the reviewed Candidate pinned', async () => {
  const { feedbackWorking } = await import(moduleUrl('../web/src/lane/landing-model.ts'));
  const inputs = [{ laneId: 'lane', head: 'reviewed' }];
  assert.equal(feedbackWorking(true, inputs, [{ id: 'lane', head: 'reviewed' }]), false);
  assert.equal(feedbackWorking(true, inputs, [{ id: 'lane', head: 'new-save' }]), true);
  assert.equal(feedbackWorking(false, inputs, [{ id: 'lane', head: 'new-save' }]), false);
  assert.equal(inputs[0].head, 'reviewed');
});

test('landed acceptance shows optional proof beside the receipt and hides absent evidence', () => {
  const props = variantProps('03-landed');
  const original = render(h(LandingDecision, props));
  assert.doesNotMatch(original, /tests fail on base/);
  const read = {
    ...props.read,
    request: {
      ...props.read.request,
      acceptance: {
        ...props.read.request.acceptance,
        proof: { proven: 3, passedOnBase: 1, inconclusive: 0 },
      },
    },
  };
  const html = render(h(LandingDecision, { ...props, read }));
  assert.match(html, /proof: 3 tests fail on base and pass on head; 1 pass on base too/);
});
