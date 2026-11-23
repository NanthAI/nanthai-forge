// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { moduleUrl } from './convex-module.mjs';

test('SI-03 incident: every Convex module imports under the account device registration guard', async t => {
  const files = readdirSync(new URL('../convex/', import.meta.url), { recursive: true })
    .filter(
      file =>
        file.endsWith('.ts') &&
        !file.endsWith('.d.ts') &&
        !file.endsWith('.config.ts') &&
        !file.split(/[\\/]/).includes('_generated') &&
        !/(^|\/)schema\.ts$/.test(file),
    )
    .sort();
  const failures = [];
  for (const file of files) {
    try {
      await import(moduleUrl(`../convex/${file}`));
    } catch (error) {
      failures.push(`${file}: ${error.message}`);
    }
  }
  t.diagnostic(`${files.length} Convex function/helper modules checked`);
  assert.deepEqual(failures, [], failures.join('\n'));
});
