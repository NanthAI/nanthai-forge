// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConvexError } from 'convex/values';
import { retryExchange, retryableExchangeError } from '../dist/exchange-retry.js';
import { hostedActionError } from '../dist/hosted-action-error.js';
import { landingRedriver } from '../dist/hosted-landing-redrive.js';
import { ForgeError } from '../dist/errors.js';

/** Issue 72d50375: a refused write during a maintenance pause is retryable,
 * says when, and changes nothing. */
const paused = retryAt =>
  new ConvexError({
    code: 'LEGACY_STORAGE_WRITES_PAUSED',
    message: 'Dev writes are paused for approved storage maintenance.',
    retryAt,
  });

test('a write pause keeps its retry time through the client error mapping', () => {
  const at = Date.now() + 120_000;
  const error = hostedActionError(paused(at), 'save');
  assert.equal(error.code, 'LEGACY_STORAGE_WRITES_PAUSED');
  assert.equal(error.retryAt, at);
  assert.equal(
    hostedActionError(new ConvexError({ code: 'X', message: 'm', retryAt: 'soon' }), 'p').retryAt,
    undefined,
  );
});

test('a write pause is retryable with a clear message and recovery', () => {
  const at = Date.now() + 120_000;
  const operationId = randomUUID();
  const error = retryableExchangeError(hostedActionError(paused(at), 'save'), operationId);
  assert.equal(error.code, 'LEGACY_STORAGE_WRITES_PAUSED');
  assert.match(error.message, /not accepting writes during approved maintenance; nothing was changed/);
  assert.match(
    error.message,
    new RegExp(`after ${new Date(at).toISOString()} \\(operation ${operationId}\\)`),
  );
  assert.deepEqual(error.recovery, { retryable: true, retryAt: new Date(at).toISOString() });
  assert.equal(retryableExchangeError(new ForgeError('AUTH_REQUIRED', 'no')), null);
  const conflict = retryableExchangeError(new ForgeError('HOSTED_CONFLICT', 'busy'));
  assert.match(conflict.message, /Retry the same command in a moment/);
});

test('retryExchange waits out a short pause with the same request and stops early on a long one', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let calls = 0;
  const short = retryExchange('save', randomUUID(), async () => {
    if (calls++ === 0) throw paused(Date.now() + 30_000);
    return 'ok';
  });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(30_000);
  assert.equal(await short, 'ok');
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    retryExchange('save', randomUUID(), async () => {
      calls++;
      throw paused(Date.now() + 20 * 60_000);
    }),
    error => error.code === 'LEGACY_STORAGE_WRITES_PAUSED' && error.recovery?.retryable === true,
  );
  assert.equal(calls, 1, 'a 20-minute pause is reported at once, not slept through');
});

const ready = (id, version) => ({ id, version, phase: 'ready', observation: { state: 'pending' } });
const tick = async (t, ms) => {
  t.mock.timers.tick(ms);
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

test('a healthy wait asks nothing: only an entry quiet in Ready for 2 minutes is re-driven', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const sent = [];
  const redrive = landingRedriver(
    { mutation: async (name, args) => (sent.push({ at: Date.now(), name, args }), '{"redriven":[]}') },
    () => false,
  );
  redrive({ ...ready('s1', 1), phase: 'checking' });
  redrive(ready('s1', 2));
  await tick(t, 90_000);
  redrive({ ...ready('s1', 3), phase: 'landed', observation: { state: 'landed' } });
  await tick(t, 60 * 60_000);
  assert.equal(sent.length, 0, 'settled within the quiet period: no call');

  const armed = Date.now();
  redrive(ready('s2', 4));
  redrive(ready('s2', 4));
  await tick(t, 120_000);
  assert.deepEqual(sent, [
    { at: armed + 120_000, name: 'projectHostedLandingRedrive:redrive', args: { submissionId: 's2' } },
  ]);
  // Still quiet: asks back off to 4, 8, then every 15 minutes.
  await tick(t, 4 * 60_000);
  await tick(t, 8 * 60_000);
  await tick(t, 15 * 60_000);
  assert.deepEqual(
    sent.slice(1).map((s, i) => s.at - sent[i].at),
    [4 * 60_000, 8 * 60_000, 15 * 60_000],
  );
  redrive({ ...ready('s2', 5), phase: 'landed', observation: { state: 'landed' } });
  await tick(t, 60 * 60_000);
  assert.equal(sent.length, 4, 'progress ends the asks');
});

test('a paused re-drive waits for the pause end (at most 5 minutes per ask) and a finished wait stops', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const sent = [];
  const pausedUntil = 12 * 60_000;
  const redrive = landingRedriver(
    {
      mutation: async () => {
        sent.push(Date.now());
        if (Date.now() < pausedUntil) throw paused(pausedUntil);
        return '{"redriven":["finish"]}';
      },
    },
    () => false,
  );
  redrive(ready('s1', 1));
  for (let i = 0; i < 12; i++) await tick(t, 60_000);
  assert.deepEqual(sent, [2 * 60_000, 7 * 60_000, pausedUntil]);

  let stopped = false;
  const later = [];
  const quiet = landingRedriver({ mutation: async () => later.push(1) }, () => stopped);
  quiet(ready('s3', 1));
  stopped = true;
  await tick(t, 60 * 60_000);
  assert.equal(later.length, 0, 'a finished wait never asks');
});
