// SPDX-License-Identifier: Apache-2.0
// Header-only and comment-only edits (Issue c14f4065): the same program runs, so preflight adds only
// the tests that read the file's text. Detection is local: base bytes from this machine's stores.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commentOnlyEdit } from '../dist/preflight-comment-only.js';
import { preflightPlan, preflightRuntime } from '../dist/agent-preflight.js';
import { digest } from '../dist/portable-hash.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { selectPreflightTests, selectTests } from '../scripts/test-impact.mjs';

test.beforeEach(t =>
  t.mock.method(preflightRuntime, 'filesystemEventHealth', () => ({
    ok: true,
    latencyMs: 1,
    fseventsdRssMb: null,
    fseventsdCpuPercent: null,
    reason: null,
    attempts: [],
  })),
);

test('comment-only means the parser sees the same program', () => {
  const code = 'export const n = 1;\n';
  assert.equal(commentOnlyEdit('src/a.ts', `// old header\n${code}`, `/** New header. */\n${code}`), true);
  assert.equal(commentOnlyEdit('src/a.ts', code, `${code}// trailing note\n`), true);
  assert.equal(commentOnlyEdit('src/a.mjs', 'f(1, 2);', 'f(1, /* two */ 2);'), true);
  // A `//` inside a string or a regex is code.
  assert.equal(commentOnlyEdit('src/a.ts', "const u = 'http://a';", "const u = 'http://b';"), false);
  assert.equal(commentOnlyEdit('src/a.ts', 'const r = /a\\/\\/b/;', 'const r = /a\\/\\/c/;'), false);
  assert.equal(commentOnlyEdit('src/a.ts', code, 'export const n = 2;\n'), false);
  // Unparseable or unchanged bytes are never comment-only.
  assert.equal(commentOnlyEdit('src/a.ts', code, `${code}export const = ;`), false);
  assert.equal(commentOnlyEdit('src/a.ts', code, code), false);
  // `#` languages: the leading header only; the shebang is code.
  const script = '#!/bin/sh\n# Old header.\necho hi\n';
  assert.equal(commentOnlyEdit('scripts/x.sh', script, '#!/bin/sh\n# New header.\n\necho hi\n'), true);
  assert.equal(commentOnlyEdit('scripts/x.sh', script, '#!/bin/bash\n# Old header.\necho hi\n'), false);
  assert.equal(commentOnlyEdit('scripts/x.sh', script, '#!/bin/sh\n# Old header.\necho bye\n'), false);
  assert.equal(commentOnlyEdit('ci.yml', '# a\non: push\n', '# b\non: push\n'), true);
  assert.equal(commentOnlyEdit('docs/a.md', '# a', '# b'), false);
});

const graph = () =>
  new Map(
    Object.entries({
      'package.json': '{"scripts":{}}',
      'src/a.ts': 'export const n = 1;',
      'src/b.ts': "import './a.js';",
      'tests/a.test.mjs': "import '../dist/a.js';",
      'tests/b.test.mjs': "import '../dist/b.js';",
      'tests/reads-a.test.mjs': "import { readFileSync } from 'node:fs'; readFileSync('src/a.ts');",
      'tests/unrelated.test.mjs': '',
    }),
  );

test('a comment-only edit adds only the tests that read the file; coverage keeps every consumer', () => {
  const files = graph();
  const paths = ['src/a.ts'];
  const graphCache = {};
  const complete = selectTests({ files, paths }, graphCache);
  const plain = selectPreflightTests({ files, paths }, graphCache);
  assert.ok(plain.tests.includes('tests/a.test.mjs') && plain.tests.includes('tests/b.test.mjs'));
  const plan = selectPreflightTests({ files, paths, commentOnly: paths }, graphCache);
  assert.deepEqual(plan.tests, ['tests/reads-a.test.mjs']);
  assert.deepEqual(plan.commentOnly, ['src/a.ts']);
  // Exact partition: the importers stay in landing coverage.
  assert.deepEqual([...plan.tests, ...plan.deferredTests].sort(), complete.tests);
  // Another, behavioural path in the same change still selects its own consumers.
  const both = selectPreflightTests({ files, paths: ['src/a.ts', 'src/b.ts'], commentOnly: paths });
  assert.deepEqual(both.tests, ['tests/b.test.mjs', 'tests/reads-a.test.mjs']);
});

test('preflight finds comment-only paths from the base State in the local object store', t => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-preflight-comment-'));
  const root = join(dir, 'lane');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = graph();
  bytes.set('package.json', '{"type":"module","scripts":{}}');
  const store = join(clientCacheRoot(root), 'objects');
  mkdirSync(store, { recursive: true });
  const put = body => {
    writeFileSync(join(store, digest(body)), body);
    return digest(body);
  };
  const entries = () => [...bytes].map(([path, body]) => ({ path, blob: put(body), mode: 'file' }));
  const base = put(
    JSON.stringify({
      schema: 1,
      kind: 'forge-source-state',
      parents: [],
      files: entries(),
      message: 'base',
      at: '2026-11-07T00:00:00.000Z',
    }),
  );
  bytes.set('src/a.ts', '// SPDX header added.\nexport const n = 1;');
  bytes.set('src/b.ts', "import './a.js'; // the only consumer");
  for (const [path, body] of bytes) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const laneId = '11111111-1111-4111-8111-111111111111';
  const head = entries();
  const plan = preflightPlan(
    root,
    { paths: ['src/a.ts', 'src/b.ts'], complete: true },
    { laneId, files: head, base },
  );
  assert.deepEqual(plan.local.commentOnly, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(plan.tests, ['tests/reads-a.test.mjs']);
  assert.ok(
    plan.deferredTests.includes('tests/a.test.mjs') && plan.deferredTests.includes('tests/b.test.mjs'),
  );
  assert.match(plan.local.summary, /2 comment-only path\(s\) add only the tests that read them/);
  // Without the base bytes nothing is assumed comment-only.
  rmSync(store, { recursive: true, force: true });
  const unknown = preflightPlan(
    root,
    { paths: ['src/a.ts', 'src/b.ts'], complete: true },
    { laneId, files: head, base },
  );
  assert.equal(unknown.local.commentOnly, undefined);
});
