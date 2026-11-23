// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
const { nextMemberWorkBudget, MEMBER_WORK_BUDGET, STORAGE_QUOTA } = await import(
  moduleUrl('../convex/abuseLimits.ts')
);
const { BOARD_MEMBER_DAY_POSTS } = await import(moduleUrl('../convex/projectBoardLimits.ts'));
const { landingCheckSelection } = await import(moduleUrl('../convex/projectHostedCheckEntries.ts'));
test('work counters read absent legacy fields and fixed-size counters without changing other classes', () => {
  const now = MEMBER_WORK_BUDGET.windowMs + 1;
  let value = nextMemberWorkBudget(undefined, 'checks', now);
  assert.deepEqual(value, { day: MEMBER_WORK_BUDGET.windowMs, checks: 1, composes: 0, submissions: 0 });
  value = nextMemberWorkBudget(value, 'composes', now);
  assert.equal(value.checks, 1);
  assert.equal(value.composes, 1);
  assert.deepEqual(nextMemberWorkBudget(value, 'submissions', now + MEMBER_WORK_BUDGET.windowMs), {
    day: 2 * MEMBER_WORK_BUDGET.windowMs,
    checks: 0,
    composes: 0,
    submissions: 1,
  });
});
test('member work caps follow existing write and storage envelopes, with one UTC retry boundary', () => {
  const cap = Math.min(
    BOARD_MEMBER_DAY_POSTS,
    Math.floor(STORAGE_QUOTA.project.bytes / STORAGE_QUOTA.objectBytes),
  );
  for (const kind of ['checks', 'composes', 'submissions']) {
    assert.equal(MEMBER_WORK_BUDGET[kind], cap);
    const full = { day: 0, checks: cap, composes: cap, submissions: cap };
    assert.throws(
      () => nextMemberWorkBudget(full, kind, 1),
      e => e.code === 'RATE_LIMITED',
    );
    assert.equal(full[kind], cap, 'failed allocation leaves counters unchanged');
  }
});
test('landing check selection prefers verify and accepts a sole differently named check', () => {
  assert.equal(
    landingCheckSelection([
      { id: 'lint', name: 'lint' },
      { id: 'required', name: 'verify' },
    ]),
    'required',
  );
  assert.equal(landingCheckSelection([{ id: 'only', name: 'test' }]), 'only');
  assert.equal(
    landingCheckSelection([
      { id: 'lint', name: 'lint' },
      { id: 'test', name: 'test' },
    ]),
    null,
  );
  assert.equal(landingCheckSelection([]), null);
});
