// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { captureCliAnalytics } from '../dist/cli-product-analytics.js';
import { agentDeadEnd } from '../dist/error-teaching.js';
import { analyticsTarget, sendAnalytics } from '../dist/product-analytics.js';

const token = 'phc_syntheticCaptureToken';
const address = { url: 'https://dev.forge.invalid', projectId: 'fixture-project' };
const captureEnv = {
  FORGE_POSTHOG_PROJECT_TOKEN: token,
  FORGE_POSTHOG_DEV_DEPLOYMENT: address.url,
};
const terminalFailure = {
  result: {
    status: 'terminal',
    submission: {
      phase: 'terminal-failed',
      attemptId: 'initial',
      firstAttemptId: 'initial',
      error: { code: 'CHECK_FAILED', message: 'fixture-private@example.test in /private/fixture.ts' },
    },
    failureCause: { cause: 'change', next: 'Fix the failing test in this Lane.' },
  },
};
const observe = (t, config = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-analytics-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const batches = [];
  const send = async (url, request) => {
    batches.push({ url, request: new Request(url, request), body: JSON.parse(request.body) });
    return new Response(null, { status: 200 });
  };
  const capture = (verb, reply, selected = address, env = {}) =>
    captureCliAnalytics(
      selected,
      verb,
      { reply },
      { ...captureEnv, XDG_CONFIG_HOME: directory, ...config, ...env },
      send,
    );
  return { batches, capture };
};

test('agent replies expose missing recovery without treating successful reads or reported cause advice as a dead end', () => {
  assert.equal(agentDeadEnd({ result: { files: [] } }), undefined);
  assert.equal(agentDeadEnd({ error: { code: 'WORK_STALE', next: 'nforge agent . status' } }), undefined);
  assert.equal(agentDeadEnd(terminalFailure), undefined);
  assert.deepEqual(agentDeadEnd({ result: { status: 'IN_PROGRESS' } }), { code: null });
  assert.deepEqual(agentDeadEnd({ error: { code: 'WORK_STALE', learn: 'nforge docs retry' } }), {
    code: 'WORK_STALE',
  });
  assert.deepEqual(
    agentDeadEnd({
      result: { status: 'terminal', submissions: [{ submission: { phase: 'terminal-failed' } }] },
    }),
    { code: null },
  );
  assert.equal(
    agentDeadEnd({ result: { status: 'IN_PROGRESS', wake: { command: 'nforge wait fixture' } } }),
    undefined,
  );
  assert.equal(
    agentDeadEnd({
      action: 'save',
      result: {
        status: 'settling',
        note: 'Saved: the server is finishing this save now. Your next command here reports its outcome, including any failure.',
      },
    }),
    undefined,
  );
  assert.equal(
    agentDeadEnd({
      result: {
        status: 'terminal',
        successful: false,
        phase: 'save',
        reason: 'The server has no record of this save yet. Replay the original save with this operationId.',
      },
    }),
    undefined,
  );
  assert.equal(agentDeadEnd({ result: { status: 'retryable' }, next: { action: 'save' } }), undefined);
  assert.equal(
    agentDeadEnd({
      action: 'cancel',
      result: { phase: 'terminal-failed', error: { code: 'LANDING_CANCELLED' } },
    }),
    undefined,
  );
});

test('the configured dev CLI batches failure events with fixed labels and omits raw project data', async t => {
  const { capture, batches } = observe(t);
  await capture('wait', terminalFailure);
  const [{ request, url, body }] = batches;
  assert.equal(batches.length, 1);
  assert.equal(url, 'https://us.i.posthog.com/batch/');
  assert.equal(request.credentials, 'omit');
  assert.equal(request.referrerPolicy, 'no-referrer');
  assert.equal(request.redirect, 'error');
  assert.deepEqual(
    body.batch.map(event => event.event),
    ['operation_failed', 'landing_failed'],
  );
  assert.equal(body.batch[1].properties.code, 'CHECK_FAILED');
  assert.equal(body.batch[1].properties.cause, 'change');
  assert.equal(body.batch[1].properties.retry_count, 0);
  assert.equal(body.batch[1].properties.$process_person_profile, false);
  assert.equal(body.batch[1].properties.$geoip_disable, true);
  assert.equal(
    body.batch[1].properties.project,
    createHmac('sha256', token).update(`${address.url}\n${address.projectId}`).digest('hex'),
  );
  assert.doesNotMatch(
    JSON.stringify(body),
    /fixture-private|fixture-project|dev\.forge\.invalid|fixture\.ts/,
  );
  await capture('wait', { result: { error: { code: 'UNTRUSTED_CODE_LIKE_TEXT' } } });
  assert.deepEqual(
    batches[1].body.batch.map(({ event, properties }) => [event, properties.code]),
    [
      ['operation_failed', 'unclassified'],
      ['dead_end', 'unclassified'],
    ],
  );
});

test('disabled capture sends nothing on opt-out, a production target, or absent or invalid configuration', async t => {
  const { capture, batches } = observe(t);
  await capture('land', terminalFailure, address, { DO_NOT_TRACK: '1' });
  await capture('land', terminalFailure, { ...address, url: 'https://forge.invalid' });
  await capture('land', terminalFailure, address, { FORGE_POSTHOG_PROJECT_TOKEN: undefined });
  await capture('land', terminalFailure, address, {
    FORGE_POSTHOG_PROJECT_TOKEN: 'phx_personalKeyWouldLeak',
  });
  await capture('land', terminalFailure, address, { FORGE_POSTHOG_REGION: 'other.invalid' });
  await capture('status', { result: { files: [] } });
  assert.deepEqual(batches, []);
});

test('the first landing is counted once per project and uses the retained start and commit timestamps', async t => {
  const { capture, batches } = observe(t);
  await capture('start', { result: { lane: {}, at: '2026-11-21T00:00:00.000Z' } });
  const reply = {
    result: {
      submission: {
        phase: 'landed',
        timing: { committedAt: '2026-11-21T00:15:00.000Z' },
        acceptance: { receiptId: 'a1111111-2222-4333-8444-b55555555555' },
      },
    },
  };
  await Promise.all([capture('land', reply), capture('wait', reply)]);
  const first = batches.flatMap(batch => batch.body.batch).filter(event => event.event === 'first_landing');
  assert.equal(first.length, 1);
  assert.equal(first[0].properties.minutes_since_start, 15);
});

test('a sampled acceptance uses the same vendor event identity for a replay of the original receipt', async t => {
  const { capture, batches } = observe(t);
  await capture('wait', terminalFailure);
  const id = batches[0].body.batch[0].properties.distinct_id;
  const receipt = Array.from(
    { length: 256 },
    (_, number) => `a1111111-2222-4333-8444-${number.toString(16).padStart(12, '0')}`,
  ).find(value => createHmac('sha256', id).update(value).digest()[0] < 25);
  assert.ok(receipt);
  const reply = {
    result: {
      submission: {
        phase: 'landed',
        timing: { submittedAt: '2026-11-21T00:12:00.000Z', committedAt: '2026-11-21T00:15:00.000Z' },
        acceptance: { receiptId: receipt },
      },
    },
  };
  await capture('land', reply);
  await capture('wait', reply);
  const accepted = batches
    .flatMap(batch => batch.body.batch)
    .filter(event => event.event === 'landing_accepted');
  assert.equal(accepted.length, 2);
  assert.deepEqual(accepted[0], accepted[1]);
  assert.equal(accepted[0].properties.minutes_to_main, 3);
  assert.equal(accepted[0].timestamp, '2026-11-21T00:15:00.000Z');
  assert.notEqual(accepted[0].uuid, receipt);
});

test('vendor transport failures leave the observed outcome alone and trigger no retry', async () => {
  let sends = 0;
  await sendAnalytics(
    analyticsTarget(token, 'eu'),
    'fixture-install',
    [{ event: 'screen_opened', screen: 'code' }],
    undefined,
    undefined,
    async () => {
      sends++;
      throw Error('fixture vendor unavailable');
    },
  );
  assert.equal(sends, 1);
});
