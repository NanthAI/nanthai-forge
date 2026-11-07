// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { networkBoundaryFindings } from '../scripts/check-network-boundaries.mjs';

const incident = readFileSync(
  new URL('./fixtures/network-boundary/oidc-token-bare.mjs', import.meta.url),
  'utf8',
);

// Issue 06cfc7b7: the guard covers scripts/ as well as src/.
test('guard rejects the replayed OIDC bare fetch under scripts/ and src/', () => {
  for (const path of ['scripts/oidc-token.mjs', 'scripts/lib/oidc-token.mjs', 'src/oidc-token.ts']) {
    const findings = networkBoundaryFindings(path, incident);
    assert(
      findings.some(line => /Use networkFetch/.test(line)),
      `${path}: bare fetch passes: ${findings}`,
    );
    assert(
      findings.some(line => /Use networkTimeout/.test(line)),
      `${path}: AbortSignal.timeout passes: ${findings}`,
    );
  }
  // Fixtures and tests are not runtime network callers.
  assert.deepEqual(
    networkBoundaryFindings('tests/fixtures/network-boundary/oidc-token-bare.mjs', incident),
    [],
  );
});

test('guard accepts the shared helper and Convex deadline client in scripts/', () => {
  const safe = [
    "import { networkFetch, networkTimeout } from '../dist/network-fetch.js';",
    "import { deadlineConvexClient } from '../dist/network-convex-client.js';",
    'await networkFetch(url, { signal: networkTimeout(20_000) });',
    'export function read(fetcher = networkFetch) { return fetcher(url); }',
    'const client = deadlineConvexClient(url, { logger: false });',
  ].join('\n');
  assert.deepEqual(networkBoundaryFindings('scripts/oidc-token.mjs', safe), []);
});

test('scripts reject unwrapped Convex clients, default fetch parameters and primitives', () => {
  for (const source of [
    "import { ConvexHttpClient } from 'convex/browser'; new ConvexHttpClient(url, { logger: false });",
    'export function read(fetcher = fetch) { return fetcher(url); }',
    'const request = options.request ?? fetch;',
    "import { request } from 'node:https'; request(url);",
  ])
    assert(networkBoundaryFindings('scripts/unsafe.mjs', source).length, source);
});

test('exemptions stay narrow: interceptors may replace the global but not call fetch bare', () => {
  const intercept = 'const original = globalThis.fetch; globalThis.fetch = async () => new Response("");';
  assert.deepEqual(networkBoundaryFindings('scripts/measure-host.mjs', intercept), []);
  assert(networkBoundaryFindings('scripts/measure-host.mjs', 'await fetch(url);').length);
  assert(networkBoundaryFindings('scripts/measure-host.mjs', 'AbortSignal.timeout(1000);').length);
  assert(networkBoundaryFindings('scripts/other.mjs', intercept).length, 'only listed files intercept');
  assert(
    networkBoundaryFindings('scripts/bench-t3code/relay-client.mjs', 'await fetch(url);').length,
    'the primitive exemption covers node:http only',
  );
});

// Issue aabe52a7: the guard covers convex/ and netlify/; web/ is decided out.
const fixture = name => readFileSync(new URL(`./fixtures/network-boundary/${name}`, import.meta.url), 'utf8');
test('guard rejects the replayed bare fetches under convex/ and netlify/', () => {
  for (const [path, name] of [
    ['convex/r2Operations.ts', 'convex-r2-list-bare.mjs'],
    ['netlify/functions/analyze-background.mts', 'netlify-callback-bare.mjs'],
  ]) {
    const findings = networkBoundaryFindings(path, fixture(name));
    assert(
      findings.some(line => /Use networkFetch/.test(line)),
      `${path}: bare fetch passes: ${findings}`,
    );
    assert(
      findings.some(line => /Use networkTimeout/.test(line)),
      `${path}: AbortSignal.timeout passes`,
    );
  }
  const convex = networkBoundaryFindings('convex/r2Operations.ts', fixture('convex-r2-list-bare.mjs'));
  assert(
    convex.some(line => /:10: /.test(line)),
    `default request = fetch passes: ${convex}`,
  );
});

test('guard accepts convexFetch in convex/ and skips generated code and web/', () => {
  const safe = [
    "import { convexFetch, networkTimeout } from './networkFetch';",
    'await convexFetch(url, { signal: networkTimeout(20_000) });',
    'export function request(send: typeof fetch = convexFetch) { return send(url); }',
  ].join('\n');
  assert.deepEqual(networkBoundaryFindings('convex/projectPeople.ts', safe), []);
  assert.deepEqual(networkBoundaryFindings('convex/_generated/api.js', 'await fetch(url);'), []);
  // web/ is out by decision: browser requests are user-cancellable, strand no server
  // work, and archive transfers are sized by the user's file (see the guard header).
  assert.deepEqual(networkBoundaryFindings('web/src/snapshot.ts', 'await fetch(url);'), []);
});

test('every convex/ and netlify/ module passes the guard', async () => {
  const { readdirSync } = await import('node:fs');
  const root = new URL('../', import.meta.url);
  const walk = dir =>
    readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap(entry =>
      entry.name === '_generated' || entry.name === 'node_modules'
        ? []
        : entry.isDirectory()
          ? walk(`${dir}${entry.name}/`)
          : [`${dir}${entry.name}`],
    );
  const files = [...walk('convex/'), ...walk('netlify/')];
  assert(files.length > 100);
  assert.deepEqual(
    files.flatMap(path => networkBoundaryFindings(path, readFileSync(new URL(path, root), 'utf8'))),
    [],
  );
});
