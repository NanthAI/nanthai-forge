// SPDX-License-Identifier: Apache-2.0
// Core-claim incident 43b51a5e, 2026-11-19 17:54-18:24Z: a reservation cycle. Shared by the replay
// (tests/hosted-landing-reservation-cycle.test.mjs) and the queue simulation (Guard 2).
import { drive } from './overtake-drive.mjs';

/** Three lines one landing each edits: W the first, X the second, H the third. */
export const cycleBase = 'export const w = 0;\n// gap\nexport const x = 0;\n// gap\nexport const h = 0;\n';
const edit = (from, to) => cycleBase.replace(from, to);
export const LANE = 150,
  FOLLOWERS = 4;

/** The live shape. W (older, Ready) changes files that H's reservation holds, so it parks on H while
 * H checks. X (between them; it changes only a CI workflow, its own global risk) parks on W. H (the
 * holder, newest of the three) passes and finds X older and live: before the fix it parked on X,
 * and the three waited for each other until the reservation ended, with four passed disjoint
 * followers behind them. Variants: `spent` (X's bounded risk-only step is already used, so only the
 * chain rule can release H) and `overlap` (W and H change the database schema, so H's own global risk
 * links it to X: H may not go ahead of X, and its reservation ends instead). */
export async function reservationCycle(t, { variant = 'live', afterStep } = {}) {
  let until = Infinity,
    expired = false;
  const file = variant === 'overlap' ? 'convex/schema.ts' : 'src/shared.ts';
  const result = await drive(t, {
    memberPaths: [
      file,
      '.github/workflows/contracts-nightly.yml',
      file,
      ...Array.from({ length: FOLLOWERS }, (_, i) => `src/f${i}.ts`),
    ],
    baselineFiles: [[file, cycleBase]],
    memberContents: [edit('w = 0', 'w = 1'), 'name: nightly\n', edit('h = 0', 'h = 1')],
    ownerApprovalPaths: ['scripts/deploy*'],
    fixture: { admissionCheck: false, requestCheck: true, batching: false },
    duration: (i, nth) => (nth > 1 ? LANE : LANE + i),
    prepare(f, ids) {
      const rows = [...f.tables.projectHostedLandingRequests.values()];
      const row = id => rows.find(r => r.submissionId === id);
      const project = f.tables.hostedProjects.get(f.projectId);
      // The dogfood check runs from a GitHub workflow, so any workflow change is CI configuration.
      f.patch('hostedProjects', f.projectId, {
        checkEntries: [...project.checkEntries, '.github/workflows/forge-check.yml'],
      });
      until = Date.now() + 30 * 60_000;
      f.patch('projectHostedLandingRequests', row(ids[2])._id, { reservedUntil: until });
      if (variant === 'spent')
        f.patch('projectHostedLandingRequests', row(ids[1])._id, { overtaken: 'earlier:generation' });
    },
    // The fixture runs a future task at its own time: one at or past the reservation end means a
    // landing waited for the time bound (the deadlock), not for an event.
    afterStep: async (f, tick, task) => {
      if (task.scheduledTime >= until) expired = true;
      await afterStep?.(f, tick, task);
    },
  });
  return { ...result, expired };
}

const requestRow = (f, id) =>
  [...f.tables.projectHostedLandingRequests.values()].find(r => r.submissionId === id);
const strict = (f, id) =>
  f.patch('projectHostedLandingRequests', requestRow(f, id)._id, {
    overtaken: 'earlier:generation',
    unsealed: 'not-eligible',
  });
const PARKED = 8;

/** Review 120fcc09 finding 1: the chain walk's read budget. W changes H's file and the files of
 * PARKED older-than-X entries P1..P8, which park on W (each could never land before H, and each is
 * disjoint and sealed, so H skips it anyway). X (strict order: its pass cannot carry) changes another
 * of W's files and parks on W. Before the fix the walk ran for every parked older entry and the
 * P entries spent the claim's 8 reads, so H parked on X: a cycle until the reservation ended. The
 * walk now runs only for the entry H would wait on (X), with the whole budget. */
export async function reservationBudget(t, { afterStep } = {}) {
  let until = Infinity,
    expired = false;
  const parked = Array.from({ length: PARKED }, (_, i) => `src/p${i}.ts`);
  const result = await drive(t, {
    memberPaths: [['src/shared.ts', 'src/wx.ts', ...parked], ...parked, 'src/wx.ts', 'src/shared.ts'],
    baselineFiles: ['src/shared.ts', 'src/wx.ts', ...parked].map(path => [path, cycleBase]),
    memberContents: [
      edit('w = 0', 'w = 1'),
      ...parked.map(() => edit('x = 0', 'x = 1')),
      edit('x = 0', 'x = 1'),
      edit('h = 0', 'h = 1'),
    ],
    ownerApprovalPaths: ['scripts/deploy*'],
    fixture: { admissionCheck: false, requestCheck: true, batching: false },
    duration: (i, nth) => (nth > 1 ? LANE : i === PARKED + 2 ? LANE + 40 : LANE + i),
    prepare(f, ids) {
      until = Date.now() + 30 * 60_000;
      f.patch('projectHostedLandingRequests', requestRow(f, ids.at(-1))._id, { reservedUntil: until });
      strict(f, ids.at(-2));
    },
    afterStep: async (f, tick, task) => {
      if (task.scheduledTime >= until) expired = true;
      await afterStep?.(f, tick, task);
    },
  });
  return { ...result, expired };
}

/** Review 120fcc09 finding 2: a handed link in the chain. E (strict, slow) is the head; X (changes
 * R's file) and H (strict order, another file) park on it. R checks; its reservation starts once E
 * lands. E's exit wake drives X and hands H to X (`orderWaitHanded`). X claims while R is Ready and
 * not yet parked, so X parks on R's reservation with no baton; then R claims and meets H, older and
 * strict. H's only wait is the handed link to X. Before the fix the walk stopped at that link, R
 * parked on H, and nothing drove H until the reservation ended. `pick` holds X's claim until R is
 * Ready, and R's until X has parked on it (one real interleaving of their wakes). */
export async function reservationHanded(t, { afterStep } = {}) {
  let until = Infinity,
    expired = false,
    ids = [];
  let f0;
  const SLOW = 1000;
  const taskOf = (task, id) => task.args?.[0]?.submissionId === id;
  const result = await drive(t, {
    memberPaths: ['src/e.ts', 'src/shared.ts', 'src/h.ts', 'src/shared.ts'],
    baselineFiles: [['src/shared.ts', cycleBase]],
    memberContents: [, edit('w = 0', 'w = 1'), , edit('h = 0', 'h = 1')],
    ownerApprovalPaths: ['scripts/deploy*'],
    fixture: { admissionCheck: false, requestCheck: true, batching: false },
    duration: (i, nth) => (nth > 1 ? LANE : i === 0 ? SLOW : i === 3 ? SLOW + 60 : LANE + i),
    prepare(f, all) {
      f0 = f;
      ids = all;
      strict(f, ids[0]);
      strict(f, ids[2]);
    },
    pick(tasks) {
      const [, x, , r] = ids;
      if (until === Infinity || ['landed', 'terminal-failed'].includes(requestRow(f0, r).phase))
        return tasks[0];
      const ok = task =>
        !(taskOf(task, x) && requestRow(f0, r).phase !== 'ready') &&
        !(taskOf(task, r) && requestRow(f0, x).phase === 'ready' && requestRow(f0, x).orderWait !== r);
      return tasks.find(ok) ?? null;
    },
    afterStep: async (f, tick, task) => {
      // R was submitted after X and H parked: its reservation starts when E lands.
      if (until === Infinity && requestRow(f, ids[0]).phase === 'landed') {
        until = Date.now() + 30 * 60_000;
        f.patch('projectHostedLandingRequests', requestRow(f, ids[3])._id, { reservedUntil: until });
      }
      if (task.scheduledTime >= until) expired = true;
      await afterStep?.(f, tick, task);
    },
  });
  return { ...result, expired };
}
