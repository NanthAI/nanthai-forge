// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  probeNativeLimit,
  probeSelfRedirects,
  requestPublicPath,
} from '../scripts/public-read-live-check.mjs';

const native = JSON.parse(
  readFileSync(new URL('./fixtures/public-read-netlify.json', import.meta.url)),
).nativeRateLimit;

test('the post-deploy probe follows the reserved HTML redirect exactly once', async () => {
  const paths = [];
  const result = await probeSelfRedirects({
    base: 'https://site.example',
    request: async path => {
      paths.push(path);
      return path.endsWith('?=')
        ? { status: 200, location: null }
        : { status: 308, location: `https://site.example${path.split('?')[0]}?=` };
    },
  });
  assert.deepEqual(paths, ['/-/explore?__forge_page=x', '/-/explore?=']);
  const [{ first, followed }] = result.cases;
  assert.equal(first.status, 308);
  assert.equal(followed.status, 200);
});

test('a restored query, self target, warm cache or another redirect cannot pass the live one-hop check', async () => {
  for (const location of [
    'https://site.example/-/explore?__forge_page=x',
    'https://site.example/-/explore?=&__forge_page=x',
    'https://other.example/-/explore?=',
    'https://site.example/outside?=',
  ])
    await assert.rejects(
      probeSelfRedirects({
        base: 'https://site.example',
        request: async () => ({ status: 308, location }),
      }),
      /expected 308|unsafe or self-referencing/,
    );
  await assert.rejects(
    probeSelfRedirects({
      base: 'https://site.example',
      request: async () => ({ status: 200, location: null }),
    }),
    /expected 308/,
  );
  await assert.rejects(
    probeSelfRedirects({
      base: 'https://site.example',
      request: async path => ({
        status: 308,
        location: `https://site.example${path.split('?')[0]}?=`,
      }),
    }),
    /following once/,
  );
});

for (const firstStatus of [200, 308])
  test(`sustained ${firstStatus} traffic becomes 429 after native propagation, without an exact request-61 assertion`, async () => {
    let clock = 0;
    let count = 0;
    const result = await probeNativeLimit({
      now: () => clock,
      wait: async ms => {
        clock += ms;
      },
      expectedStatus: firstStatus,
      request: async () => {
        count++;
        return {
          status:
            count > native.rapidRequests && clock >= native.nextProbeDelayMs
              ? native.nextStatus
              : firstStatus,
          retryAfter: null,
        };
      },
    });
    assert.equal(result.firstStatus, firstStatus);
    assert.equal(result.status, 429);
    assert.equal(result.afterBurstMs, native.nextProbeDelayMs);
    assert.equal(result.retryAfter, null, 'native headers are outside the app handler');
    assert.equal(result.observations[native.rapidRequests - 1].status, firstStatus);
  });

test('a missing limiter fails after bounded sustained traffic instead of probing forever', async () => {
  let clock = 0;
  let count = 0;
  await assert.rejects(
    probeNativeLimit({
      now: () => clock,
      wait: async ms => {
        clock += ms;
      },
      expectedStatus: 308,
      request: async () => {
        count++;
        return { status: 308 };
      },
    }),
    /within 25 seconds/,
  );
  assert.equal(clock, 25_000);
  assert(count <= 86);
});

test('a late or unexpected response cannot pass the propagation deadline', async () => {
  let clock = 0;
  let count = 0;
  await assert.rejects(
    probeNativeLimit({
      now: () => clock,
      wait: async ms => {
        clock += ms;
      },
      expectedStatus: 200,
      request: async () => {
        count++;
        if (count > 61) clock += 25_000;
        return { status: count > 61 ? 429 : 200 };
      },
    }),
    /bounded probe/,
  );
  await assert.rejects(
    probeNativeLimit({ expectedStatus: 200, request: async () => ({ status: 502 }) }),
    /expected 200, got 502/,
  );
  await assert.rejects(
    probeNativeLimit({ expectedStatus: 308, request: async () => ({ status: 429 }) }),
    /fresh rate window/,
  );
});

test('Retry-After is validated when supplied and its absence is reported honestly', async () => {
  for (const retryAfter of [null, '0', '60', 'Wed, 21 Oct 2015 07:28:00 GMT', 'broken']) {
    let count = 0;
    const pending = probeNativeLimit({
      expectedStatus: 308,
      request: async () => ({ status: ++count === 1 ? 308 : 429, retryAfter }),
    });
    if (retryAfter === 'broken') await assert.rejects(pending, /Invalid Retry-After/);
    else assert.equal((await pending).retryAfter, retryAfter);
  }
});

test('the live transport observes redirects without following them or retrying a 429', async t => {
  for (const status of [308, 429]) {
    const asked = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
      asked.push({ url: String(url), redirect: init.redirect });
      return new Response(null, { status, headers: { location: 'https://site.example/-/explore' } });
    });
    const result = await requestPublicPath('https://site.example', '/-/EXPLORE');
    assert.equal(result.status, status);
    assert.equal(result.location, 'https://site.example/-/explore');
    assert.deepEqual(asked, [{ url: 'https://site.example/-/EXPLORE', redirect: 'manual' }]);
    t.mock.restoreAll();
  }
});
