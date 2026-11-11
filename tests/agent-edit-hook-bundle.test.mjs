// SPDX-License-Identifier: Apache-2.0
// The first-write hook runs on every agent edit, so what it loads before it can answer is its cost.
// Schemas (zod) and the Convex client belong to code it imports lazily, never to what it loads
// first. A static import that pulls them in grew the hosted chunk from about 12 KB to 147 KB and
// failed the CPU budget only under load (board Lane 3, 2026-11-06); this fails the build instead,
// from bytes alone and in milliseconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  readdirSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dist = new URL('../dist/', import.meta.url).pathname;
const chunk = name => join(dist, name);
const text = name => readFileSync(chunk(name), 'utf8');
/** Static `import ... from "./x.js"` edges only: `import("./x.js")` is lazy and stays out. */
const staticImports = source =>
  [...source.matchAll(/^import\s[^;]*?from\s+["'](\.\/[^"']+)["']/gm)].map(match => match[1].slice(2));
function eagerClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    assert.ok(existsSync(chunk(name)), `hook chunk ${name} is imported but missing from dist`);
    queue.push(...staticImports(text(name)));
  }
  return [...seen];
}
// The bundler leaves a `//#region <module path>` marker per bundled module.
const heavy = [
  [/node_modules\/zod\//, 'zod schemas'],
  [/node_modules\/convex\//, 'the Convex client'],
  [/\bz\.object\(|\bZodError\b|\bConvexHttpClient\b|\bConvexClient\b/, 'zod or Convex client code'],
];
// 147 KB was the regression; the hosted chunk and everything it loads first is about 24 KB.
const eagerBytesCeiling = 64 * 1024;

test('the first-write hook loads neither zod nor the Convex client before it can answer', () => {
  assert.ok(
    existsSync(chunk('agent-edit-hook.js')),
    'run build:core first: dist/agent-edit-hook.js is missing',
  );
  const hosted = readdirSync(dist).filter(name => /^agent-edit-hook-agent-edit-hosted-.+\.js$/.test(name));
  assert.equal(
    hosted.length,
    1,
    `expected one hosted first-write chunk, found ${hosted.join(', ') || 'none'}`,
  );
  for (const entry of ['agent-edit-hook.js', hosted[0]]) {
    const closure = eagerClosure(entry);
    let bytes = 0;
    for (const name of closure) {
      const source = text(name);
      bytes += Buffer.byteLength(source);
      for (const [pattern, label] of heavy)
        assert.ok(
          !pattern.test(source),
          `${entry} statically loads ${label} through ${name}; import it lazily (await import) in the code path that needs it`,
        );
    }
    assert.ok(
      bytes <= eagerBytesCeiling,
      `${entry} loads ${Math.round(bytes / 1024)} KB before answering (ceiling ${eagerBytesCeiling / 1024} KB): ${closure.join(', ')}`,
    );
  }
});

test('the guard sees a static zod or Convex import and ignores a lazy one', () => {
  assert.deepEqual(staticImports('import { a } from "./x-1.js";\nconst m = await import("./y-2.js");'), [
    'x-1.js',
  ]);
  assert.deepEqual(staticImports('import "node:fs";\nimport { b as c } from "./z.js";'), ['z.js']);
});

test('rebuilding the hook retires its old hashed chunks and preserves unrelated build output', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-hook-rebuild-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(
    join(root, 'src/agent-edit-hook.ts'),
    "export const hosted = () => import('./agent-edit-hosted');",
  );
  const hosted = join(root, 'src/agent-edit-hosted.ts');
  const sibling = join(root, 'dist/cli-entry.js');
  const declaration = join(root, 'dist/agent-edit-hook.d.ts');
  writeFileSync(sibling, 'synthetic CLI output');
  writeFileSync(declaration, 'synthetic declaration');
  const buildScript = fileURLToPath(new URL('../scripts/build-edit-hook.mjs', import.meta.url));
  const build = () =>
    execFileSync(process.execPath, [buildScript], { cwd: root, stdio: 'pipe', timeout: 30_000 });
  writeFileSync(hosted, 'export const version = 1;');
  build();
  const first = readdirSync(join(root, 'dist')).filter(name =>
    name.startsWith('agent-edit-hook-agent-edit-hosted-'),
  );
  assert.equal(first.length, 1);
  writeFileSync(hosted, 'export const version = 2;');
  build();
  const second = readdirSync(join(root, 'dist')).filter(name =>
    name.startsWith('agent-edit-hook-agent-edit-hosted-'),
  );
  assert.equal(second.length, 1);
  assert.notEqual(second[0], first[0], 'changed source emits a new chunk');
  assert.equal(existsSync(join(root, 'dist', first[0])), false);
  assert.equal(readFileSync(sibling, 'utf8'), 'synthetic CLI output');
  assert.equal(readFileSync(declaration, 'utf8'), 'synthetic declaration');
  writeFileSync(hosted, 'export const version = ;');
  assert.throws(build, 'a failed rebuild must preserve the last successful chunk');
  assert.equal(existsSync(join(root, 'dist', second[0])), true);
});
