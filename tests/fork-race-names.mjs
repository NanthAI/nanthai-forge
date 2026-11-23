// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item c3c69c57 re-check gap (lead read 2026-11-20): 39 main-race waste rows, 2,343 of 8,804
// runner-min, had no reason. `metrics` counts a main race whenever a child attempt pins another
// main than its parent, so every writer that forks a checked parent onto a moved main names why.
import assert from 'node:assert/strict';

const attempts = f => [...f.tables.projectHostedLandingAttempts.values()].map(row => JSON.parse(row.value));

/** Child attempts on another main than their checked parent that carry no reason, no carried proof
 * and do not adopt the parent's run: the rows with runner minutes `metrics` would leave unnamed. */
export function unnamedForkRaces(f) {
  const all = attempts(f);
  const byId = new Map(all.map(attempt => [attempt.id, attempt]));
  return all.filter(child => {
    const parent = child.parentAttemptId ? byId.get(child.parentAttemptId) : undefined;
    return (
      parent?.check &&
      parent.main.head !== child.main.head &&
      !child.recheckReason &&
      !child.forkReason &&
      !child.crossHeadProof &&
      child.check?.runId !== parent.check.runId
    );
  });
}

/** Asserts the scenario named every race, forked onto a moved main as `reason` at least once (when
 * given), and that a fork's metrics-only name never unsealed landing order (review 85fb41bc). */
export function assertForkRacesNamed(f, reason) {
  assert.deepEqual(
    unnamedForkRaces(f).map(attempt => attempt.id),
    [],
    'every attempt forked onto a moved main names its reason',
  );
  const all = attempts(f);
  if (reason)
    assert.ok(
      all.some(attempt => attempt.forkReason === reason),
      `the scenario forks onto a moved main as ${reason}`,
    );
  const rechecked = new Set(all.filter(a => a.recheckReason || a.recheck).map(a => a.submissionId));
  for (const row of f.tables.projectHostedLandingRequests.values())
    if (!rechecked.has(row.submissionId))
      assert.equal(row.unsealed, undefined, 'a fork reason alone never unseals landing order');
}
