// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';

test('byte pages leave a split UTF-8 failure glyph for the next page', async () => {
  const { checkLogPage } = await import('../dist/check-log-page.js');
  const bytes = Buffer.from('ok\n✖ test failed\n');
  const first = checkLogPage(bytes.subarray(0, 4), 0, bytes.length);
  assert.equal(first.text, 'ok\n');
  assert.equal(first.nextOffset, 3);
  const next = checkLogPage(bytes.subarray(first.nextOffset), first.nextOffset, bytes.length);
  assert.match(next.text, /^✖ test failed/);
  assert.equal(next.nextOffset, bytes.length);
});

test('relative time handles just now centrally with or without an ago suffix', async () => {
  const { age } = await import(moduleUrl('../web/src/ui/status.ts'));
  assert.equal(age(1000, 1000), 'just now');
  assert.equal(age(1000, 1000, true), 'just now');
  assert.equal(age(1000, 41000, true), '40 s ago');
  assert.equal(age(undefined, 41000, true), '');
});
