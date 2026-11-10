// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { ConvexError } from 'convex/values';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import { exchangeConvexFetch } from '../dist/exchange-convex-fetch.js';
import { refusedWait, retryExchange, retryableExchangeError } from '../dist/exchange-retry.js';
import { hostedActionError, mainDiscoveryError } from '../dist/hosted-action-error.js';
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

/** A Convex outage or rate limit reaches the CLI as plain HTTP: the SDK drops
 * its status and Retry-After. Keep both, wait them out with the same request,
 * and never tell a user that an unknown outcome changed nothing. */
async function convexServer(t, statuses) {
  const seen = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(Date.now());
      const [status, headers = {}] = statuses[seen.length - 1] ?? [200];
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(status === 200 ? JSON.stringify({ status: 'success', value: 'ok', logLines: [] }) : 'busy');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = new ConvexHttpClient(`http://127.0.0.1:${server.address().port}`, {
    skipConvexDeploymentUrlCheck: true,
    logger: false,
    fetch: exchangeConvexFetch({ retries: 0 }),
  });
  const save = () => client.mutation(makeFunctionReference('projectHostedAgent:save'), { request: '{}' });
  return { seen, save };
}

test('a rate-limited Forge keeps its Retry-After and the same request waits it out', async t => {
  const { seen, save } = await convexServer(t, [[429, { 'retry-after': '1' }], [200]]);
  assert.equal(await retryExchange('save', randomUUID(), save), 'ok');
  assert.equal(seen.length, 2);
  assert(seen[1] - seen[0] >= 900, `waited ${seen[1] - seen[0]} ms, not the 100 ms backoff`);
});

test('an unavailable Forge is retryable; only a refusal says nothing changed', async t => {
  const operationId = randomUUID();
  for (const [status, outcome] of [
    [503, /could not accept this write right now; nothing was changed/],
    [504, /could not be reached or did not answer; the outcome is not known yet/],
  ]) {
    const { save } = await convexServer(t, [[status, { 'retry-after': '120' }]]);
    const raw = await save().catch(error => error);
    assert.equal(raw.code, 'EXCHANGE_REQUEST_FAILED');
    assert(raw.retryAt > Date.now() + 100_000, 'Retry-After becomes retryAt');
    const error = retryableExchangeError(hostedActionError(raw, 'save'), operationId);
    assert.match(error.message, outcome);
    assert.match(error.message, new RegExp(`Retry the same command after .* \\(operation ${operationId}\\)`));
    assert.equal(error.recovery.retryable, true);
    if (status === 504) assert.doesNotMatch(error.message, /nothing was changed/);
  }
  const timeout = retryableExchangeError(new ForgeError('EXCHANGE_REQUEST_TIMEOUT', 'deadline'));
  assert.match(timeout.message, /outcome is not known yet/);
});

test('the write transport resends only a refusal, and only for a short Retry-After', () => {
  const refused = (retryAt, outcome = 'refused') =>
    new ForgeError('EXCHANGE_REQUEST_FAILED', 'HTTP 429', retryAt, { httpStatus: 429, outcome });
  assert.equal(refusedWait(refused(undefined), 0), 500);
  assert.equal(refusedWait(refused(undefined), 2), 2000);
  const soon = refusedWait(refused(Date.now() + 30_000), 0);
  assert(soon > 29_000 && soon <= 30_000, String(soon));
  assert.equal(refusedWait(refused(Date.now() + 20 * 60_000), 0), null, 'a long one is reported, not slept');
  assert.equal(refusedWait(refused(undefined, 'unknown'), 0), null, 'a 504 may have run: no blind resend');
  assert.equal(refusedWait(new ForgeError('EXCHANGE_REQUEST_TIMEOUT', 'deadline'), 0), null);
});

test('cloning a new empty project says it has no source yet, not INTERNAL_ERROR (friction from Issue 7ac4e32f)', () => {
  const missing = new ConvexError({
    code: 'PROJECT_WORK_MISSING',
    message: 'Hosted source index is not ready.',
  });
  const error = mainDiscoveryError(missing);
  assert(error instanceof ForgeError);
  assert.equal(error.code, 'PROJECT_WORK_MISSING');
  assert.match(error.message, /no source yet/);
  assert.match(error.message, /nforge import/);
  // Other structured refusals keep their own code and message.
  const other = mainDiscoveryError(new ConvexError({ code: 'PROJECT_UNAVAILABLE', message: 'Sign in.' }));
  assert.deepEqual([other.code, other.message], ['PROJECT_UNAVAILABLE', 'Sign in.']);
});
