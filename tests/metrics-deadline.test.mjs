// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { getFunctionName } from 'convex/server';
import { networkFetch } from '../dist/network-fetch.js';
import { agentFixture } from './hosted-agent-fixture.mjs';

/** A slow hosted API: every call is one real HTTP round trip that answers late. */
async function slowServer(t, delays) {
  const seen = [];
  const server = createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1));
    const call = { name, closed: false, answered: false };
    seen.push(call);
    req.resume();
    res.on('close', () => {
      call.closed = !call.answered;
    });
    setTimeout(() => {
      call.answered = true;
      res.end('{}');
    }, delays[name] ?? delays.default).unref();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  return {
    seen,
    hop: name => networkFetch(url + encodeURIComponent(name), { method: 'POST' }).then(r => r.text()),
  };
}

// Issue e32cb0e7: the whole metrics action, capability discovery included, ends within its budget.
test('metrics returns within its deadline against a slow server, discovery included', async t => {
  const s = agentFixture(t);
  const deadlineMs = 1_500;
  // Discovery alone takes most of the budget; every page answers slowly and never finishes.
  const api = await slowServer(t, { 'projectHostedAgent:capabilities': 800, default: 40 });
  const original = s.exchange.client.query;
  let cursor = 0;
  s.exchange.client.query = async (ref, args) => {
    const name = getFunctionName(ref);
    await api.hop(name);
    if (name !== 'projectSelfMetrics:page') return original(ref, args);
    return {
      page: [],
      isDone: false,
      continueCursor: String(++cursor),
      cutover: null,
      authority: { mode: 'server', epoch: 1 },
    };
  };
  const transport = Object.assign(s.transport(), { metricsDeadlineMs: deadlineMs });
  const started = performance.now();
  await assert.rejects(
    transport.dispatch('metrics', {}),
    error =>
      error.code === 'METRICS_TIMEOUT' &&
      /did not finish within 2 s/.test(error.message) &&
      /Next: nforge agent ROOT metrics '\{"from":/.test(error.message),
  );
  const elapsed = performance.now() - started;
  // Before the fix discovery (800 ms) ran outside the budget, then the read got a fresh 1.5 s.
  assert(elapsed < deadlineMs + 500, `metrics took ${Math.round(elapsed)} ms for a ${deadlineMs} ms budget`);
  assert(
    api.seen.some(call => call.name === 'projectSelfMetrics:page'),
    'the read started',
  );
  await new Promise(resolve => setTimeout(resolve, 100));
  const pages = api.seen.filter(call => call.name === 'projectSelfMetrics:page');
  assert.equal(pages.filter(call => !call.answered && !call.closed).length, 0, 'no request left hanging');
  const count = api.seen.length;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(api.seen.length, count, 'no calls after the deadline');
});

test('a slow discovery that alone exceeds the budget still ends at the deadline', async t => {
  const s = agentFixture(t);
  const api = await slowServer(t, { 'projectHostedAgent:capabilities': 5_000, default: 1 });
  const original = s.exchange.client.query;
  s.exchange.client.query = async (ref, args) => {
    await api.hop(getFunctionName(ref));
    return original(ref, args);
  };
  const transport = Object.assign(s.transport(), { metricsDeadlineMs: 200 });
  const started = performance.now();
  await assert.rejects(transport.dispatch('metrics', {}), error => error.code === 'METRICS_TIMEOUT');
  assert(performance.now() - started < 1_000);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(api.seen[0].closed, true, 'the in-flight discovery request was cancelled');
  assert.equal(
    api.seen.filter(call => call.name === 'projectSelfMetrics:page').length,
    0,
    'no page read after the budget ran out',
  );
});
