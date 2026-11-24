// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { idleReadOptions } from '../scripts/idle-read-options.mjs';

const base = ['--project', 'p1', '--path', 'me/proj/plan'];
const item = '052ca3c8-270d-4cd5-b037-871d1bcce7ec';

test('defaults match the idle-only read: 30 minutes, 30 s settle, no Item click', () => {
  assert.deepEqual(idleReadOptions(base), {
    project: 'p1',
    path: 'me/proj/plan',
    minutes: 30,
    settleMs: 30_000,
    item: undefined,
  });
});

test('--item adds the Plan click for one full Item id, and --minutes 0 skips the idle window', () => {
  const got = idleReadOptions([...base, '--item', item.toUpperCase(), '--minutes', '0', '--settle', '12']);
  assert.equal(got.item, item);
  assert.equal(got.minutes, 0);
  assert.equal(got.settleMs, 12_000);
});

test('wrong flags name themselves', () => {
  assert.throws(() => idleReadOptions(['--project', 'p1']), /--project PROJECT_ID and --path/);
  assert.throws(() => idleReadOptions([...base, '--item', '052ca3c8']), /--item must be the full Item id/);
  assert.throws(() => idleReadOptions([...base, '--minutes', '-1']), /--minutes/);
  assert.throws(() => idleReadOptions([...base, '--settle', '0']), /--settle/);
  assert.throws(
    () => idleReadOptions([...base, '--minutes', '0.5', '--item', item]),
    /--minutes with --item/,
  );
});
