// SPDX-License-Identifier: Apache-2.0
// Did a cell reach the queue path a switch changes (Item 5e3c3a3c)? The role guard
// (scenario-evidence.mjs) proves that each scripted move happened. This proves, from the
// cell's own landing receipts only, that the queue then reached the path the switch changes.
// A switch-on cell whose path was not reached is labelled 'path not reached' and is never
// counted as on-path evidence. Pure: receipts in, verdicts out.
//   precondition: the situation the switch acts on happened (either arm can show it);
//   reached: the switch-on behaviour is visible (only an arm with the switch on can show it).

export const PATH_SWITCHES = Object.freeze({
  N1: 'FORGE_QUEUE_NEW_RUN_WAKE',
  O3: 'FORGE_QUEUE_COHORT_KEEP_HEALTHY',
  O4: 'FORGE_QUEUE_CANCEL_HONOURS_FAST',
});
const ms = at => Date.parse(at ?? '');
const runsOf = r => r.checkRunIds ?? [];
const discarded = r => r.costs?.runnerDiscarded ?? r.runnerDiscarded ?? 0;

/** N1: a passed follower held behind an order holder that was about to land (accepting or
 * unsealed, footprints not overlapping), where that holder then checked again (a second run).
 * Woken: the follower landed before its holder (it overtook the holder's re-check). */
function n1(receipts) {
  const bySubmission = new Map(receipts.map(r => [r.submissionId, r]));
  const parked = receipts.flatMap(r => {
    const wait = (r.orderWaits ?? []).at(-1);
    const holder = wait && bySubmission.get(wait.submissionId);
    if (!r.heldAfterCheck?.length || !holder) return [];
    if (!['accepting', 'unsealed'].includes(wait.held) || wait.footprints === 'overlap') return [];
    if (runsOf(holder).length < 2) return [];
    return [{ follower: r, holder }];
  });
  const woken = parked.filter(({ follower, holder }) => ms(follower.committedAt) < ms(holder.committedAt));
  return {
    precondition: parked.length > 0,
    reached: woken.length > 0,
    evidence: parked.length
      ? `${parked.length} passed follower(s) held behind a re-checking holder, ${woken.length} landed first`
      : 'no passed follower held behind a holder that checked again',
  };
}

/** O3: a shared cohort check failed and a member that passed its own admission check and is
 * not the likely culprit was in it. Kept: that member landed without another check run after
 * the shared one (its admission evidence carried it). */
function o3(receipts) {
  const healthy = receipts.filter(
    r => r.sharedBatch?.runId && r.sharedBatch.likelyCulprit !== true && r.admittedAt,
  );
  const kept = healthy.filter(r => runsOf(r).at(-1) === r.sharedBatch.runId || !runsOf(r).length);
  return {
    precondition: healthy.length > 0,
    reached: kept.length > 0,
    evidence: healthy.length
      ? `${healthy.length} admitted member(s) of a failed shared check, ${kept.length} kept without a new run`
      : 'no admitted member of a failed shared check',
  };
}

/** O4: a landing that this landing's files overlap committed while this landing's queue check
 * was still running, on a check that shares no batch and whose base did not already contain
 * that landing. Without the switch the stale-check sweep retires the run (runner time
 * discarded, another run); with it a run that may carry is kept and the landing lands on it.
 * A landing that landed on its admission run is not a queue check the sweep can retire, and
 * carrying a passed check across a later main move is ordinary reuse, not this path.
 * `cell.files` (own changed paths) and `cell.windows` (check reserved -> CI ended, per
 * attempt) are keyed by Lane and come from the cell's own records (cellLandings). */
function o4(receipts, cell = {}) {
  const files = r => cell.files?.get(r.laneId) ?? new Set();
  const commitOf = new Map(receipts.map(r => [r.receiptId, ms(r.committedAt)]));
  const batchSize = id => receipts.filter(r => r.batchId === id).length;
  const met = receipts.flatMap(r => {
    if ((r.batchId && batchSize(r.batchId) > 1) || r.firstCheck?.landedOn === 'admission-run') return [];
    const mine = files(r);
    const baseAt = commitOf.get(r.admissionBase?.receiptId) ?? -Infinity;
    const retired = runsOf(r).length > 1 && discarded(r) > 0;
    const spans = retired
      ? [[ms(r.firstComposeStartedAt), ms(r.committedAt)]]
      : (cell.windows?.get(r.laneId) ?? []);
    const moved = receipts.filter(q => {
      const at = ms(q.committedAt);
      return (
        q !== r &&
        at > baseAt &&
        [...files(q)].some(path => mine.has(path)) &&
        spans.some(([from, to]) => at > from && at < to)
      );
    });
    if (!moved.length) return [];
    return [{ kept: runsOf(r).length === 1 && !discarded(r) }];
  });
  const kept = met.filter(m => m.kept).length;
  return {
    precondition: met.length > 0,
    reached: kept > 0,
    evidence: met.length
      ? `${met.length} solo queue check(s) met an overlapping landing while running, ${kept} kept`
      : 'no solo queue check met an overlapping landing while running',
  };
}

/** Own changed paths and check windows per Lane, from a cell result: the dry edit, its group
 * file and the scenario role's files; never the paths a Lane synced from main. */
export function cellLandings(
  result,
  { roleOf = () => ({}), groupOf = () => '', testPathOf = () => null } = {},
) {
  const files = new Map(),
    windows = new Map();
  for (const record of result.records ?? []) {
    if (!record.laneId) continue;
    const index = (result.order ?? []).indexOf(record.task);
    const role = roleOf(index) ?? {};
    const group = role.group ?? groupOf(record);
    const own = new Set([`.bench/dry/${record.task}.md`]);
    if (group) own.add(`.bench/dry/group-${group}.md`);
    if (role.doc?.path) own.add(role.doc.path);
    if ((role.failOnce || role.slowSeconds) && testPathOf(record.task)) own.add(testPathOf(record.task));
    files.set(record.laneId, own);
    windows.set(
      record.laneId,
      (record.landing?.operations ?? []).flatMap(operation => {
        const t = operation.timing ?? {};
        const from = ms(t.checkReservedAt),
          to = ms(t.ciEndedAt ?? t.committedAt);
        return from && to ? [[from, to]] : [];
      }),
    );
  }
  return { files, windows };
}

const RULES = { N1: n1, O3: o3, O4: o4 };

/** Per switch: { on, precondition, reached, label, evidence }. `switches` maps env names to
 * the cell's recorded values; `cell` is cellLandings(result) (O4 needs it). label is null for
 * a switch that is off. */
export function pathEvidence(receipts, switches = {}, cell = {}) {
  return Object.fromEntries(
    Object.entries(PATH_SWITCHES).map(([rule, env]) => {
      const verdict = RULES[rule](receipts, cell);
      const on = switches[env] === true;
      return [
        rule,
        { on, ...verdict, label: on ? (verdict.reached ? 'on path' : 'path not reached') : null },
      ];
    }),
  );
}
