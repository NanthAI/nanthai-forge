// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { LandingChannel, LandingRow } from './projectHostedLandingStore';
import type { HostedLandingState } from '../src/hosted-landing';
import { orderWaitsField } from '../src/hosted-acceptance';
import { orderLandingEntries } from '../src/landing-batch-order';
import { storedLandingStateSchema } from '../src/hosted-landing';
import type { Doc } from './_generated/dataModel';
import { effectivePolicy } from '../src/autonomy-policy';
import { hostedLandingProgressAt, retainedStallOwner } from '../src/hosted-landing-stall';
import { HOSTED_TRAIN_HOLD_MS } from '../src/hosted-landing-batch';
import { stackedBehind } from './projectHostedLandingSuffix';
import { batchRow, batchSchema } from './projectHostedLandingBatchState';
import {
  generationStartedAfterPass,
  olderRiskOnly,
  overtakeMark,
  overtakeOlder,
  overtakeRiskOnly,
  orderProofsEnabled,
  ownGlobalRisk,
  sealedOlder,
  unrelatedChanges,
  waitFootprints,
} from '../src/landing-overtake';
import { landingChangedPaths, overtakingSide } from './projectHostedLandingOvertake';
import { landingSuspect } from '../src/hosted-landing-suspect';
import { effectiveAgentDefaults, urgentAllowed, urgentRefusal } from '../src/agent-parallel-defaults';
import { HOSTED_RESERVATION_MS } from '../src/landing-reservation';
import {
  heldBackByReservation,
  RESERVATION_CHAIN_READS,
  waitsOnReservation,
} from './projectHostedLandingReservation';

/** Queue jumping: the project owner only, further limited by agentDefaults.urgentRoles. */
export function landingPriority(
  project: Pick<Doc<'hostedProjects'>, 'owner' | 'autonomyPolicy'>,
  actor: { id: string; kind: 'agent' | 'person' },
  requested?: 'urgent' | 'normal',
) {
  if (requested !== 'urgent')
    return {
      priority: 'normal' as const,
      priorityReason: 'Normal arrival order with fairness within the priority class.',
    };
  const defaults = effectiveAgentDefaults(effectivePolicy(project).agentDefaults);
  if (project.owner !== actor.id)
    return {
      priority: 'normal' as const,
      priorityReason:
        'Normal: only the project owner or an agent acting for the owner may jump the landing queue.',
    };
  return urgentAllowed(defaults, { owner: project.owner, actor })
    ? {
        priority: 'urgent' as const,
        priorityReason: 'Urgent requested by the project owner or an agent acting for the owner.',
      }
    : { priority: 'normal' as const, priorityReason: `Normal: ${urgentRefusal(defaults)}` };
}
export function landingPriorityState(row: LandingRow, state: HostedLandingState): HostedLandingState {
  return {
    ...state,
    priority: row.priority ?? 'normal',
    priorityReason: row.priorityReason ?? 'Normal arrival order with fairness within the priority class.',
    priorityVersion: row.priorityVersion ?? 0,
  };
}
export function orderHostedLandingRows<T extends Pick<LandingRow, 'sequence' | 'actor' | 'priority'>>(
  rows: T[],
) {
  return orderLandingEntries(
    rows.map(row => ({
      ...row,
      priority: row.priority ?? 'normal',
      submitter: row.actor,
      arrivedAt: String(row.sequence).padStart(20, '0'),
    })),
  );
}
/** Merge-queue order (core-claim incident e4aee4fe, 2026-11-01): a slow older
 * entry re-checked 6+ times in an hour because fast newer passes kept taking main.
 * An entry holds its place while it is still live; one that failed, stalled, is
 * held for red main, is a named suspect of a combined failure or waits for review
 * or a dependency gives its place up. */
export function holdsLandingOrder(
  row: Pick<LandingRow, 'phase' | 'hold'>,
  state: HostedLandingState,
  now = Date.now(),
) {
  // A direct request has no finish controller to take main. Unchecked requests give up
  // order immediately; checked manual acceptance has one minute to use its prepared head.
  if (
    row.phase === 'ready' &&
    !state.request.finish &&
    (!state.request.check || now >= Date.parse(state.timing?.settlementStartedAt ?? state.at) + 60_000)
  )
    return false;
  return (
    (row.phase === 'queued' || row.phase === 'checking' || row.phase === 'ready') &&
    !row.hold &&
    // Wave 1 (51bbbd00): a passed entry waited an hour behind a failing one.
    // A suspect named by combined-failure evidence gives up its place until its
    // own check passes; it can still land, only later entries no longer wait.
    !landingSuspect(state) &&
    !state.error &&
    (!state.observation.stall ||
      Boolean(
        retainedStallOwner(state.observation.stall) &&
        state.observation.stall.lastProgressAt !== hostedLandingProgressAt(state),
      )) &&
    state.observation.state === 'pending' &&
    state.observation.pendingReason !== 'waiting-for-review' &&
    state.observation.pendingReason !== 'waiting-for-dependency'
  );
}
/** Why an older entry holds a passed newer one (receipt `orderWaits`, Issue c6b81429). */
export type OrderHeld =
  | 'dependent'
  | 'unknown-paths'
  // The older entry passed and is taking main: acceptance is one at a time, not an order hold.
  | 'accepting'
  | 'urgent'
  | 'overtaken'
  | 'unsealed'
  | 'no-proof'
  | 'combined'
  | 'composing'
  // A later landing of reserved files waits for the holder (Issue 10d253c6).
  | 'reserved';
const generationStartedAt = (state: HostedLandingState) =>
  Math.max(
    Date.parse(state.at),
    Date.parse(state.timing?.composeStartedAt ?? state.at),
    Date.parse(state.timing?.selectedAt ?? state.at),
  );

/** The oldest submission that must take main before this one, or null. One
 * indexed window per accept attempt. Urgent entries wait only for older urgent
 * ones; batch members never wait for their own batch. A passed solo entry never
 * waits for an older one it is independent of while that one's pass can carry
 * across a moved main (graph-sealed, `sealedOlder`, Issue c6b81429); otherwise it
 * takes main ahead of an unrelated one that has not given up its place yet
 * (`overtakeOlder`, Issue 7d98c7da) and entries it overtakes at a cost are pushed
 * to `spent` for the caller to mark when it takes main; so is an older entry linked only by its own
 * global risk (`olderRiskOnly`, Issue 43b51a5e), a Ready one parked behind an older submission
 * included (`overtakeRiskOnly`). A combined group keeps strict order. With reuse,
 * one-member groups can overtake outside their exact predecessor, and a spent
 * holder cannot keep an unrelated pass behind a generation started after it passed.
 * A queued entry no dispatcher owns (its compose
 * or cohort still preparing) holds its place for the train hold only, as the
 * train does: a dead compose never stops the queue. `until` names the one wake
 * the waiter needs when that hold ends; `held` and `footprints` say why it waits
 * (footprints are read for a new wait only, so a re-check of the same wait reads nothing). */
export async function olderLandingAhead(
  ctx: QueryCtx | MutationCtx,
  row: LandingRow,
  state: HostedLandingState,
  now = Date.now(),
  spent?: LandingRow[],
) {
  let project: Doc<'hostedProjects'> | null | undefined;
  const getProject = async () =>
    project === undefined ? (project = await ctx.db.get(row.projectId)) : project;
  const reuseOn = async () => {
    const current = await getProject();
    return current?.checkEntries && orderProofsEnabled(effectivePolicy(current).acceptance);
  };
  let mine: Awaited<ReturnType<typeof overtakingSide>> | undefined;
  const side = async () =>
    mine === undefined ? (mine = await overtakingSide(ctx, row, state, await getProject())) : mine;
  const batchRecord = state.batchId
    ? await batchRow(ctx, { projectId: row.projectId, batchId: state.batchId })
    : null;
  const batch = batchRecord ? batchSchema.parse(JSON.parse(batchRecord.value)) : null;
  const predecessor = batch?.predecessor;
  const solo = !state.batchId || Boolean(state.batchSolo);
  const singleton = Boolean(spent) && (solo || batch?.members.length === 1);
  const legacyOvertake = Boolean(spent) && solo && !predecessor;
  const chain = { reads: RESERVATION_CHAIN_READS };
  const reservationLive = row.reservedUntil !== undefined && row.reservedUntil > now;
  // An exact successor must wait for the predicted tree, even when a different
  // older entry is independent. A full admission can be outside the order index.
  if (predecessor) {
    const ahead = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_submission', q =>
        q.eq('projectId', row.projectId).eq('submissionId', predecessor.submissionId),
      )
      .unique();
    if (ahead && holdsLandingOrder(ahead, storedLandingStateSchema.parse(JSON.parse(ahead.value)), now)) {
      const wait = { row: ahead, until: null, held: 'combined' as const, footprints: 'unknown' as const };
      if (ahead.admitting && ahead.admission?.full) return wait;
      if (singleton && (await reuseOn()) && (await side())?.proofs) {
        if (reservationLive && ahead.orderWait && (await waitsOnReservation(ctx, row, ahead, chain)))
          return { ...wait, cycle: true };
        return wait;
      }
    }
  }
  let reserved: string[] | null | undefined;
  const holder = {
    row,
    state,
    paths: async () =>
      reserved === undefined ? (reserved = await landingChangedPaths(ctx, row, state)) : reserved,
  };
  const older = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_orderLive_and_sequence', q =>
      q
        .eq('projectId', row.projectId)
        .eq('channel', row.channel)
        .eq('orderLive', true)
        .lt('sequence', row.sequence),
    )
    .order('asc')
    .take(16);
  for (const other of older) {
    if (row.priority === 'urgent' && other.priority !== 'urgent') continue;
    const value = storedLandingStateSchema.parse(JSON.parse(other.value));
    if (state.batchId && value.batchId === state.batchId) continue;
    if (!holdsLandingOrder(other, value, now)) continue;
    // A live reservation holder goes ahead of an older entry it holds back (10d253c6).
    if (row.reservedUntil !== undefined && (await heldBackByReservation(ctx, holder, other, value, now)))
      continue;
    // The older entry's changed paths: one Candidate read at most, shared by every rule below.
    let theirs: string[] | null | undefined;
    const pathsOf = async () =>
      theirs === undefined ? (theirs = await landingChangedPaths(ctx, other, value)) : theirs;
    let cycle = false;
    // Only an entry that entered the queue late (pre-queue Lane check, refused proof)
    // can be stacked behind a younger group; others cost no extra read.
    if (other.admission?.full && (await stackedBehind(ctx, row, state, value))) continue;
    let held: OrderHeld = 'combined';
    let independent: boolean | null | undefined;
    let footprints: 'overlap' | 'disjoint' | 'unknown' | undefined;
    if (legacyOvertake || (singleton && (await reuseOn()) && (await side())?.proofs)) {
      const generation = {
        phase: other.phase as 'queued' | 'checking' | 'ready',
        priority: other.priority,
        attemptId: other.attemptId,
        runId: other.runId,
        admitted: Boolean(
          other.admission?.full && other.admission.status === 'passed' && !other.admission.reuse,
        ),
        ...(other.overtaken !== undefined ? { overtaken: other.overtaken } : {}),
      };
      const overtake = overtakeOlder(generation);
      // Taken only when the older entry's own global risk is the sole link (43b51a5e).
      const riskStep = overtakeRiskOnly({ ...generation, parked: Boolean(other.orderWait) });
      const target = {
        phase: other.phase as 'queued' | 'checking' | 'ready',
        priority: other.priority,
        parked: Boolean(other.orderWait),
        // A combined group's pass never carries across heads (one shared exact recheck).
        combined: Boolean(value.batchId && !value.batchSolo),
        ...(other.unsealed !== undefined ? { unsealed: other.unsealed } : {}),
      };
      // A solo re-pin retires the checked Candidate before it binds a replacement.
      // Its stored Ready phase still describes the retired generation.
      const repinning =
        !value.batchId &&
        other.pipelineRetiredAttemptId === other.attemptId &&
        value.timing?.composeStartedAt !== undefined;
      const passAge =
        riskStep === 'hold' &&
        generation.overtaken !== undefined &&
        generation.priority !== 'urgent' &&
        (generation.phase !== 'ready' || target.parked || repinning) &&
        generationStartedAfterPass(row.passedAt, generationStartedAt(value));
      const soloHolder = async () => {
        if (!target.combined || !value.batchId) return true;
        const record = await batchRow(ctx, { projectId: row.projectId, batchId: value.batchId });
        return record !== null && batchSchema.parse(JSON.parse(record.value)).members.length === 1;
      };
      const comparePaths =
        overtake !== 'hold' || riskStep !== 'hold' || sealedOlder({ ...target, proofs: true });
      // Paths are read only for an entry a rule could skip: one Candidate read each.
      if (comparePaths) {
        const me = await side();
        const paths = me ? await pathsOf() : null;
        independent = me ? unrelatedChanges(me.paths, paths, me.checkEntries) : null;
        const riskOnly = Boolean(me && !independent && olderRiskOnly(me.paths, paths, me.checkEntries));
        footprints = me ? (independent || riskOnly ? 'disjoint' : 'overlap') : 'unknown';
        if (independent && me && sealedOlder({ ...target, proofs: me.proofs })) continue;
        // Its own global risk alone (43b51a5e) also takes the bounded step, never the sealed one,
        // and from a Ready entry that is itself parked (case 2) as from a checking one.
        const parkedStep =
          independent && me?.proofs && target.parked && riskStep !== overtake && (await soloHolder());
        const step = independent ? (parkedStep ? riskStep : overtake) : riskOnly ? riskStep : 'hold';
        if (step !== 'hold' && (legacyOvertake || (await soloHolder()))) {
          if (step === 'spend') spent!.push(other);
          continue;
        }
        if (passAge && me?.proofs && (independent || riskOnly) && (await soloHolder())) continue;
        // A risk-only link is no dependency: the receipt says the bounded step is spent (or the
        // entry is urgent, or Ready and about to land).
        if (legacyOvertake)
          held = riskOnly
            ? other.priority === 'urgent'
              ? 'urgent'
              : other.phase === 'ready' && !other.orderWait
                ? 'accepting'
                : 'overtaken'
            : independent === null
              ? 'unknown-paths'
              : !independent
                ? 'dependent'
                : me && !me.proofs
                  ? 'no-proof'
                  : 'unsealed';
      } else {
        if (passAge && (await reuseOn())) {
          const me = await side();
          if (
            me?.proofs &&
            waitFootprints(me.paths, await pathsOf(), me.checkEntries) === 'disjoint' &&
            (await soloHolder())
          )
            continue;
        }
        // Not Ready and not urgent, yet the bounded step holds: it was spent for an earlier
        // generation (`overtaken`), whether or not its pass could carry (43b51a5e, review 8c3f272f).
        if (legacyOvertake)
          held = other.priority === 'urgent' ? 'urgent' : other.phase === 'ready' ? 'accepting' : 'overtaken';
      }
    }
    const wait = async () => ({
      row: other,
      state: value,
      held,
      ...(cycle ? { cycle } : {}),
      // The receipt says whether the two footprints overlapped; read once, for a new wait.
      footprints:
        footprints ??
        (independent === undefined && row.orderWait !== other.submissionId && spent
          ? await footprintsOf(pathsOf, side)
          : footprintLabel(independent)),
    });
    let until: number | null = null;
    let composing = false;
    if (other.phase === 'ready' && !value.request.finish)
      until = Date.parse(value.timing?.settlementStartedAt ?? value.at) + 60_000;
    else if (other.phase === 'queued' && !other.runnable) {
      until = generationStartedAt(value) + HOSTED_TRAIN_HOLD_MS;
      if (until <= now) continue;
      composing = true;
    }
    // This is the entry the holder would wait on. A live reservation holder never parks on one
    // whose chain of waits leads back to a waiter on its reservation (43b51a5e case 3): it cannot
    // take main first. A solo holder that may overtake goes ahead of it when their footprints are
    // disjoint; otherwise (an overlap, a combined group, a pipelined successor) its reservation is
    // void and the claim ends it (`cycle`). The walk runs here only, so skipped entries spend none
    // of its read budget.
    if (reservationLive && other.orderWait && (await waitsOnReservation(ctx, row, other, chain))) {
      const me = legacyOvertake ? await side() : null;
      if (me && waitFootprints(me.paths, await pathsOf(), me.checkEntries) === 'disjoint') continue;
      cycle = true;
    }
    // Its own global risk, from the paths this claim already read (none read for it).
    const ahead = {
      ...(await wait()),
      until,
      ownRisk: Boolean(mine && ownGlobalRisk(mine.paths, mine.checkEntries)),
    };
    return composing ? { ...ahead, held: 'composing' as OrderHeld } : ahead;
  }
  return null;
}
/** Order waits a receipt records; later ones are dropped (the first ones explain the wait). */
export const HOSTED_ORDER_WAITS = 8;
type ReleaseCause =
  | 'claim'
  | 'holder-landed'
  | 'holder-exit'
  | 'baton-park'
  | 'baton-repin'
  | 'baton-stale'
  | 'waiter-exit'
  | 'new-run';
type WaitHistory = Pick<LandingRow, 'orderWait' | 'orderWaits' | 'orderHandoffs'>;
type HolderEvidence = Pick<LandingRow, 'phase' | 'attemptId' | 'runId' | 'proofMainReceiptId' | 'unsealed'>;

type HolderDetails = {
  holderPhase: LandingRow['phase'];
  generation: string;
  baseStale?: boolean;
  unsealed?: string;
};
function holderEvidence(holder: HolderEvidence, mainReceiptId?: string): HolderDetails;
function holderEvidence(holder: Partial<HolderEvidence>, mainReceiptId?: string): Partial<HolderDetails>;
function holderEvidence(holder: Partial<HolderEvidence>, mainReceiptId?: string) {
  if (!holder.phase || !holder.attemptId || holder.runId === undefined) return {};
  return {
    holderPhase: holder.phase,
    generation: overtakeMark({ attemptId: holder.attemptId, runId: holder.runId }),
    ...(holder.proofMainReceiptId && mainReceiptId
      ? { baseStale: holder.proofMainReceiptId !== mainReceiptId }
      : {}),
    ...(holder.unsealed === undefined ? {} : { unsealed: holder.unsealed }),
  };
}
/** Finish the current recorded wait in the row update that releases it. Older waits have no clock. */
export function closeOrderWait(
  row: WaitHistory,
  now = Date.now(),
  withdrawn = false,
  release?: ReleaseCause,
) {
  const result: Pick<LandingRow, 'orderWaits' | 'orderHandoffs'> = {};
  const waits = row.orderWaits;
  const last = waits?.at(-1);
  if (waits && last?.at !== undefined) {
    const { at, ...closed } = last;
    if (!withdrawn && row.orderWait === last.submissionId)
      closed.seconds = (closed.seconds ?? 0) + Math.max(0, now - at) / 1000;
    if (release) closed.release = release;
    result.orderWaits = [...waits.slice(0, -1), closed];
  }
  const handoffs = row.orderHandoffs;
  const handoff = handoffs?.at(-1);
  if (handoffs && handoff && handoff.seconds === undefined && row.orderWait === handoff.submissionId)
    result.orderHandoffs = [
      ...handoffs.slice(0, -1),
      {
        ...handoff,
        ...(!withdrawn ? { seconds: Math.max(0, now - handoff.startedAt) / 1000 } : {}),
        ...(release ? { release } : {}),
      },
    ];
  return result;
}
/** Preserve the same bounded history and de-duplication as the queue's order evidence. */
export function recordOrderWait(
  row: WaitHistory,
  ahead: {
    row: Pick<LandingRow, 'submissionId'> & Partial<HolderEvidence>;
    held: OrderHeld;
    footprints: 'overlap' | 'disjoint' | 'unknown';
  },
  now: number,
  mainReceiptId?: string,
) {
  const waits = row.orderWaits ?? [];
  const active = waits.at(-1);
  if (
    active?.at !== undefined &&
    active.submissionId === row.orderWait &&
    active.submissionId === ahead.row.submissionId &&
    active.held === ahead.held
  )
    return waits;
  const list = closeOrderWait(row, now, false, 'claim').orderWaits ?? waits;
  if (list.length >= HOSTED_ORDER_WAITS) return list;
  const last = list[list.length - 1];
  const details = holderEvidence(ahead.row, mainReceiptId);
  if (last?.submissionId === ahead.row.submissionId && last.held === ahead.held) {
    const reopened = { ...last, at: now };
    delete reopened.release;
    // The queue coalesces repeats. Only describe a generation when it covers the whole interval.
    if (
      last.holderPhase !== details.holderPhase ||
      last.generation !== details.generation ||
      last.baseStale !== details.baseStale ||
      last.unsealed !== details.unsealed
    ) {
      delete reopened.holderPhase;
      delete reopened.generation;
      delete reopened.baseStale;
      delete reopened.unsealed;
    }
    return [...list.slice(0, -1), reopened];
  }
  return [
    ...list,
    {
      submissionId: ahead.row.submissionId,
      held: ahead.held,
      footprints: ahead.footprints,
      at: now,
      ...(details.generation ? { startedAt: now, ...details } : {}),
    },
  ];
}

/** Keep handed edges separate on the row so wake selection still sees only claim decisions. */
export function handoffOrderWait(
  row: WaitHistory,
  next: LandingRow,
  from: Pick<LandingRow, 'submissionId'>,
  release: ReleaseCause,
  mainReceiptId?: string,
  now = Date.now(),
) {
  const closed = closeOrderWait(row, now, false, release);
  const prior = closed.orderHandoffs ?? row.orderHandoffs ?? [];
  if (prior.length >= HOSTED_ORDER_WAITS) return closed;
  return {
    ...closed,
    orderHandoffs: [
      ...prior,
      {
        submissionId: next.submissionId,
        handedFrom: from.submissionId,
        startedAt: now,
        ...holderEvidence(next, mainReceiptId),
      },
    ],
  };
}

/** Receipt view: old clients' canonical acceptance fields retain their existing wire shape. */
export function landingOrderEvidence(
  row: Pick<LandingRow, 'orderWaits' | 'orderHandoffs'> | null,
  fallback: NonNullable<Parameters<typeof orderWaitsField>[0]> | undefined,
) {
  const waits =
    row?.orderWaits?.map(({ at, ...wait }) => ({ at: wait.startedAt ?? at ?? 0, wait })) ??
    fallback?.map(wait => ({ at: 0, wait })) ??
    [];
  const handed = (row?.orderHandoffs ?? []).map(handoff => ({
    at: handoff.startedAt,
    wait: { ...handoff, held: 'handed' as const, footprints: 'unknown' as const },
  }));
  // Preserve up to eight claim decisions and eight handoffs independently, sorted by start.
  const all = [...waits, ...handed];
  return all.length ? all.sort((a, b) => a.at - b.at).map(({ wait }) => wait) : null;
}
const footprintLabel = (independent: boolean | null | undefined) =>
  independent === true
    ? ('disjoint' as const)
    : independent === false
      ? ('overlap' as const)
      : ('unknown' as const);
async function footprintsOf(
  paths: () => Promise<string[] | null>,
  side: () => Promise<Awaited<ReturnType<typeof overtakingSide>>>,
) {
  const me = await side();
  return me ? waitFootprints(me.paths, await paths(), me.checkEntries) : footprintLabel(null);
}
/** A passed entry parked behind an older live submission (claimReadyLanding sets the
 * server-only `orderWait`). Readers name it so the wait has a visible reason (19328518:
 * a READY entry waited 7.6 min with no reason in status). It uses the row the reader
 * already loaded: no extra document read, call or subscription dependency. */
export function landingOrderWaitForReader(
  row: Pick<LandingRow, 'orderWait' | 'orderWaits' | 'phase'> | null | undefined,
  state: HostedLandingState,
) {
  if (!row?.orderWait || row.phase !== 'ready' || state.phase !== 'ready') return null;
  if (state.observation.state !== 'pending') return null;
  const last = row.orderWaits?.at(-1);
  const { orderWaits } = orderWaitsField(row.orderWaits);
  // Why it waits now and every wait so far, as the receipt's `orderWaits` will record them: from the
  // row already loaded (at most 8 entries), so a waiting entry shows its order reason before it lands
  // (ad80e037: rebuilding it from receipts after the fact cost a builder about 15 minutes).
  const why = {
    ...(last?.submissionId === row.orderWait ? { held: last.held, footprints: last.footprints } : {}),
    ...(orderWaits ? { waits: orderWaits } : {}),
  };
  if (last?.submissionId === row.orderWait && last.held === 'reserved')
    return {
      submissionId: row.orderWait,
      reason: 'reservation' as const,
      ...why,
      message: `Check passed; submission ${row.orderWait} holds a landing reservation on files this change touches (it was superseded after a passed check, Issue 10d253c6). This landing continues when that one lands or fails, or when its reservation ends (at most ${HOSTED_RESERVATION_MS / 60_000} minutes). observe {"submissionId":"${row.orderWait}"} follows it.`,
    };
  return {
    submissionId: row.orderWait,
    ...why,
    message: `Check passed; waiting for older submission ${row.orderWait} to take main first (submission order). When it lands or leaves the order this landing continues; observe {"submissionId":"${row.orderWait}"} follows it.`,
  };
}
/** A passed proof ages with every main move, so a READY entry accepts before any
 * new check starts, urgent ones included: urgent leads the train, it never moves
 * main under a passed proof. One indexed window; acceptance is a single slot, so
 * READY entries are few. Entries that wait for review or a dependency are skipped. */
export async function nextReadyLandingRow(ctx: QueryCtx | MutationCtx, input: LandingChannel) {
  const rows = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
      q.eq('projectId', input.projectId).eq('channel', input.channel).eq('phase', 'ready'),
    )
    .order('asc')
    .take(8);
  const ready = rows.filter(row => {
    if (!row.runnable || row.hold) return false;
    const { pendingReason } = storedLandingStateSchema.parse(JSON.parse(row.value)).observation;
    return pendingReason !== 'waiting-for-review' && pendingReason !== 'waiting-for-dependency';
  });
  return orderHostedLandingRows(ready)[0] ?? null;
}
/** Selection of the first entry needs only the head of each indexed class. Old
 * rows without priority belong to normal; no backfill or history scan is needed. */
export async function nextLandingRow(ctx: QueryCtx | MutationCtx, input: LandingChannel) {
  const ready = await nextReadyLandingRow(ctx, input);
  if (ready) return ready;
  const heads = [];
  for (const priority of ['urgent', 'normal', undefined] as const) {
    const [row] = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_channel_and_runnable_and_priority_and_sequence', q =>
        q
          .eq('projectId', input.projectId)
          .eq('channel', input.channel)
          .eq('runnable', true)
          .eq('priority', priority),
      )
      .order('asc')
      .take(1);
    if (row) heads.push(row);
    if (priority === 'urgent' && row) break;
  }
  return orderHostedLandingRows(heads)[0] ?? null;
}
/** Read 50-row indexed sequence windows, discarding bodies after each window.
 * Built-in paginate may only be called once per query, so it is not used here. Memory is proportional
 * to the active queue's compact ordering keys, never retained Work/history. No
 * per-entry RPC, scheduler, observer, or total queue-size ceiling is introduced. */
export async function activeLandingOrder(
  ctx: QueryCtx | MutationCtx,
  input: LandingChannel,
  phases: Array<'queued' | 'checking' | 'ready'> = ['queued', 'checking', 'ready'],
  batchable = false,
) {
  const keys: Array<Pick<LandingRow, 'submissionId' | 'actor' | 'sequence' | 'priority' | 'phase'>> = [];
  for (const phase of phases) {
    let after = -1;
    for (;;) {
      const query = batchable
        ? ctx.db
            .query('projectHostedLandingRequests')
            .withIndex('by_project_and_channel_and_batchable_and_phase_and_sequence', q =>
              q
                .eq('projectId', input.projectId)
                .eq('channel', input.channel)
                .eq('batchable', true)
                .eq('phase', phase)
                .gt('sequence', after),
            )
        : ctx.db
            .query('projectHostedLandingRequests')
            .withIndex('by_project_and_channel_and_phase_and_sequence', q =>
              q
                .eq('projectId', input.projectId)
                .eq('channel', input.channel)
                .eq('phase', phase)
                .gt('sequence', after),
            );
      const page = await query.order('asc').take(50);
      for (const row of page)
        keys.push({
          submissionId: row.submissionId,
          actor: row.actor,
          sequence: row.sequence,
          priority: row.priority,
          phase: row.phase,
        });
      if (page.length < 50) break;
      after = page[page.length - 1]!.sequence;
    }
  }
  const running = keys.filter(row => row.phase !== 'queued').sort((a, b) => a.sequence - b.sequence);
  return [...running, ...orderHostedLandingRows(keys.filter(row => row.phase === 'queued'))];
}
export type LandingOrder = Awaited<ReturnType<typeof activeLandingOrder>>;
/** Released wait/stack readers parse submission bodies strictly. Keep their
 * original read shape unless the caller explicitly selects priority metadata. */
export function landingStateForReader(state: HostedLandingState, priorityInfo?: 1): HostedLandingState {
  // Retry links remain in canonical records and admission receipts. Selected
  // read DTOs keep the released strict shape, including priority-aware readers.
  const {
    supersedes: _supersedes,
    retryReason: _retryReason,
    message: _message,
    messageRef: _messageRef,
    ...publicState
  } = state;
  const { retryReason: _requestedRetry, message: _requestedMessage, ...publicRequest } = state.request;
  void _supersedes;
  void _retryReason;
  void _requestedRetry;
  // Message provenance stays in canonical records, not released strict wait DTOs.
  void _message;
  void _messageRef;
  void _requestedMessage;
  const { ms: _ms, heldMs: _heldMs, ...timing } = state.timing ?? { submittedAt: state.at };
  void _ms;
  void _heldMs;
  const readable = { ...publicState, ...(state.timing ? { timing } : {}), request: publicRequest };
  if (priorityInfo === 1) return readable;
  const { priority: _priority, priorityReason: _reason, priorityVersion: _version, ...legacy } = readable;
  const { priority: _requested, ...request } = readable.request;
  void _priority;
  void _reason;
  void _version;
  void _requested;
  return { ...legacy, request };
}
