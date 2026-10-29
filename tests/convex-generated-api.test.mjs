// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const convex = fileURLToPath(new URL('../convex/', import.meta.url));
const modules = directory =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '_generated' ? [] : modules(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')
      ? [relative(convex, path).slice(0, -3)]
      : [];
  });

// A stale committed api.d.ts hides new modules from typecheck; deploy codegen then fails.
test('committed Convex api.d.ts lists exactly the function modules', () => {
  const generated = [
    ...readFileSync(join(convex, '_generated/api.d.ts'), 'utf8').matchAll(
      /import type \* as \w+ from "\.\.\/(.+)\.js";/g,
    ),
  ].map(match => match[1]);
  const expected = modules(convex).filter(name => !['schema', 'auth.config'].includes(name));
  assert.deepEqual([...generated].sort(), expected.sort(), 'run Convex codegen and commit convex/_generated');
});
