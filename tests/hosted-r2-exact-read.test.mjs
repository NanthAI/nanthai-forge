// SPDX-License-Identifier: Apache-2.0
// eb0491bb / 4f60d57a: the result-download and finish-page actions have no
// scheduled same-execution repair, so one transient R2 answer used to leave the
// operation submitted until a watchdog or client replay. They now share one
// bounded retry; exact deterministic codes and the healthy single read stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
import { ForgeError } from '../dist/errors.js';
import { r2LagDelays, readR2Exact } from '../dist/hosted-r2-retry.js';

const code = value => error => (error.data?.code ?? error.code) === value;
const ok = body => new Response(body);
const status = n => new Response('private provider text', { status: n });

/** Answers one scripted fault per request, then `final` for the rest. */
function script(faults, final) {
  const seen = { requests: 0 };
  const request = async () => {
    const fault = faults[seen.requests++];
    if (fault === undefined) return final();
    if (typeof fault === 'number') return status(fault);
    if (fault === 'reset') throw new TypeError('fetch failed');
    if (fault === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
    if (fault === 'exchange') throw new ForgeError('EXCHANGE_REQUEST_TIMEOUT', 'timed out');
    if (fault === 'body')
      return new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
      );
    throw new Error(`unknown fault ${fault}`);
  };
  return { seen, request };
}
const consume = async response => {
  if (!response.ok) throw new ForgeError('SOURCE_UNAVAILABLE', 'download failed');
  return Buffer.from(await response.arrayBuffer()).toString();
};

test('policy: shares the two-extra-try budget; healthy read is one request and never waits', async () => {
  assert.deepEqual([...r2LagDelays], [400, 1600]);
  const waits = [];
  const { seen, request } = script([], () => ok('manifest'));
  assert.equal(await readR2Exact(request, consume, async ms => void waits.push(ms)), 'manifest');
  assert.equal(seen.requests, 1);
  assert.deepEqual(waits, []);
});

for (const fault of [404, 408, 425, 429, 500, 503, 'reset', 'timeout', 'exchange', 'body'])
  test(`policy: ${fault} then success retries once`, async () => {
    const waits = [];
    const { seen, request } = script([fault], () => ok('manifest'));
    assert.equal(await readR2Exact(request, consume, async ms => void waits.push(ms)), 'manifest');
    assert.equal(seen.requests, 2);
    assert.deepEqual(waits, [400]);
  });

for (const [fault, expected] of [
  [503, code('SOURCE_UNAVAILABLE')],
  [404, code('SOURCE_UNAVAILABLE')],
  ['reset', error => error instanceof TypeError],
  ['timeout', error => error.name === 'TimeoutError'],
])
  test(`policy: persistent ${fault} stops after three requests with its unchanged outcome`, async () => {
    const waits = [];
    const { seen, request } = script([fault, fault, fault, fault], () => ok('never'));
    await assert.rejects(
      readR2Exact(request, consume, async ms => void waits.push(ms)),
      expected,
    );
    assert.equal(seen.requests, 3);
    assert.deepEqual(waits, [400, 1600]);
  });

for (const fault of [403, 400, 412])
  test(`policy: permanent ${fault} fails at once`, async () => {
    const { seen, request } = script([fault], () => ok('never'));
    await assert.rejects(
      readR2Exact(request, consume, async () => assert.fail('no wait')),
      code('SOURCE_UNAVAILABLE'),
    );
    assert.equal(seen.requests, 1);
  });

test('policy: a deterministic ForgeError from consume (size, digest, interval) is never retried', async () => {
  const { seen, request } = script([], () => ok('manifest'));
  await assert.rejects(
    readR2Exact(
      request,
      async () => {
        throw new ForgeError('SOURCE_HASH_MISMATCH', 'changed');
      },
      async () => assert.fail('no wait'),
    ),
    code('SOURCE_HASH_MISMATCH'),
  );
  assert.equal(seen.requests, 1);
});

// Action level: every production site that reads an exact small object with no
// scheduled repair of its own. A new site must join this table (fix-the-class).
const manifest = JSON.stringify({ schema: 1, synthetic: true });
const bytes = Buffer.from(manifest),
  pin = { sha256: digest(bytes), size: bytes.length };
const grant = { url: 'https://r2.invalid/bucket/v1/p/x/o/' + pin.sha256, size: pin.size };
const resultSites = ['Compose', 'Save', 'Sync'].map(name => ({
  name: `${name.toLowerCase()} result download`,
  module: `../convex/projectHosted${name}Jobs.ts`,
  run: async (api, ctx) => api.complete._handler(ctx, { projectId: 'p', jobId: 'j' }),
  replies: [() => grant, ({ result }) => (assert.equal(result, manifest), 'published')],
  done: published => assert.equal(published, 'published'),
}));
const pageCommand = {
  kind: 'page',
  url: grant.url,
  pin,
  selection: { attemptId: 'a', kind: 'inputs', index: 0 },
};
const sites = [
  ...resultSites,
  {
    name: 'finish selection page',
    module: '../convex/projectHostedFinishDriver.ts',
    run: async (api, ctx) => api.drive._handler(ctx, { projectId: 'p', submissionId: 's', wakeId: 'w' }),
    replies: [() => JSON.stringify(pageCommand), ({ page }) => (assert.equal(page, manifest), null)],
    done: () => {},
  },
];
for (const site of sites) {
  const api = await import(moduleUrl(site.module));
  const harness = (t, faults, final = () => ok(bytes)) => {
    const mutations = [];
    const { seen, request } = script(faults, final);
    t.mock.method(globalThis, 'fetch', url => {
      assert.equal(String(url), grant.url);
      return request();
    });
    const ctx = {
      runMutation: async (_ref, args) => {
        const reply = site.replies[mutations.length];
        mutations.push(args);
        return reply(args);
      },
    };
    // Production waits are real setTimeout calls; advance them without sleeping.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const run = async () => {
      let settled = false;
      const result = site.run(api, ctx).finally(() => (settled = true));
      result.catch(() => {}); // observed below; not an unhandled rejection while ticking
      while (!settled) {
        await new Promise(resolve => setImmediate(resolve));
        t.mock.timers.tick(r2LagDelays.at(-1));
      }
      return result;
    };
    return { seen, mutations, run };
  };
  test(`${site.name}: healthy path is one GET and publishes`, async t => {
    const h = harness(t, []);
    site.done(await h.run());
    assert.equal(h.seen.requests, 1);
    assert.equal(h.mutations.length, 2);
  });
  for (const fault of [503, 'timeout', 404])
    test(`${site.name}: transient ${fault} then success publishes in the same action`, async t => {
      const h = harness(t, [fault]);
      site.done(await h.run());
      assert.equal(h.seen.requests, 2);
      assert.equal(h.mutations.length, 2, 'published without waiting for a watchdog');
    });
  test(`${site.name}: a persistent 503 keeps SOURCE_UNAVAILABLE after three GETs, no publish`, async t => {
    const h = harness(t, [503, 503, 503]);
    await assert.rejects(h.run(), code('SOURCE_UNAVAILABLE'));
    assert.equal(h.seen.requests, 3);
    assert.equal(h.mutations.length, 1);
  });
  test(`${site.name}: oversized body is SOURCE_HASH_MISMATCH at once`, async t => {
    const h = harness(t, [], () => ok(Buffer.concat([bytes, Buffer.from('x')])));
    await assert.rejects(h.run(), code('SOURCE_HASH_MISMATCH'));
    assert.equal(h.seen.requests, 1);
  });
  test(`${site.name}: 403 fails at once`, async t => {
    const h = harness(t, [403]);
    await assert.rejects(h.run(), code('SOURCE_UNAVAILABLE'));
    assert.equal(h.seen.requests, 1);
  });
}

test('guard: no convex action reads a presigned object grant without the shared exact read', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../convex/', import.meta.url);
  const offenders = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.ts') && f !== 'projectR2ExactRead.ts')) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    // The retired shape: a raw fetch of a grant/command URL followed by a
    // bare SOURCE_UNAVAILABLE invariant on the response.
    if (/fetch\((grant|command)\.url/.test(source)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
