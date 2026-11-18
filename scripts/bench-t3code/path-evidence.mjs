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

/** O4: main moved under a running solo check. Retired (switch off): the landing discarded
 * runner time and checked again. Carried (switch on): it landed on its first check across the
 * move, with a cross-head proof and nothing discarded. */
function o4(receipts) {
  const solo = receipts.filter(r => !r.batchId || r.batchSolo);
  const retired = solo.filter(r => runsOf(r).length > 1 && discarded(r) > 0);
  const carried = solo.filter(r => r.mainMoved && r.firstCheck && runsOf(r).length === 1 && !discarded(r));
  return {
    precondition: retired.length + carried.length > 0,
    reached: carried.length > 0,
    evidence:
      retired.length + carried.length
        ? `${retired.length} solo check(s) retired by a main move, ${carried.length} carried across it`
        : 'no solo check met a main move',
  };
}

const RULES = { N1: n1, O3: o3, O4: o4 };

/** Per switch: { on, precondition, reached, label, evidence }. `switches` maps env names to
 * the cell's recorded values. label is null for a switch that is off. */
export function pathEvidence(receipts, switches = {}) {
  return Object.fromEntries(
    Object.entries(PATH_SWITCHES).map(([rule, env]) => {
      const verdict = RULES[rule](receipts);
      const on = switches[env] === true;
      return [
        rule,
        { on, ...verdict, label: on ? (verdict.reached ? 'on path' : 'path not reached') : null },
      ];
    }),
  );
}
