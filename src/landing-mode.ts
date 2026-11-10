// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Hosted landing modes (Issue 81d12a32). One derive for server, CLI and web.
 *
 * `strict` (absent): a change lands on its own check only when main is unchanged or the
 * clean-disjoint proof holds; everything else gets the second check.
 * `fast`: the proof also carries a `tested-doc` overlap and `global-risk` that is not
 * order-sensitive, but only while the project has earned it and the main audit is fresh.
 * Fast never claims main is always green: main is verified after the landing and a proven
 * culprit is reverted. The policy is the owner's consent; earned is Forge's evidence. */
export const landingModeSchema = z.enum(['strict', 'fast']);
export type LandingMode = z.infer<typeof landingModeSchema>;

/** Audited landings since the last red audit that earn fast mode. */
export const FAST_EARN_AUDITED = 200;
/** Share of landings whose audit gave no clean verdict (stalled or flaky) that un-earns it. */
export const FAST_UNCLEAR_SHARE = 0.05;
/** Counters halve at this total, so the share follows recent history; an earned project stays earned. */
export const FAST_WINDOW = 4 * FAST_EARN_AUDITED;
/** Audit lag bound, by count and by time (the oldest unaudited landing). Past either, fast falls back. */
export const FAST_MAX_UNAUDITED = 10;
export const FAST_MAX_AUDIT_AGE_MS = 60 * 60_000;
/** The refusal classes fast mode relaxes. Every other class always gets the second check. */
export const FAST_RELAXED = ['global-risk', 'tested-doc'] as const;
export type FastRelaxed = (typeof FAST_RELAXED)[number];

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const landingEarnedSchema = z
  .object({
    /** Landings covered by a green full audit or an exact full check, since the last red audit. */
    audited: count,
    /** Landings whose audit ended with no clean verdict: stalled, or a failure the flake guard cleared. */
    unclear: count,
    /** The last red audit that was detected and recovered (the drill); `reverted` when Forge reverted its culprit.
     * `started` and `red` are set only for an owner's deliberate drill that recovered in time. */
    drill: z
      .object({
        at: z.string(),
        sequence: count,
        reverted: z.boolean(),
        started: z.string().optional(),
        red: z.string().optional(),
      })
      .strict()
      .optional(),
    /** Set when a red audit took earned fast mode away; cleared once it is earned again. */
    lost: z
      .object({ at: z.string(), reason: z.literal('red') })
      .strict()
      .optional(),
  })
  .strict();
export type LandingEarned = z.infer<typeof landingEarnedSchema>;
const none: LandingEarned = { audited: 0, unclear: 0 };

const settle = (next: LandingEarned): LandingEarned => {
  const halve = next.audited + next.unclear >= FAST_WINDOW;
  const value = halve
    ? { ...next, audited: Math.floor(next.audited / 2), unclear: Math.floor(next.unclear / 2) }
    : next;
  if (!value.lost || !landingEarned(value).earned) return value;
  const { lost: _lost, ...kept } = value;
  void _lost;
  return kept;
};
/** Red-audit drill (Issue fe7d67a8). Only the owner person starts one; an agent's request waits for
 * their grant. The first red audit within this long of the start is the drill's red, and it must
 * recover within this long of that red. A drill that recovers in time is the recovered red on record
 * and keeps the count; one that recovers late is a real red. */
export const FAST_DRILL_MS = 2 * 60 * 60_000;
export type DrillRed = { startedAt: string; redAt: string };
/** An armed drill claims a red audit at `at` when it has no red yet and its start window is open. */
export const drillClaims = (drill: { startedAt: string; red?: unknown } | undefined, at: string) =>
  !!drill && !drill.red && Date.parse(at) - Date.parse(drill.startedAt) <= FAST_DRILL_MS;
export const drillInTime = (drill: DrillRed, recoveredAt: string) =>
  Date.parse(recoveredAt) - Date.parse(drill.redAt) <= FAST_DRILL_MS;
type Recovered = { at: string; sequence: number; reverted: boolean; drill?: DrillRed };
/** A green full verdict covered `landings`. `recovered` is set when it ended a red episode: a real
 * red costs the earned state (re-earn from zero) and is the drill on record. An owner's drill that
 * recovered in time is the drill on record and keeps the count; its red episode adds nothing. */
export function earnedAfterGreen(
  earned: LandingEarned | undefined,
  landings: number,
  recovered?: Recovered,
): LandingEarned {
  const current = earned ?? none;
  if (recovered?.drill && drillInTime(recovered.drill, recovered.at)) {
    const { drill, ...record } = recovered;
    return settle({ ...current, drill: { ...record, started: drill.startedAt, red: drill.redAt } });
  }
  if (recovered) {
    const { drill: _late, ...record } = recovered;
    void _late;
    return { audited: 0, unclear: 0, drill: record, lost: { at: recovered.at, reason: 'red' } };
  }
  return settle({ ...current, audited: current.audited + Math.max(0, landings) });
}
/** An audit of `landings` ended with no clean verdict (stalled, or a flake the guard cleared). */
export function earnedAfterUnclear(earned: LandingEarned | undefined, landings: number): LandingEarned {
  const current = earned ?? none;
  return settle({ ...current, unclear: current.unclear + Math.max(0, landings) });
}
export type EarnLanding = { sequence: number; kind: 'docs' | 'exact' | 'proof' };
export type EarnEvent = {
  kind: 'green' | 'red' | 'stalled' | 'flake' | 'culprit';
  at: string;
  runId: string;
  sequence: number;
  drill?: { startedAt: string; redAt?: string; recoveredAt?: string; outcome?: string };
};
/** Replays retained history with the live counter's rules (the owner's backfill, fe7d67a8). An exact
 * full check audits its landing; a landing on its own check is audited by the first audit verdict at or
 * after its sequence: green audits it, stalled is unclear and its retry audits it, red ends the episode
 * (a flake-cleared red is unclear), and nothing after it means a later exact full landing covered it. Landings in sequence order, at or below the last green; events in
 * (sequence, creation) order. */
export function earnedFromHistory(landings: readonly EarnLanding[], events: readonly EarnEvent[]) {
  const flaked = new Set(events.filter(e => e.kind === 'flake').map(e => e.runId));
  const culprits = new Set(events.filter(e => e.kind === 'culprit').map(e => e.runId));
  const verdicts = events.filter(e => e.kind !== 'flake' && e.kind !== 'culprit');
  const ended = new Set<string>();
  const drillGreens = new Set<string>();
  let earned: LandingEarned = none;
  let next = 0;
  for (const landing of landings) {
    while (next < verdicts.length && verdicts[next]!.sequence < landing.sequence) next++;
    const event = verdicts[next];
    if (event?.kind === 'red') {
      if (flaked.has(event.runId)) {
        if (landing.kind !== 'docs') earned = earnedAfterUnclear(earned, 1);
      } else if (!ended.has(event.runId)) {
        ended.add(event.runId);
        const green = verdicts.slice(next).find(e => e.kind === 'green');
        const drill = event.drill;
        // A claimed drill red that was never closed recovered at the green that ended its episode.
        const recoveredAt = drill?.recoveredAt ?? (drill?.redAt && !drill.outcome ? green?.at : undefined);
        if (drill?.redAt && recoveredAt && green) drillGreens.add(green.runId);
        earned = earnedAfterGreen(earned, 0, {
          at: recoveredAt ?? green?.at ?? event.at,
          sequence: green?.sequence ?? event.sequence,
          reverted: culprits.has(event.runId),
          ...(drill?.redAt && recoveredAt
            ? { drill: { startedAt: drill.startedAt, redAt: drill.redAt } }
            : {}),
        });
      }
      continue;
    }
    // The verdict that ended an owner's drill adds nothing, as live; a docs pass never counts.
    if ((event?.kind === 'green' && (event.drill || drillGreens.has(event.runId))) || landing.kind === 'docs')
      continue;
    // An exact full landing audits itself, so a later stalled audit never covered it (as live).
    if (event?.kind === 'stalled' && landing.kind === 'proof') earned = earnedAfterUnclear(earned, 1);
    earned = earnedAfterGreen(earned, 1);
  }
  return earned;
}
/** Whether the project's own history has earned fast mode, and what is still missing. */
export function landingEarned(earned: LandingEarned | undefined) {
  const { audited, unclear, drill } = earned ?? none;
  const total = audited + unclear;
  const unclearShare = total ? unclear / total : 0;
  const missing: ('audited' | 'unclear' | 'drill')[] = [];
  if (audited < FAST_EARN_AUDITED) missing.push('audited');
  if (unclearShare >= FAST_UNCLEAR_SHARE) missing.push('unclear');
  if (!drill) missing.push('drill');
  return { earned: missing.length === 0, missing, audited, unclear, unclearShare, drill: drill ?? null };
}

export type AuditFreshness = {
  status: 'unknown' | 'green' | 'red';
  unaudited: { count: number; firstAt: string | null };
  /** An audit newer than the last green ended without a verdict, or could not start. */
  stalled: boolean;
};
/** Why the audit is not fresh enough for a fast landing, or null. The bound is on both
 * count and time so a stalled audit cannot turn "verified shortly after" into "verified whenever". */
export function auditStale(audit: AuditFreshness, now = Date.now()) {
  if (audit.status === 'red') return 'main-red' as const;
  if (audit.status !== 'green') return 'no-green-audit' as const;
  if (audit.stalled) return 'audit-stalled' as const;
  if (audit.unaudited.count > FAST_MAX_UNAUDITED) return 'unaudited-landings' as const;
  if (
    audit.unaudited.count > 0 &&
    audit.unaudited.firstAt !== null &&
    now - Date.parse(audit.unaudited.firstAt) > FAST_MAX_AUDIT_AGE_MS
  )
    return 'audit-old' as const;
  return null;
}
/** Fast mode carries a relaxed class only when all three hold. */
export const fastEffective = (
  mode: LandingMode | undefined,
  earned: LandingEarned | undefined,
  audit: AuditFreshness,
  now = Date.now(),
) => mode === 'fast' && landingEarned(earned).earned && auditStale(audit, now) === null;

export type LandingModeState = 'strict' | 'earned' | 'fast' | 'suspended' | 'earning' | 'lost';
export type LandingModeView = {
  mode: LandingMode;
  /** What landings get right now. */
  effective: LandingMode;
  state: LandingModeState;
  label: string;
  tone: 'ok' | 'waiting' | 'attention';
  nextStep: string;
  /** Present only when the project should switch; the policy change for the owner or the next agent. */
  advice: {
    switchTo: LandingMode;
    reason: string;
    policy: { acceptance: { landingMode: LandingMode } };
  } | null;
  progress: { audited: number; needed: number; unclearShare: number; drill: boolean };
};
const STALE_TEXT: Record<NonNullable<ReturnType<typeof auditStale>>, string> = {
  'main-red': 'main is red',
  'no-green-audit': 'main has no green audit yet',
  'audit-stalled': 'the last main audit ended without a verdict',
  'unaudited-landings': `more than ${FAST_MAX_UNAUDITED} landings are unaudited`,
  'audit-old': 'the oldest unaudited landing is over an hour old',
};
const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;
/** The one view of a project's landing mode: state, plain label, and the next step. */
export function landingModeView(
  mode: LandingMode | undefined,
  earned: LandingEarned | undefined,
  audit: AuditFreshness,
  now = Date.now(),
): LandingModeView {
  const history = landingEarned(earned);
  const progress = {
    audited: history.audited,
    needed: FAST_EARN_AUDITED,
    unclearShare: history.unclearShare,
    drill: history.drill !== null,
  };
  const policy = (landingMode: LandingMode) => ({ acceptance: { landingMode } });
  const numbers = `${history.audited} audited landings since the last red audit, ${percent(history.unclearShare)} without a clean audit verdict`;
  const todo = [
    ...(history.missing.includes('audited')
      ? [`${history.audited} of ${FAST_EARN_AUDITED} audited landings`]
      : []),
    ...(history.missing.includes('unclear')
      ? [
          `${percent(history.unclearShare)} of audits stalled or flaky (needs under ${percent(FAST_UNCLEAR_SHARE)})`,
        ]
      : []),
    ...(history.missing.includes('drill')
      ? ['no recovered red audit on record (run one red-audit drill)']
      : []),
  ].join('; ');
  if (mode !== 'fast') {
    if (!history.earned)
      return {
        mode: 'strict',
        effective: 'strict',
        state: 'strict',
        label: 'Strict landing',
        tone: 'ok',
        nextStep: 'Nothing to do.',
        advice: null,
        progress,
      };
    const reason = `This project has earned fast landing: ${numbers}, and a red audit was recovered.`;
    return {
      mode: 'strict',
      effective: 'strict',
      state: 'earned',
      label: 'Strict landing; fast is earned',
      tone: 'attention',
      nextStep: `${reason} Switch it on: set-policy ${JSON.stringify(policy('fast'))}. Changes then land on their own check for tested-doc and global-risk overlaps; main is verified after and a culprit is reverted.`,
      advice: { switchTo: 'fast', reason, policy: policy('fast') },
      progress,
    };
  }
  if (history.earned) {
    const stale = auditStale(audit, now);
    return stale
      ? {
          mode: 'fast',
          effective: 'strict',
          state: 'suspended',
          label: 'Fast landing paused',
          tone: 'waiting',
          nextStep: `Fast landing is paused because ${STALE_TEXT[stale]}; landings get the second check until the main audit is green and current. Nothing to do.`,
          advice: null,
          progress,
        }
      : {
          mode: 'fast',
          effective: 'fast',
          state: 'fast',
          label: 'Fast landing',
          tone: 'ok',
          nextStep: 'Nothing to do.',
          advice: null,
          progress,
        };
  }
  const lost = earned?.lost;
  const unclear = history.missing.includes('unclear');
  if (!lost && !unclear)
    return {
      mode: 'fast',
      effective: 'strict',
      state: 'earning',
      label: 'Fast landing not earned yet',
      tone: 'waiting',
      nextStep: `Fast landing starts once this project has earned it: ${todo}. Until then every landing is strict. Nothing to do.`,
      advice: null,
      progress,
    };
  const reason = lost
    ? `A main audit went red on ${lost.at.slice(0, 10)}, so fast landing is off until it is earned again: ${todo}.`
    : `Main audits are often stalled or flaky (${percent(history.unclearShare)}), so fast landing is off: ${todo}.`;
  return {
    mode: 'fast',
    effective: 'strict',
    state: 'lost',
    label: 'Fast landing lost',
    tone: 'attention',
    nextStep: `${reason} Switch it off so the policy says what happens: set-policy ${JSON.stringify(policy('strict'))}.`,
    advice: { switchTo: 'strict', reason, policy: policy('strict') },
    progress,
  };
}
