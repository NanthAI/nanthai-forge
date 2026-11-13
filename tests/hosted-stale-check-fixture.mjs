// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { assertLandingProgress } from './landing-progress-invariant.mjs';
import { states, batchesFixture } from './hosted-landing-batches-fixture.mjs';
export const current = (f, index) => states(f).find(s => s.id === f.entries[index].state.id);
export const requestRow = (f, index) =>
  [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === current(f, index).id);
export const finishRow = (f, index) =>
  [...f.tables.projectHostedFinishes.values()].find(r => r.submissionId === current(f, index).id);
export const pendingTasks = f =>
  f.pending().filter(task => !task.name.startsWith('projectHostedLandingStall:'));
export async function drain(f, stop = () => false) {
  for (let step = 0; ; step++) {
    const task = pendingTasks(f)[0];
    if (!task || stop(task)) return;
    assert(step < 1000, JSON.stringify(states(f)));
    await f.execute(task);
    assertProgressOwners(f);
  }
}
export async function fixture(t, { conflict = true, memberPaths, count = 2, runner, ...options } = {}) {
  const f = await batchesFixture(t, {
    count: 0,
    fileCount: 2,
    admissionCheck: 'full',
    batchMaxSize: 3,
    baselineFiles: [['src/shared.ts', 'a\nb\nc\n']],
    memberPaths: memberPaths ?? ['src/shared.ts', 'src/shared.ts', 'src/other.ts'],
    memberContents: ['A\nb\nc\n', conflict ? 'B\nb\nc\n' : 'a\nb\nC\n', 'other\n'],
    ...(runner ? { runner } : {}),
    ...options,
  });
  f.rawChecks.setPlanSelection(JSON.stringify({ scope: 'full', tests: [] }));
  for (let i = 0; i < count; i++) await f.add(i);
  await drain(f);
  return f;
}
/** The fixture driver owns completion of these exact fake-provider runs. */
export function assertProgressOwners(f) {
  assertLandingProgress(f, {
    externalRuns: new Set(
      f
        .runs()
        .filter(run => ['queued', 'running'].includes(run.status))
        .map(run => run.id),
    ),
  });
}
export async function settle(f) {
  for (let wave = 0; states(f).some(s => s.observation.state === 'pending'); wave++) {
    assert(wave < 20, JSON.stringify(states(f)));
    for (const run of f.runs().filter(r => ['queued', 'running'].includes(r.status)))
      await f.rawChecks.pass(run.status === 'queued' ? await f.rawChecks.activate(run.id) : run);
    await drain(f);
    assertProgressOwners(f);
  }
}
