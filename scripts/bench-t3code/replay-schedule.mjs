// SPDX-License-Identifier: Apache-2.0
// Deterministic N=10 diagnostic core; replay-cells registers the real-service cells.
// Real-service adapters must retain their ordinary exact-source/check/retry protocols.
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** Public synthetic edits only. No workload source, wall-clock timestamp or live id. */
export function replayPlan({ release = 'burst', independent = false } = {}) {
  if (!['burst', 'late-third'].includes(release)) throw Error('Unknown diagnostic release schedule');
  const groups = [null, null, null, 'pair-a', 'pair-a', 'pair-b', 'pair-b', 'triple', 'triple', 'triple'];
  return {
    schema: 1,
    kind: 'synthetic-n10',
    release,
    independent,
    receiptGates:
      release === 'late-third' && !independent
        ? [
            { task: 's10', before: 'initial-land', after: 's08-accepted' },
            { task: 's09', before: 'initial-land', after: 's10-first-conflict-materialized' },
            { task: 's10', before: 'first-retry', after: 's09-accepted' },
          ]
        : [],
    tasks: groups.map((group, index) => {
      const id = `s${String(index + 1).padStart(2, '0')}`;
      return {
        id,
        releaseAtMs: release === 'late-third' && index === 9 ? 200_000 : 0,
        edits: [
          { path: `.bench/replay/unique-${id}.txt`, text: `${id}\n` },
          ...(group && !independent ? [{ path: `.bench/replay/group-${group}.txt`, text: `${id}\n` }] : []),
        ],
      };
    }),
  };
}

export const replayDigest = plan => createHash('sha256').update(JSON.stringify(plan)).digest('hex');

/** Exact accepted bytes expected after set-union recovery of synthetic contributions. */
export function replayExpected(plan) {
  const lines = new Map();
  for (const task of plan.tasks)
    for (const { path, text } of task.edits) {
      const values = lines.get(path) ?? new Set();
      for (const line of text.split('\n').filter(Boolean)) values.add(line);
      lines.set(path, values);
    }
  return new Map([...lines].map(([path, values]) => [path, [...values].sort().join('\n') + '\n']));
}

/**
 * Adapter contract:
 * prepare(task) -> pinned workspace context, without submitting work;
 * stage(task, context) -> write the task's exact synthetic edits;
 * land(task, context) -> {landed:true, ...receipt}, after all real recovery/checks;
 * readMain(paths) -> {head, files: Map<path, exact accepted UTF-8 bytes>}.
 *
 * No services, workspaces or background process are created by importing this module.
 * The adapter owns service costs, argv, operation identities and recovery evidence.
 */
export async function replaySchedule(
  plan,
  adapter,
  { now = () => performance.now(), sleep = ms => delay(ms), emit = () => {} } = {},
) {
  if (
    plan.schema !== 1 ||
    plan.tasks.length !== 10 ||
    new Set(plan.tasks.map(t => t.id)).size !== 10 ||
    plan.tasks.some(t => !Number.isFinite(t.releaseAtMs) || t.releaseAtMs < 0)
  )
    throw Error('A diagnostic plan needs ten distinct tasks with finite relative release times');
  // Snapshot before awaits: a caller cannot change edits or timing during preparation.
  plan = structuredClone(plan);
  const digest = replayDigest(plan);
  const expected = replayExpected(plan);
  const prepStart = now();
  const events = [];
  let epoch = prepStart;
  const record = (event, task, extra = {}) => {
    const value = { event, task, atMs: now() - epoch, ...extra };
    events.push(value);
    emit(value);
  };
  const prepared = await Promise.allSettled(
    plan.tasks.map(async task => {
      const context = await adapter.prepare(task);
      await adapter.stage(task, context);
      return context;
    }),
  );
  const prepFailures = prepared.filter(r => r.status === 'rejected');
  if (prepFailures.length)
    throw new AggregateError(
      prepFailures.map(r => r.reason),
      'Diagnostic preparation failed; nothing submitted',
    );
  const prepMs = now() - prepStart;
  epoch = now();
  record('release-clock', null, { planDigest: digest });
  const attempts = await Promise.allSettled(
    plan.tasks.map(async (task, index) => {
      const remaining = task.releaseAtMs - (now() - epoch);
      if (remaining > 0) await sleep(remaining);
      record('submit', task.id, { releaseAtMs: task.releaseAtMs, slipMs: now() - epoch - task.releaseAtMs });
      try {
        const receipt = await adapter.land(task, prepared[index].value);
        if (receipt?.landed !== true) throw Error(`No accepted landing for ${task.id}`);
        record('accepted', task.id);
        return { task: task.id, receipt };
      } catch (error) {
        record('failed', task.id, { error: String(error.message ?? error) });
        throw error;
      }
    }),
  );
  // Never return while an already-started landing is still running, even on failure.
  const failures = attempts.filter(r => r.status === 'rejected');
  if (failures.length)
    throw new AggregateError(
      failures.map(r => r.reason),
      'Diagnostic landing failed',
    );
  const mismatches = [];
  // One batched exact-head read; adapters page metadata and bytes, never query per file.
  const source = await adapter.readMain([...expected.keys()]);
  if (!source?.head || !(source.files instanceof Map))
    throw Error('Final source read needs one exact head and its files');
  for (const [path, text] of expected) {
    const actual = source.files.get(path);
    if (actual !== text) mismatches.push(path);
  }
  if (mismatches.length)
    throw Error(`Accepted source lost or changed synthetic contributions: ${mismatches.join(', ')}`);
  record('verified', null, { paths: expected.size });
  return {
    kind: 'synthetic-diagnostic',
    scored: false,
    verifiedHead: source.head,
    planDigest: digest,
    prepMs,
    elapsedMs: now() - epoch,
    modelTokens: 0,
    results: attempts.map(r => r.value),
    events,
  };
}
