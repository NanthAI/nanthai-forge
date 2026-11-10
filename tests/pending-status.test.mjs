// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

import { pendingStatus } from '../dist/pending-status.js';

const now = '2026-01-01T12:10:00.000Z',
  at = '2026-01-01T12:00:00.000Z';
const head = 'a'.repeat(64),
  old = 'b'.repeat(64);
const main = { id: 'accept', channel: 'main', head, viewId: 'view', status: 'accepted', at };
const capture = {
  captureId: 'capture',
  capturedAt: at,
  publishedAt: '2026-01-01T12:02:00.000Z',
  mainHead: head,
  workRevision: 4,
  completeHistory: true,
  unavailable: [],
  evidenceComplete: true,
};
function data(extra = {}) {
  return { revision: 4, lanes: [], views: [], runs: [], channelMoves: [main], ...extra };
}

test('newer metadata cannot establish hosted source or recovery freshness', () => {
  const status = pendingStatus(data({ revision: 9 }), { metadataPending: 0 }, now);
  assert.equal(status.hosted.source, 'unknown');
  assert.equal(status.hosted.work, 'unknown');
  assert.equal(status.hosted.recovery, null);
  assert.equal(status.hosted.evidence, 'unknown');
  assert.equal(status.ownerHeartbeat, null);
});
test('equal source with newer Work remains pending; capture age uses capture, not publication', () => {
  const status = pendingStatus(data({ revision: 5 }), { recovery: capture }, now);
  assert.equal(status.hosted.source, 'matching');
  assert.equal(status.hosted.work, 'pending');
  assert.equal(status.hosted.captureAgeMs, 600_000);
  assert.equal(status.hosted.pendingAgeMs, null);
});
test('clock-free Work projections retain event times without inventing observation times or ages', () => {
  const worker = { status: 'idle', workers: 1, observedAt: at, code: null };
  const records = data({
    githubSync: { commits: [{ state: head, commit: 'commit' }], pushed: 1, pushedAt: at },
  });
  const observations = {
    recovery: capture,
    landingWorker: worker,
    deployment: { head, observedAt: at, state: 'ready' },
  };
  const status = pendingStatus(records, observations, null);
  assert.equal(status.snapshot.observedAt, null);
  assert.equal(status.hosted.captureAgeMs, null);
  assert.equal(status.github.ageMs, null);
  assert.equal(status.deployment.ageMs, null);
  assert.equal(status.github.pushedAt, at);
  assert.equal(status.deployment.observedAt, at);
  assert.equal(status.landingWorker.observedAt, at);
  assert.deepEqual(pendingStatus(records, observations, null), status);
  const timed = pendingStatus(records, observations, now);
  assert.equal(timed.snapshot.observedAt, now);
  assert.equal(timed.hosted.captureAgeMs, 600_000);
  assert.equal(timed.github.ageMs, 600_000);
  assert.equal(timed.deployment.ageMs, 600_000);
});
test('new logs after capture and later run completion remain pending independently of source', () => {
  for (const observations of [{ evidenceChangedAt: '2026-01-01T12:05:00Z' }, {}]) {
    const status = pendingStatus(
      data({
        runs: observations.evidenceChangedAt
          ? []
          : [
              {
                id: 'run',
                viewId: 'view',
                head,
                status: 'failed',
                startedAt: at,
                endedAt: '2026-01-01T12:06:00Z',
              },
            ],
      }),
      { recovery: capture, ...observations },
      now,
    );
    assert.equal(status.hosted.source, 'matching');
    assert.equal(status.hosted.evidence, 'pending');
  }
});
test('pending local saves do not advance successful capture pins', () => {
  const status = pendingStatus(
    data(),
    {
      recovery: { ...capture, mainHead: old, workRevision: 3 },
    },
    now,
  );
  assert.equal(status.hosted.mainHead, old);
  assert.equal(status.hosted.source, 'different');
  assert.equal(status.hosted.work, 'pending');
});
test('GitHub success and stale deployment observations stay separate from hosted recovery', () => {
  const status = pendingStatus(
    data({
      githubSync: { commits: [{ state: old }, { state: head, commit: 'git' }], pushed: 2, pushedAt: at },
    }),
    { recovery: { ...capture, mainHead: old }, deployment: { head: old, observedAt: at, state: 'ready' } },
    now,
  );
  assert.equal(status.github.source, 'matching');
  assert.equal(status.hosted.source, 'different');
  assert.equal(status.deployment.source, 'different');
  assert.equal(status.deployment.ageMs, 600_000);
  assert.equal(status.deployment.scope, 'last-recorded-observation');
  assert.equal(status.installedSource, null);
});
test('prepared but unpushed Git commits are never shown as synced', () => {
  const status = pendingStatus(data({ githubSync: { commits: [{ state: head }], pushed: 0 } }), {}, now);
  assert.equal(status.github.mainHead, null);
  assert.equal(status.github.source, 'unknown');
});

test('an unresolved provider outcome stays pending-infra in the local submission projection', () => {
  const lane = { id: randomUUID(), intentId: randomUUID(), head, state: 'active', name: 'Synthetic' };
  const view = { id: randomUUID(), inputs: [{ laneId: lane.id, head }] };
  const run = {
    id: randomUUID(),
    viewId: view.id,
    status: 'interrupted',
    error: { code: 'GITHUB_ACTIONS_PENDING_INFRA' },
  };
  const observation = pendingStatus(
    data({
      lanes: [lane],
      views: [view],
      runs: [run],
      channelMoves: [],
      landingEntries: [{ id: randomUUID(), viewId: view.id, runId: run.id, status: 'checking' }],
    }),
  ).lanes[0].submission;
  assert.equal(observation.pendingReason, 'pending-infra');
  assert.equal(observation.terminal, false);
});
