// SPDX-License-Identifier: Apache-2.0
// Separate diagnostic registration; the frozen scored design remains in plan.mjs.
import { replayPlan, replayDigest } from './replay-schedule.mjs';
export const REPLAY = Object.freeze({
  pairs: 5,
  releases: ['burst', 'late-third'],
  kinds: ['replay-conflict', 'replay-clean'],
});
export function replayBatch(kind, rep, release = 'late-third') {
  if (
    !REPLAY.kinds.includes(kind) ||
    !Number.isInteger(rep) ||
    rep < 1 ||
    rep > REPLAY.pairs ||
    !REPLAY.releases.includes(release)
  )
    throw Error('Unregistered replay diagnostic');
  const plan = replayPlan({ release, independent: kind === 'replay-clean' });
  const key = `${kind}-n10-${release}-r${rep}`;
  return {
    key,
    kind,
    N: 10,
    rep,
    release,
    diagnostic: true,
    mode: 'sequential',
    agentsAtOnce: 0,
    manifest: plan,
    seed: replayDigest(plan),
    order: plan.tasks.map(t => t.id),
    cells: (rep % 2 ? ['github', 'forge'] : ['forge', 'github']).map(arm => ({
      key: `${arm}-${key}`,
      arm,
      kind,
      N: 10,
      rep,
      release,
    })),
  };
}
export function parseReplayKey(key) {
  const m = /^(replay-(?:conflict|clean))-n10(?:-(burst|late-third))?(?:-r(\d+))?$/.exec(String(key));
  return m ? { kind: m[1], release: m[2] ?? 'late-third', rep: m[3] ? Number(m[3]) : null } : null;
}
export function replayBatches(kind, release = 'late-third') {
  return Array.from({ length: REPLAY.pairs }, (_, i) => replayBatch(kind, i + 1, release));
}
