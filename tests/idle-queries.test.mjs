// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { idleQueryFindings } from '../scripts/check-idle-queries.mjs';

test('queries whose arguments follow the clock are rejected', () => {
  const view = 'web/src/Row.tsx';
  assert.equal(
    idleQueryFindings(
      view,
      'const now = useNow();\nconst c = useQuery(api.x.counts, {\n  projectId,\n  refreshKey: Math.floor(now / 60000),\n});',
    ).length,
    2,
  );
  assert.equal(
    idleQueryFindings(view, 'const q = useQuery(api.x.y, { since: Date.now() - 5000 });').length,
    1,
  );
  assert.equal(
    idleQueryFindings(view, 'const now = useNow();\nconst q = useQuery(api.x.y, { now });').length,
    1,
  );
  assert.equal(
    idleQueryFindings('convex/x.ts', 'const args = { refreshKey: v.optional(v.number()) };').length,
    1,
  );
});

test('clock reads outside query arguments and test files are allowed', () => {
  const view = 'web/src/Row.tsx';
  assert.deepEqual(
    idleQueryFindings(
      view,
      'const now = useNow();\nconst q = useQuery(api.x.y, { projectId });\nage(at, now);',
    ),
    [],
  );
  assert.deepEqual(idleQueryFindings('web/src/Row.test.tsx', 'useQuery(a, { at: Date.now() })'), []);
  assert.deepEqual(idleQueryFindings('src/other.ts', 'useQuery(a, { at: Date.now() })'), []);
});

test('the repository has no clock-derived live query arguments', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const { join, relative } = await import('node:path');
  const root = new URL('..', import.meta.url).pathname;
  const walk = dir =>
    readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
      entry.name === 'node_modules' || entry.name === '_generated'
        ? []
        : entry.isDirectory()
          ? walk(join(dir, entry.name))
          : [join(dir, entry.name)],
    );
  const findings = ['web/src', 'convex'].flatMap(dir =>
    walk(join(root, dir)).flatMap(file =>
      idleQueryFindings(relative(root, file), readFileSync(file, 'utf8')),
    ),
  );
  assert.deepEqual(findings, []);
});
