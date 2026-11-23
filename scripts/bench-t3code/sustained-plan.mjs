// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { replayDigest } from './replay-schedule.mjs';

const minute = 60_000;
const fixtureRoot = 'bench-workload';
const pairPath = id => `${fixtureRoot}/pairs/${id}.txt`;
const taskPath = id => `${fixtureRoot}/submissions/${id}.txt`;
const marker = (id, present) => `${id}=${present ? 'on' : 'off'}`;

function pairBytes(pair, present) {
  // Separate the edits so a shared path does not imply a source merge conflict.
  return [
    marker(pair.members[0], present.has(pair.members[0])),
    ...Array.from({ length: 8 }, (_, i) => `unchanged-${i}`),
    marker(pair.members[1], present.has(pair.members[1])),
    '',
  ].join('\n');
}

export function sustainedPlan({ smoke = false, seed = 'forge-sustained-v1' } = {}) {
  const tasks = [];
  const pairs = [];
  for (let block = 0; block < (smoke ? 2 : 10); block++) {
    const ids = [0, 1, 2, 3].map(index => `s${String(block * 4 + index + 1).padStart(2, '0')}`);
    const pair = [0, 3, 6].includes(block) ? { id: `pair-${block + 1}`, members: ids.slice(0, 2) } : null;
    if (pair) {
      // Pin the sampled interaction in the plan, before either arm runs.
      const hash = createHash('sha256')
        .update(JSON.stringify([seed, ...pair.members]))
        .digest();
      pairs.push({ ...pair, jointRed: hash.readUInt32BE() < Math.floor(2 ** 32 / 100) });
    }
    for (const [index, offset] of [0, 45_000, 135_000, 270_000].entries()) {
      const releaseAtMs = block * 6 * minute + offset;
      if (smoke && releaseAtMs >= 10 * minute) break;
      const id = ids[index];
      const edits = [{ path: taskPath(id), text: marker(id, true) + '\n' }];
      if (pair?.members.includes(id))
        edits.push({ path: pairPath(pair.id), text: pairBytes(pair, new Set([id])) });
      tasks.push({ id, releaseAtMs, soloRed: index === 3, edits });
    }
  }
  return {
    schema: 1,
    kind: smoke ? 'sustained-smoke' : 'sustained-hour',
    seed,
    scoredMs: (smoke ? 10 : 60) * minute,
    shardMs: 9 * minute,
    shardCount: 2,
    tasks,
    pairs,
  };
}

/** Exact inventory for a set of contributions. The base has only the inactive pair files. */
export function fixtureFiles(plan, present = new Set()) {
  return new Map([
    ...plan.pairs.map(pair => [pairPath(pair.id), pairBytes(pair, present)]),
    ...plan.tasks
      .filter(task => present.has(task.id))
      .map(task => [taskPath(task.id), marker(task.id, true) + '\n']),
  ]);
}

/** One immutable trace can be replayed against either policy. Preserve partial evidence on abort. */
export async function releaseSustained(
  plan,
  { prepare, submit },
  { signal, now = Date.now, sleep = delay, emit = () => {}, beforeRelease = () => {} } = {},
) {
  plan = structuredClone(plan);
  const prepared = [];
  // Preparation stays off the scored clock and does not compete with runner jobs.
  for (const task of plan.tasks) {
    signal?.throwIfAborted();
    prepared.push(await prepare(task));
  }
  await beforeRelease();
  signal?.throwIfAborted();
  const startedAtMs = now();
  const planDigest = replayDigest(plan);
  emit({ event: 'release-clock', startedAtMs, planDigest });
  const submissions = await Promise.all(
    plan.tasks.map(async (task, i) => {
      try {
        const remaining = startedAtMs + task.releaseAtMs - now();
        if (remaining > 0) await sleep(remaining, undefined, { signal });
        signal?.throwIfAborted();
      } catch (error) {
        if (!signal?.aborted) throw error;
        return { taskId: task.id, outcome: 'not-submitted' };
      }
      const submission = { taskId: task.id, startedAtMs: now() };
      emit({ event: 'submit', ...submission });
      try {
        Object.assign(submission, await submit(task, prepared[i], signal));
      } catch (error) {
        Object.assign(submission, { outcome: 'error', error: String(error.message ?? error) });
      }
      emit({ event: 'submission-result', ...submission });
      return submission;
    }),
  );
  return { startedAtMs, planDigest, submissions };
}
