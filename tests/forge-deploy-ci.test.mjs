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
  checkoutForgeState,
  planConvexWithBootstrap,
  planWebDeploy,
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
      `${origin}/_forge/build.json`,
      () =>
        new Response(JSON.stringify({ state, digest: 'd1', deployedAt: '2026-11-23T21:00:00Z' }), {
          status: 200,
        }),
    ],
    [
      `${origin}/-/public/v1/explore/active.json`,
      () =>
        new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      `${origin}/sitemap.xml`,
      () =>
        new Response(
          '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
          {
            status: 200,
            headers: { 'content-type': 'application/xml' },
          },
        ),
    ],
    [
      `${origin}/-/explore`,
      () => new Response(null, { status: 301, headers: { location: `${origin}/explore` } }),
    ],
  ]);

  const pass = await runPostDeploySmoke({
    site: origin,
    expectedState: state,
    request: async url => okRoutes.get(url)(),
    wait: async () => {},
  });
  assert.equal(pass.ok, true);
  assert.deepEqual(
    pass.checks.map(c => [c.name, c.ok]),
    [
      ['build-version', true],
      ['public-read-json', true],
      ['sitemap', true],
      ['old-redirect', true],
    ],
  );

  // Propagation retry: first attempt sees stale build.json, second sees new state.
  let seen = 0;
  const retried = await runPostDeploySmoke({
    site: origin,
    expectedState: state,
    request: async url => {
      if (url === `${origin}/_forge/build.json` && ++seen === 1)
        return new Response(JSON.stringify({ state: '0'.repeat(64), digest: 'old' }), { status: 200 });
      return okRoutes.get(url)();
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
      url === `${origin}/-/explore`
        ? new Response(null, { status: 302, headers: { location: longRedirect } })
        : okRoutes.get(url)(),
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
      url === `${origin}/-/explore`
        ? new Response(null, { status: 301, headers: { location: '/explore' } })
        : okRoutes.get(url)(),
    wait: async () => {},
  });
  assert.equal(relative.ok, true);
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
