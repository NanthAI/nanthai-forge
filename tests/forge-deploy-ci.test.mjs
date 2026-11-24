// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 8b6efb50: plain-Node CI deploy runner (scripts/forge-deploy-ci.mjs): delta checkout from
// Forge R2 without waiting on GitHub mirror, and post-deploy smoke checks (build version,
// public-read JSON, sitemap, old /-/ 301 redirect). Uses synthetic fetch and temp dirs; zero sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../scripts/test-temp.mjs';
import {
  buildDeployReport,
  checkoutForgeState,
  planConvexWithBootstrap,
  planWebDeploy,
  readLocalBuiltRecord,
  runPostDeploySmoke,
} from '../scripts/forge-deploy-ci.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');

test('Item 8b6efb50: checkoutForgeState overlays only changed blobs from R2, removes deleted files and verifies hashes', async t => {
  const dir = temporaryDirectory(t, 'forge-deploy-checkout-');
  // Seed an older GitHub checkout on disk.
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/same.ts'), 'export const same = 1;\n');
  writeFileSync(join(dir, 'src/changed.ts'), 'export const v = "old";\n');
  writeFileSync(join(dir, 'src/deleted.ts'), 'export const gone = true;\n');

  const sameBytes = Buffer.from('export const same = 1;\n');
  const newBytes = Buffer.from('export const v = "new";\n');
  const addedBytes = Buffer.from('export const added = 2;\n');
  const blobs = new Map([
    [hash(sameBytes), sameBytes],
    [hash(newBytes), newBytes],
    [hash(addedBytes), addedBytes],
  ]);
  const manifestBytes = Buffer.from(
    JSON.stringify({
      files: [
        { path: 'src/same.ts', blob: hash(sameBytes), mode: 'file' },
        { path: 'src/changed.ts', blob: hash(newBytes), mode: 'file' },
        { path: 'src/added.ts', blob: hash(addedBytes), mode: 'file' },
      ],
    }),
  );
  const state = hash(manifestBytes);
  blobs.set(state, manifestBytes);

  const requestedDigests = [];
  const api = async cmd => {
    assert.equal(cmd.kind, 'source');
    requestedDigests.push(...cmd.digests);
    return {
      mode: 'catalog',
      rows: cmd.digests.map(d => ({ digest: d, size: blobs.get(d).length, url: `https://r2.invalid/${d}` })),
    };
  };
  const request = async url => {
    const digest = url.split('/').at(-1);
    return new Response(blobs.get(digest), { status: 200 });
  };

  const stats = await checkoutForgeState({
    dir,
    state,
    manifest: { size: manifestBytes.length, url: `https://r2.invalid/${state}` },
    api,
    request,
  });

  assert.equal(stats.totalFiles, 3);
  assert.equal(stats.updatedFiles, 2, 'only changed and added files written');
  assert.equal(stats.downloadedBlobs, 2, 'unchanged file was not re-downloaded');
  assert.equal(stats.removedFiles, 1, 'deleted file removed');
  assert.deepEqual(requestedDigests.sort(), [hash(newBytes), hash(addedBytes)].sort());
  assert.equal(readFileSync(join(dir, 'src/changed.ts'), 'utf8'), 'export const v = "new";\n');
  assert.equal(readFileSync(join(dir, 'src/added.ts'), 'utf8'), 'export const added = 2;\n');
  assert.equal(existsSync(join(dir, 'src/deleted.ts')), false);
});

test('Item 8b6efb50: runPostDeploySmoke checks build version, public-read JSON, sitemap and old 301 redirect', async () => {
  const state = 'a'.repeat(64);
  const origin = 'https://dev.forge.nanthai.tech';
  const okRoutes = new Map([
    [
      '/_forge/build.json',
      () =>
        new Response(JSON.stringify({ state, digest: 'd1', deployedAt: '2026-11-23T21:00:00Z' }), {
          status: 200,
        }),
    ],
    [
      '/-/public/v1/explore/active.json',
      () =>
        new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      '/sitemap.xml',
      () =>
        new Response(
          '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
          {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          },
        ),
    ],
    ['/-/explore', () => new Response(null, { status: 301, headers: { location: `${origin}/explore` } })],
  ]);
  const routeFor = url => okRoutes.get(new URL(url).pathname)();

  const pass = await runPostDeploySmoke({
    site: origin,
    expectedState: state,
    request: async url => routeFor(url),
    wait: async () => {},
  });
  assert.equal(pass.ok, true);
  assert.equal(pass.liveAfterSeconds, 0);
  assert.deepEqual(
    pass.checks.map(c => [c.name, c.ok]),
    [
      ['build-version', true],
      ['public-read-json', true],
      ['sitemap', true],
      ['old-redirect', true],
    ],
  );
  assert.match(pass.checks[0].detail, /live after 0s/);

  // Propagation retry: first attempt sees stale build.json, second sees new state.
  let seen = 0;
  const retried = await runPostDeploySmoke({
    site: origin,
    expectedState: state,
    request: async url => {
      if (new URL(url).pathname === '/_forge/build.json' && ++seen === 1)
        return new Response(JSON.stringify({ state: '0'.repeat(64), digest: 'old' }), { status: 200 });
      return routeFor(url);
    },
    wait: async () => {},
  });
  assert.equal(retried.ok, true);
  assert.equal(seen, 2);

  // Broken redirect fails the smoke check clearly, and long redirect Location is clamped to <= 240 chars.
  const longRedirect = `${origin}/signin?return=${'x'.repeat(400)}`;
  const broken = await runPostDeploySmoke({
    site: origin,
    expectedState: state,
    attempts: 1,
    request: async url =>
      new URL(url).pathname === '/-/explore'
        ? new Response(null, { status: 302, headers: { location: longRedirect } })
        : routeFor(url),
    wait: async () => {},
  });
  assert.equal(broken.ok, false);
  const redirectCheck = broken.checks.find(c => c.name === 'old-redirect');
  assert.equal(redirectCheck.ok, false);
  assert(redirectCheck.detail.length <= 240, 'diagnostic detail stays within endpoint 240-char limit');

  // Relative 301 Location: /explore is also accepted.
  const relative = await runPostDeploySmoke({
    site: origin,
    expectedState: state,
    attempts: 1,
    request: async url =>
      new URL(url).pathname === '/-/explore'
        ? new Response(null, { status: 301, headers: { location: '/explore' } })
        : routeFor(url),
    wait: async () => {},
  });
  assert.equal(relative.ok, true);
});

test('Item ab9f4400 (deploy 31970 edge propagation): build-version waits with backoff and cache-busting query, records liveAfterSeconds, and runs the other three checks once', async t => {
  const oldState = 'd'.repeat(64);
  const newState = '0'.repeat(64);
  const origin = 'https://dev.forge.nanthai.tech';
  const buildQueries = [];
  const counts = new Map();
  let clock = 1_795_419_600_000;
  const delays = [];

  const result = await runPostDeploySmoke({
    site: origin,
    expectedState: newState,
    expectedSequence: 31970,
    now: () => clock,
    wait: async ms => {
      delays.push(ms);
      clock += ms;
    },
    request: async (url, init) => {
      const parsed = new URL(url);
      counts.set(parsed.pathname, (counts.get(parsed.pathname) ?? 0) + 1);
      if (parsed.pathname === '/_forge/build.json') {
        buildQueries.push(parsed.searchParams.get('t'));
        assert.equal(init?.headers?.['cache-control'], 'no-cache');
        const tryNum = counts.get('/_forge/build.json');
        const body =
          tryNum < 5
            ? { state: oldState, sequence: 31969, digest: 'old', deployedAt: '2026-11-24T07:20:00Z' }
            : { state: newState, sequence: 31970, digest: 'new', deployedAt: '2026-11-24T07:35:00Z' };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (parsed.pathname === '/-/public/v1/explore/active.json')
        return new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (parsed.pathname === '/sitemap.xml')
        return new Response('<urlset></urlset>', {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        });
      if (parsed.pathname === '/-/explore')
        return new Response(null, { status: 301, headers: { location: '/explore' } });
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(delays, [2_000, 4_000, 8_000, 15_000]);
  assert.equal(result.liveAfterSeconds, 29);
  assert.equal(result.checks[0].name, 'build-version');
  assert.equal(result.checks[0].detail, `state ${newState.slice(0, 8)}, live after 29s`);
  assert.equal(new Set(buildQueries).size, 5, 'each build.json attempt uses a distinct cache-busting query');
  assert(buildQueries.every(Boolean), 'cache-busting query param is non-empty');
  assert.equal(counts.get('/-/public/v1/explore/active.json'), 1);
  assert.equal(counts.get('/sitemap.xml'), 1);
  assert.equal(counts.get('/-/explore'), 1);

  // Report payload puts 'live after Ns' into summary and build-version detail while keeping strict smoke shape.
  const report = buildDeployReport({
    state: newState,
    sequence: 31970,
    status: 'succeeded',
    url: 'https://github.com/NanthAI/nanthai-forge/actions/runs/45347253584',
    rawSmoke: result,
  });
  assert.equal(report.summary, 'live after 29s');
  assert.deepEqual(Object.keys(report.smoke).sort(), ['checks', 'ok']);
  assert.match(report.smoke.checks[0].detail, /live after 29s/);

  // Unchanged reports omit 'live after Ns' summary, and explicit failure summaries win.
  const unchangedReport = buildDeployReport({
    state: newState,
    sequence: 31970,
    status: 'succeeded',
    unchanged: true,
    rawSmoke: result,
  });
  assert.equal(unchangedReport.summary, undefined);
  const failedReport = buildDeployReport({
    state: newState,
    sequence: 31970,
    status: 'smoke-failed',
    summary: 'build-version: expected state 00000000, got dddddddd after 120s',
    rawSmoke: { ok: false, checks: result.checks },
  });
  assert.equal(failedReport.summary, 'build-version: expected state 00000000, got dddddddd after 120s');

  // Local built record helper extracts sequence and deployedAt only when state matches.
  const buildDir = temporaryDirectory(t, 'forge-deploy-built-');
  const recordDir = join(buildDir, '.cloudflare/output/v0/workers/default/assets/_forge');
  mkdirSync(recordDir, { recursive: true });
  writeFileSync(
    join(recordDir, 'build.json'),
    JSON.stringify({ state: newState, sequence: 31970, deployedAt: '2026-11-24T07:35:00Z' }),
  );
  assert.deepEqual(readLocalBuiltRecord(newState, buildDir), {
    sequence: 31970,
    deployedAt: '2026-11-24T07:35:00Z',
  });
  assert.equal(readLocalBuiltRecord(oldState, buildDir), null);
});

test('Item ab9f4400: build-version fails after the 120s propagation bound when the edge never switches', async () => {
  const oldState = 'd'.repeat(64);
  const newState = '0'.repeat(64);
  const origin = 'https://dev.forge.nanthai.tech';
  let clock = 1_795_419_600_000;
  const delays = [];
  let buildTries = 0;

  const result = await runPostDeploySmoke({
    site: origin,
    expectedState: newState,
    expectedSequence: 31970,
    now: () => clock,
    wait: async ms => {
      delays.push(ms);
      clock += ms;
    },
    request: async url => {
      const path = new URL(url).pathname;
      if (path === '/_forge/build.json') {
        buildTries++;
        return new Response(JSON.stringify({ state: oldState, sequence: 31969, digest: 'old' }), {
          status: 200,
        });
      }
      if (path === '/-/public/v1/explore/active.json')
        return new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (path === '/sitemap.xml')
        return new Response('<urlset></urlset>', {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        });
      return new Response(null, { status: 301, headers: { location: '/explore' } });
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.liveAfterSeconds, undefined);
  assert.equal(
    delays.reduce((sum, ms) => sum + ms, 0),
    120_000,
    'total propagation wait stops at the 120s bound',
  );
  assert.equal(buildTries, delays.length + 1);
  assert.equal(result.checks[0].ok, false);
  assert.equal(
    result.checks[0].detail,
    `expected state ${newState.slice(0, 8)}, got ${oldState.slice(0, 8)} after 120s`,
  );
  assert.deepEqual(
    result.checks.slice(1).map(c => c.ok),
    [true, true, true],
  );
});

test('Item ab9f4400: build-version fails fast on wrong-but-newer state or non-200 while other three checks keep 3 attempts', async () => {
  const oldState = 'd'.repeat(64);
  const newState = '0'.repeat(64);
  const newerState = '9'.repeat(64);
  const origin = 'https://dev.forge.nanthai.tech';
  const okOther = path => {
    if (path === '/-/public/v1/explore/active.json')
      return new Response(JSON.stringify({ projects: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (path === '/sitemap.xml')
      return new Response('<urlset></urlset>', {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    return new Response(null, { status: 301, headers: { location: '/explore' } });
  };

  // 1. Wrong-but-newer sequence fails immediately without waiting.
  let tries = 0;
  const delays1 = [];
  const newerSeq = await runPostDeploySmoke({
    site: origin,
    expectedState: newState,
    expectedSequence: 31970,
    wait: async ms => delays1.push(ms),
    request: async url => {
      const path = new URL(url).pathname;
      if (path === '/_forge/build.json') {
        tries++;
        return new Response(JSON.stringify({ state: newerState, sequence: 31971, digest: 'newer' }), {
          status: 200,
        });
      }
      return okOther(path);
    },
  });
  assert.equal(newerSeq.ok, false);
  assert.equal(tries, 1);
  assert.deepEqual(delays1, []);
  assert.match(newerSeq.checks[0].detail, /got newer state 99999999 \(#31971\)/);

  // 2. Wrong-but-newer deployedAt (without sequence) fails immediately without waiting.
  tries = 0;
  const delays2 = [];
  const newerTime = await runPostDeploySmoke({
    site: origin,
    expectedState: newState,
    expectedDeployedAt: '2026-11-24T07:35:00Z',
    wait: async ms => delays2.push(ms),
    request: async url => {
      const path = new URL(url).pathname;
      if (path === '/_forge/build.json') {
        tries++;
        return new Response(
          JSON.stringify({ state: newerState, deployedAt: '2026-11-24T07:36:00Z', digest: 'newer' }),
          { status: 200 },
        );
      }
      return okOther(path);
    },
  });
  assert.equal(newerTime.ok, false);
  assert.equal(tries, 1);
  assert.deepEqual(delays2, []);
  assert.match(newerTime.checks[0].detail, /got newer state 99999999/);

  // 3. Mid-wait switch from old state to a different non-expected state fails immediately on the switch.
  tries = 0;
  const delays3 = [];
  const switchedWrong = await runPostDeploySmoke({
    site: origin,
    expectedState: newState,
    wait: async ms => delays3.push(ms),
    request: async url => {
      const path = new URL(url).pathname;
      if (path === '/_forge/build.json') {
        tries++;
        const state = tries === 1 ? oldState : newerState;
        return new Response(JSON.stringify({ state, digest: `d${tries}` }), { status: 200 });
      }
      return okOther(path);
    },
  });
  assert.equal(switchedWrong.ok, false);
  assert.equal(tries, 2);
  assert.deepEqual(delays3, [2_000]);
  assert.match(switchedWrong.checks[0].detail, /edge switched from dddddddd to 99999999/);

  // 4. Non-200 on build.json fails immediately without waiting.
  tries = 0;
  const delays4 = [];
  const non200 = await runPostDeploySmoke({
    site: origin,
    expectedState: newState,
    wait: async ms => delays4.push(ms),
    request: async url => {
      const path = new URL(url).pathname;
      if (path === '/_forge/build.json') {
        tries++;
        return new Response('bad gateway', { status: 502 });
      }
      return okOther(path);
    },
  });
  assert.equal(non200.ok, false);
  assert.equal(tries, 1);
  assert.deepEqual(delays4, []);
  assert.equal(non200.checks[0].status, 502);
  assert.equal(non200.checks[0].detail, 'HTTP 502');

  // 5. Other three checks keep their 3-attempt retry loop without re-running build-version.
  let buildCount = 0;
  let sitemapCount = 0;
  const delays5 = [];
  const otherRetry = await runPostDeploySmoke({
    site: origin,
    expectedState: newState,
    wait: async ms => delays5.push(ms),
    request: async url => {
      const path = new URL(url).pathname;
      if (path === '/_forge/build.json') {
        buildCount++;
        return new Response(JSON.stringify({ state: newState, digest: 'ok' }), { status: 200 });
      }
      if (path === '/sitemap.xml' && ++sitemapCount < 3) return new Response('retry', { status: 503 });
      return okOther(path);
    },
  });
  assert.equal(otherRetry.ok, true);
  assert.equal(buildCount, 1);
  assert.equal(sitemapCount, 3);
  assert.deepEqual(delays5, [3_000, 3_000]);
});

test('Item 8b6efb50: checkoutForgeState replaces a directory with a file and a file with a directory cleanly', async t => {
  const dir = temporaryDirectory(t, 'forge-deploy-swap-');
  mkdirSync(join(dir, 'docs/guide'), { recursive: true });
  writeFileSync(join(dir, 'docs/guide/index.md'), 'old dir content\n');
  writeFileSync(join(dir, 'notes'), 'old file content\n');

  const docBytes = Buffer.from('# Single doc file\n');
  const nestedBytes = Buffer.from('nested under former file\n');
  const blobs = new Map([
    [hash(docBytes), docBytes],
    [hash(nestedBytes), nestedBytes],
  ]);
  const manifestBytes = Buffer.from(
    JSON.stringify({
      files: [
        { path: 'docs/guide', blob: hash(docBytes), mode: 'file' },
        { path: 'notes/item.md', blob: hash(nestedBytes), mode: 'file' },
      ],
    }),
  );
  const state = hash(manifestBytes);
  blobs.set(state, manifestBytes);

  const stats = await checkoutForgeState({
    dir,
    state,
    sequence: 99,
    api: async cmd => {
      if (cmd.kind === 'manifest')
        return { sha256: state, size: manifestBytes.length, url: `https://r2.invalid/${state}` };
      assert.equal(cmd.kind, 'source');
      assert.equal(cmd.sequence, 99);
      return {
        mode: 'catalog',
        rows: cmd.digests.map(d => ({
          digest: d,
          size: blobs.get(d).length,
          url: `https://r2.invalid/${d}`,
        })),
      };
    },
    request: async url => new Response(blobs.get(url.split('/').at(-1)), { status: 200 }),
  });

  assert.equal(stats.totalFiles, 2);
  assert(lstatSync(join(dir, 'docs/guide')).isFile());
  assert.equal(readFileSync(join(dir, 'docs/guide'), 'utf8'), '# Single doc file\n');
  assert(lstatSync(join(dir, 'notes')).isDirectory());
  assert.equal(readFileSync(join(dir, 'notes/item.md'), 'utf8'), 'nested under former file\n');
});

test('Item 8b6efb50 incident (web-deploy run 45284079680, "Missing source grant for blob"): checkout decodes the server reply shapes: physical-manifest rows, packed ranges, recipe closures and recipe byte trees', async t => {
  const dir = temporaryDirectory(t, 'forge-deploy-shapes-');
  // Three small packed blobs share one pack object; the server signs each with a {offset,total} range.
  const packedA = Buffer.from('export const a = 1;\n');
  const packedB = Buffer.from('export const b = 2;\n');
  const pack = Buffer.concat([Buffer.from('xx'), packedA, packedB, Buffer.from('yy')]);
  const packId = hash(pack);
  // One large file stored as a forge-object-recipe byte tree (height 1, two leaves).
  const leaf1 = Buffer.from('first half of a large file\n');
  const leaf2 = Buffer.from('second half of a large file\n');
  const large = Buffer.concat([leaf1, leaf2]);
  const ref = (bytes, height = 0, length = bytes.length) => ({
    sha256: hash(bytes),
    size: bytes.length,
    height,
    length,
  });
  const page = Buffer.from(
    JSON.stringify({ kind: 'forge-byte-tree', schema: 1, children: [ref(leaf1), ref(leaf2)] }),
  );
  const recipe = Buffer.from(
    JSON.stringify({
      kind: 'forge-object-recipe',
      schema: 1,
      object: { sha256: hash(large), size: large.length },
      tree: ref(page, 1, large.length),
    }),
  );
  // One file whose recipe comes with a signed closure (ordered leaves).
  const closed = Buffer.concat([leaf2, leaf1]);
  const objects = new Map([
    [packId, pack],
    [hash(leaf1), leaf1],
    [hash(leaf2), leaf2],
    [hash(page), page],
    [hash(recipe), recipe],
  ]);
  // The manifest itself is stored as a recipe (one leaf), like a large State.
  const manifestBytes = Buffer.from(
    JSON.stringify({
      files: [
        { path: 'src/a.ts', blob: hash(packedA), mode: 'file' },
        { path: 'src/b.ts', blob: hash(packedB), mode: 'file' },
        { path: 'assets/large.txt', blob: hash(large), mode: 'file' },
        { path: 'assets/closed.txt', blob: hash(closed), mode: 'file' },
      ],
    }),
  );
  const state = hash(manifestBytes);
  objects.set(state, manifestBytes);
  const manifestRecipe = Buffer.from(
    JSON.stringify({
      kind: 'forge-object-recipe',
      schema: 1,
      object: { sha256: state, size: manifestBytes.length },
      tree: ref(manifestBytes),
    }),
  );
  objects.set(hash(manifestRecipe), manifestRecipe);
  const url = id => `https://r2.invalid/${id}`;
  const physicalRow = (bytes, offset) => ({
    descriptor: { object: { sha256: hash(bytes), size: bytes.length }, recipe: null },
    url: url(packId),
    range: { offset, total: pack.length },
  });
  const catalogRow = id => ({ digest: id, size: objects.get(id).length, location: 'r2', url: url(id) });
  const calls = [];
  const api = async cmd => {
    calls.push(cmd);
    assert.equal(cmd.kind, 'source');
    if (cmd.object) return { mode: 'catalog', rows: cmd.digests.map(catalogRow) };
    // The member page: physical-manifest rows for packed blobs, catalog rows for recipe members.
    return {
      mode: 'catalog',
      rows: cmd.digests.map(id =>
        id === hash(packedA)
          ? physicalRow(packedA, 2)
          : id === hash(packedB)
            ? physicalRow(packedB, 2 + packedA.length)
            : id === hash(large)
              ? {
                  digest: id,
                  size: large.length,
                  location: 'recipe',
                  recipe: { digest: hash(recipe), size: recipe.length },
                }
              : {
                  digest: id,
                  size: closed.length,
                  location: 'recipe',
                  recipe: { digest: '0'.repeat(64), size: 1 },
                  closure: [
                    { digest: hash(leaf2), size: leaf2.length, url: url(hash(leaf2)) },
                    { digest: hash(leaf1), size: leaf1.length, url: url(hash(leaf1)) },
                  ],
                },
      ),
    };
  };
  const request = async (target, init) => {
    const bytes = objects.get(target.split('/').at(-1));
    const range = init.headers.range && /^bytes=(\d+)-(\d+)$/.exec(init.headers.range);
    if (!range) return new Response(bytes, { status: 200 });
    return new Response(bytes.subarray(Number(range[1]), Number(range[2]) + 1), { status: 206 });
  };
  const stats = await checkoutForgeState({
    dir,
    state,
    manifest: {
      sha256: state,
      size: manifestBytes.length,
      url: null,
      recipe: { sha256: hash(manifestRecipe), size: manifestRecipe.length },
    },
    api,
    request,
  });
  assert.equal(stats.updatedFiles, 4);
  assert.equal(readFileSync(join(dir, 'src/a.ts'), 'utf8'), packedA.toString());
  assert.equal(readFileSync(join(dir, 'src/b.ts'), 'utf8'), packedB.toString());
  assert.equal(readFileSync(join(dir, 'assets/large.txt'), 'utf8'), large.toString());
  assert.equal(readFileSync(join(dir, 'assets/closed.txt'), 'utf8'), closed.toString());
  // Recipe nodes are granted under their owner so the server checks recipe membership.
  assert(calls.filter(c => c.object).every(c => c.object === state || c.object === hash(large)));
  assert(
    calls.some(c => c.object === state),
    'manifest recipe read through the State',
  );
});

test('Item 8b6efb50: planConvexWithBootstrap falls back to GitHub main when /deploy/actions returns 404', async () => {
  const err = new Error('HTTP 404');
  err.httpStatus = 404;
  const plan = await planConvexWithBootstrap(async () => {
    throw err;
  });
  assert.equal(plan.deploy, true);
  assert.equal(plan.bootstrap, true);
  assert.equal(plan.head, '');
  assert.equal(plan.sequence, '');
});

test('Item 8b6efb50: planWebDeploy flags skipped_unchanged for backend-only changes, defers inside window without skipping, and rebuilds on failure or deep', () => {
  const h41 = 'a'.repeat(64);
  const h42 = 'b'.repeat(64);
  const deployedAt = '2026-11-23T21:00:00Z';
  const live = {
    state: h41,
    sequence: 41,
    commit: 'c'.repeat(40),
    deployedAt,
    digest: 'd1',
    sources: ['src/public-meta.ts'],
    errorCodes: 'ec1',
  };
  const baseContext = {
    head: h42,
    sequence: 42,
    alreadyLive: false,
    newestFailed: false,
    lastDeployed: { sequence: 41, head: h41 },
    lastUploaded: { sequence: 41, head: h41 },
    changedPaths: ['convex/serverOnly.ts'],
  };

  // Backend-only change not served by web: skips build AND sets skipped_unchanged so CI reports live #41.
  const backendOnly = planWebDeploy({
    context: baseContext,
    live,
    build: [],
    now: Date.parse(deployedAt) + 60_000,
    errorCodes: 'ec1',
  });
  assert.equal(backendOnly.build, false);
  assert.equal(backendOnly.skipped_unchanged, true);
  assert.equal(backendOnly.live_head, h41);
  assert.equal(backendOnly.live_sequence, 41);

  // Served change inside the 5-min window: defers (build=false) and must NOT set skipped_unchanged.
  const insideWindow = planWebDeploy({
    context: { ...baseContext, changedPaths: ['web/src/app/App.tsx'] },
    live,
    build: [],
    now: Date.parse(deployedAt) + 60_000,
    errorCodes: 'ec1',
  });
  assert.equal(insideWindow.build, false);
  assert.equal(insideWindow.skipped_unchanged, false);

  // Prior smoke/deploy failure always rebuilds (never skipped_unchanged).
  const retryFailed = planWebDeploy({
    context: { ...baseContext, newestFailed: true },
    live,
    build: [],
    now: Date.parse(deployedAt) + 60_000,
    errorCodes: 'ec1',
  });
  assert.equal(retryFailed.build, true);
  assert.equal(retryFailed.skipped_unchanged, false);

  // Deep scheduled run after an unchanged skip still checks src/ changes outside the window.
  const deepCheck = planWebDeploy({
    context: { ...baseContext, alreadyLive: true, changedPaths: ['src/some-helper.ts'] },
    live,
    build: [],
    now: Date.parse(deployedAt) + 10 * 60_000,
    deep: true,
    errorCodes: 'ec1',
  });
  assert.equal(deepCheck.build, true);
  assert.equal(deepCheck.skipped_unchanged, false);
});
