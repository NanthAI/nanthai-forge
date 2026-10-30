// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convexApiModules, prepareConvexApi, renderConvexApi } from '../scripts/prepare-convex-api.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'forge-api-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, text = 'throw new Error("module must never execute");') => {
    const path = join(root, 'convex', name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };
  return { root, put };
}

test('API inventory follows additions and deletions without importing source or generated files', t => {
  const { root, put } = fixture(t);
  for (const name of [
    'first.ts',
    'nested/hyphen-name.ts',
    'javascript.js',
    'schema.ts',
    'auth.config.ts',
    'types.d.ts',
    '_generated/server.ts',
  ])
    put(name);
  assert.deepEqual(convexApiModules(root), ['first', 'javascript', 'nested/hyphen-name']);
  const first = prepareConvexApi(root);
  assert.equal(first.modules, 3);
  assert.equal(first.written, true);
  const path = join(root, 'convex/_generated/api.d.ts');
  const mtime = statSync(path).mtimeMs;
  assert.equal(prepareConvexApi(root).written, false);
  assert.equal(statSync(path).mtimeMs, mtime);
  put('second.ts');
  rmSync(join(root, 'convex/first.ts'));
  assert.equal(prepareConvexApi(root).written, true);
  const source = readFileSync(path, 'utf8');
  assert.match(source, /\.\.\/second\.js/);
  assert.doesNotMatch(source, /\.\.\/first\.js/);
  assert.match(source, /FilterApi<typeof fullApi, FunctionReference<any, "public">>/);
  assert.match(source, /FilterApi<typeof fullApi, FunctionReference<any, "internal">>/);
  assert.equal(source, renderConvexApi(convexApiModules(root)));
});

test('API inventory doubled dogfood fixture uses directory reads rather than per-module source reads', t => {
  const { root, put } = fixture(t);
  // Twice 560 Lanes worth of independent modules, across bounded feature directories.
  for (let i = 0; i < 1120; i++) put(`feature${i % 20}/module${i}.ts`);
  let directoryReads = 0;
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const modules = convexApiModules(root, {
    readdirSync(...args) {
      directoryReads++;
      return readdirSync(...args);
    },
  });
  const source = renderConvexApi(modules);
  assert.equal(modules.length, 1120);
  assert.equal(directoryReads, 21);
  assert.ok(Buffer.byteLength(source) < 150_000, 'the only retained aggregate is a small declaration string');
  assert.ok(
    process.memoryUsage().heapUsed - before < 16 * 1024 * 1024,
    'generation stays within a 16 MiB heap allocation budget',
  );
  t.diagnostic(
    JSON.stringify({
      modules: modules.length,
      directoryReads,
      convexCalls: 0,
      sourceFileReads: 0,
      bytes: Buffer.byteLength(source),
      heapDeltaBytes: process.memoryUsage().heapUsed - before,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      wallMs: performance.now() - started,
    }),
  );
});
