// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const resolveModule = (from, specifier) => {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  for (const suffix of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const path = base + suffix;
    if (/\.tsx?$/.test(path) && existsSync(path)) return path;
  }
  return null;
};
/** Static (non-type) import closure of the entry and the Hosted page that loads right after it. */
function firstLoadSources() {
  const queue = ['web/src/main.tsx', 'web/src/Hosted.tsx'].map(path => resolve(root, path)),
    seen = new Set(queue),
    external = new Set();
  while (queue.length) {
    const file = queue.shift();
    for (const [statement, specifier] of readFileSync(file, 'utf8')
      .matchAll(/^(?:import|export)\s[^;]*?from\s+'([^']+)'/gm)
      .map(match => [match[0], match[1]])) {
      if (/^(?:import|export)\s+type\b/.test(statement)) continue;
      const path = resolveModule(file, specifier);
      if (!path) external.add(specifier);
      else if (!seen.has(path)) (seen.add(path), queue.push(path));
    }
  }
  return { files: [...seen].map(path => relative(root, path)), external };
}

test('first load does not statically reach the source reader or the language parsers', () => {
  const { files, external } = firstLoadSources();
  for (const heavy of ['web/src/browser-source.ts', 'src/code-imports.ts', 'web/src/source-highlight.ts'])
    assert(!files.includes(heavy), `${heavy} must load on demand, not with the first page`);
  assert.deepEqual(
    [...external].filter(name => name.startsWith('@lezer/')),
    [],
  );
});
