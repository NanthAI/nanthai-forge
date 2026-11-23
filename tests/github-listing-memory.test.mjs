// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

test('Issue e165787c: listing 500k to 2M paths holds a fixed memory envelope', t => {
  const mib = 1024 * 1024;
  const run = files => {
    const output = execFileSync(
      process.execPath,
      [
        '--max-old-space-size=96',
        '--max-semi-space-size=8',
        fileURLToPath(new URL('./github-listing-memory-worker.mjs', import.meta.url)),
        String(files),
      ],
      { encoding: 'utf8' },
    );
    const result = JSON.parse(output.trim().split('\n').at(-1));
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.files, files);
    assert.ok(result.pages >= Math.ceil(files / 65_536));
    assert.ok(result.peakRssBytes <= 224 * mib, JSON.stringify(result));
    return result.peakRssBytes;
  };
  const small = run(500_000);
  const large = run(2_000_000);
  assert.ok(large <= small + 16 * mib, `RSS grew from ${small} to ${large}`);
});
