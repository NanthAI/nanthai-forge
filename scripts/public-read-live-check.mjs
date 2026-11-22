// SPDX-License-Identifier: Apache-2.0
// Explicit dev probe, never an app timer: native limiting propagates asynchronously.
import { setTimeout as pause } from 'node:timers/promises';
import { networkFetch, networkTimeout } from '../dist/network-fetch.js';
import { isMainModule } from './main-module.mjs';

/** Redirects stay visible, with bounded requests and no retries. Raw dot paths need curl --path-as-is. */
export async function requestPublicPath(base, path, timeoutMs = 10_000) {
  const response = await networkFetch(
    new URL(path, base),
    {
      redirect: 'manual',
      signal: networkTimeout(timeoutMs),
      headers: { 'user-agent': 'Forge-public-verification/1', accept: 'text/html, application/json' },
    },
    { retries: 0 },
  );
  let bodyBytes = 0;
  for await (const chunk of response.body ?? []) bodyBytes += chunk.length;
  return {
    status: response.status,
    location: response.headers.get('location'),
    retryAfter: response.headers.get('retry-after'),
    cacheStatus: response.headers.get('cache-status'),
    requestId: response.headers.get('x-nf-request-id'),
    bodyBytes,
  };
}

/** The reserved selector must be removed without restoring it at the edge. */
export async function probeSelfRedirects({ base, request = path => requestPublicPath(base, path) }) {
  const path = '/explore?__forge_page=x';
  const canonical = '/explore?=';
  const first = await request(path);
  if (first.status !== 308 || !first.location?.endsWith('?='))
    throw Error(`Self-redirect probe ${path}: expected 308 with Location ending exactly in ?=`);
  const target = new URL(first.location, new URL(path, base));
  if (target.href !== new URL(canonical, base).href)
    throw Error(`Self-redirect probe ${path}: unsafe or self-referencing target`);
  const followed = await request(canonical);
  if (followed.status !== 200 || followed.location)
    throw Error(`Self-redirect probe ${path}: following once must return 200 with no Location`);
  return { cases: [{ path, first, followed }] };
}

/** A fresh window starts with the expected answer, then sustained traffic must reach 429.
 * At most 86 requests: a 61-request burst plus one per second for 25 seconds. */
export async function probeNativeLimit({ request, expectedStatus, now = Date.now, wait = pause }) {
  const started = now();
  const burstDeadline = started + 45_000;
  const observations = [];
  let propagationStarted;
  async function next(deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) throw Error('Native rate limit did not return 429 within the bounded probe');
    const response = await request(Math.min(10_000, remaining));
    if (now() > deadline) throw Error('Native rate limit did not return 429 within the bounded probe');
    observations.push({ ...response, elapsedMs: now() - started });
    if (observations.length === 1 && response.status !== expectedStatus)
      throw Error(`Start in a fresh rate window: expected ${expectedStatus}, got ${response.status}`);
    if (response.status !== expectedStatus && response.status !== 429)
      throw Error(`Unexpected public response ${response.status}`);
    return response;
  }
  for (let index = 0; index < 61; index++) {
    const response = await next(burstDeadline);
    if (response.status === 429) return result(response);
  }
  propagationStarted = now();
  const deadline = propagationStarted + 25_000;
  for (let index = 0; index < 25 && now() < deadline; index++) {
    await wait(Math.min(1_000, deadline - now()));
    if (now() >= deadline) break;
    const response = await next(deadline);
    if (response.status === 429) return result(response);
  }
  throw Error('Native rate limit did not return 429 within 25 seconds after the burst');

  function result(response) {
    const retry = response.retryAfter;
    if (
      retry !== null &&
      retry !== undefined &&
      !(/^\d+$/.test(retry) || (/ GMT$/.test(retry) && Number.isFinite(Date.parse(retry))))
    )
      throw Error('Invalid Retry-After on the rate-limit response');
    return {
      requests: observations.length,
      firstStatus: observations[0].status,
      status: response.status,
      elapsedMs: now() - started,
      afterBurstMs: propagationStarted === undefined ? 0 : now() - propagationStarted,
      retryAfter: retry ?? null,
      observations,
    };
  }
}

if (isMainModule(import.meta.url)) {
  const [base, shape] = process.argv.slice(2);
  if (!base || !['canonical', 'redirect', 'self-redirect'].includes(shape)) {
    console.error(
      'Usage: node scripts/public-read-live-check.mjs HTTPS_ORIGIN canonical|redirect|self-redirect',
    );
    process.exitCode = 1;
  } else {
    const path = shape === 'canonical' ? '/explore' : '/EXPLORE';
    try {
      if (shape === 'self-redirect') console.log(JSON.stringify(await probeSelfRedirects({ base })));
      else {
        const result = await probeNativeLimit({
          request: timeout => requestPublicPath(base, path, timeout),
          expectedStatus: shape === 'canonical' ? 200 : 308,
        });
        const { observations, ...summary } = result;
        console.log(JSON.stringify({ path, ...summary, first: observations[0], last: observations.at(-1) }));
      }
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
