// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** One rule for server, CLI and web: the owner's policy, live audit freshness and a
 * circuit breaker. Fast relaxes tested-doc and non-order-sensitive global-risk only. */
export const landingModeSchema = z.enum(['strict', 'fast']);
export type LandingMode = z.infer<typeof landingModeSchema>;
export const FAST_WINDOW = 50;
export const FAST_BREAKER_COUNT = 3;
export const FAST_MAX_UNAUDITED = 10;
export const FAST_MAX_AUDIT_AGE_MS = 60 * 60_000;
export const FAST_RELAXED = ['global-risk', 'tested-doc'] as const;
export type FastRelaxed = (typeof FAST_RELAXED)[number];

/** Two bounded clocks share at most 50 compact slots: red counts by audited landing
 * position, and verdicts by audit position. They must not share an eviction clock: one
 * audit may cover many landings, and a stalled audit covers none. */
type Verdict = 'green' | 'red' | 'unclear' | 'drill';
export type AuditOutcome = { verdict: Verdict; landings: number; runId?: string };
export type AuditWindowSlot = {
  /** Age relative to lastGreen; a failed audit's unaudited position has negative age. */
  red?: { age: number; count: number; drill: number };
  audit?: { verdict: Verdict; runId?: string; landings?: number };
};
function streams(window: readonly AuditWindowSlot[] | undefined) {
  return {
    reds: (window ?? []).flatMap(slot => (slot.red ? [{ ...slot.red }] : [])),
    audits: (window ?? []).flatMap(slot => (slot.audit ? [{ ...slot.audit }] : [])),
  };
}
function pack({ reds, audits }: ReturnType<typeof streams>): AuditWindowSlot[] {
  const retained = reds
    .filter(red => red.age < FAST_WINDOW && red.count + red.drill > 0)
    .sort((a, b) => a.age - b.age)
    .slice(0, FAST_WINDOW);
  const recent = audits.slice(-FAST_WINDOW);
  return Array.from({ length: Math.max(retained.length, recent.length) }, (_, index) => ({
    ...(retained[index] ? { red: retained[index] } : {}),
    ...(recent[index] ? { audit: recent[index] } : {}),
  }));
}
/** Existing terminal guards make writes idempotent. Reds at the same landing position
 * share a count; the last 50 distinct positions cover every red that can remain relevant. */
export function auditWindow(window: readonly AuditWindowSlot[] | undefined, outcome: AuditOutcome) {
  const next = streams(window);
  if (outcome.verdict === 'green') {
    for (const red of next.reds) red.age += outcome.landings;
  } else if (outcome.verdict === 'red' || outcome.verdict === 'drill') {
    const age = -outcome.landings;
    let red = next.reds.find(entry => entry.age === age);
    if (!red) {
      red = { age, count: 0, drill: 0 };
      next.reds.push(red);
    }
    if (outcome.verdict === 'drill') red.drill++;
    else red.count++;
  }
  next.audits.push({
    verdict: outcome.verdict,
    ...(outcome.runId ? { runId: outcome.runId, landings: outcome.landings } : {}),
  });
  return pack(next);
}
/** The later pass vouches for the failed audit: replace its verdict rather than
 * counting a second audit. Its covered landing position identifies the red bucket. */
export function auditWindowFlake(
  window: readonly AuditWindowSlot[] | undefined,
  runId: string,
  landings: number,
) {
  const next = streams(window);
  const failed = next.audits.find(entry => entry.runId === runId);
  const red = next.reds.find(entry => entry.age === -(failed?.landings ?? landings));
  if (red) {
    if (failed?.verdict === 'drill') red.drill = Math.max(0, red.drill - 1);
    else red.count = Math.max(0, red.count - 1);
  }
  for (const entry of next.reds) entry.age += landings;
  if (failed) {
    failed.verdict = 'unclear';
    delete failed.runId;
    delete failed.landings;
  } else next.audits.push({ verdict: 'unclear' });
  return pack(next);
}
/** A timely optional drill is excluded from real reds; a late drill is real.
 * Recovery advances the landing clock and retires the flake-classification pins. */
export function auditWindowGreen(
  window: readonly AuditWindowSlot[] | undefined,
  landings: number,
  drill?: { startedAt: string; redAt: string; recoveredAt: string },
) {
  const next = streams(window);
  for (const red of next.reds) {
    if (drill && !drillInTime(drill, drill.recoveredAt)) red.count += red.drill;
    red.drill = 0;
  }
  for (const entry of next.audits) {
    delete entry.runId;
    delete entry.landings;
  }
  return auditWindow(pack(next), { verdict: 'green', landings });
}
export const FAST_DRILL_MS = 2 * 60 * 60_000;
export type DrillRed = { startedAt: string; redAt: string };
export const drillClaims = (drill: { startedAt: string; red?: unknown } | undefined, at: string) =>
  !!drill && !drill.red && Date.parse(at) - Date.parse(drill.startedAt) <= FAST_DRILL_MS;
export const drillInTime = (drill: DrillRed, recoveredAt: string) =>
  Date.parse(recoveredAt) - Date.parse(drill.redAt) <= FAST_DRILL_MS;

function breaker(window: readonly AuditWindowSlot[] | undefined) {
  const { reds, audits } = streams(window);
  return {
    red: reds.filter(entry => entry.age < FAST_WINDOW).reduce((sum, entry) => sum + entry.count, 0),
    unclear: audits.slice(-FAST_WINDOW).filter(entry => entry.verdict === 'unclear').length,
    audits: Math.min(FAST_WINDOW, audits.length),
  };
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
/** The live rule is checked at proof decision and again at publication. */
export const fastEffective = (
  mode: LandingMode | undefined,
  window: readonly AuditWindowSlot[] | undefined,
  audit: AuditFreshness,
  now = Date.now(),
) => {
  const history = breaker(window);
  return (
    mode === 'fast' &&
    auditStale(audit, now) === null &&
    history.red < FAST_BREAKER_COUNT &&
    history.unclear < FAST_BREAKER_COUNT
  );
};

export type LandingModeView = {
  mode: LandingMode;
  effective: LandingMode;
  state: 'strict' | 'fast' | 'suspended';
  label: string;
  tone: 'ok' | 'waiting' | 'attention';
  reason: string | null;
  nextStep: string;
  advice: {
    switchTo: LandingMode;
    reason: string;
    policy: { acceptance: { landingMode: LandingMode } };
  } | null;
  window: { red: number; unclear: number; audits: number; limit: number };
};
const STALE_TEXT: Record<NonNullable<ReturnType<typeof auditStale>>, string> = {
  'main-red': 'main is red',
  'no-green-audit': 'main has no green audit yet',
  'audit-stalled': 'the last main audit ended without a verdict',
  'unaudited-landings': `more than ${FAST_MAX_UNAUDITED} landings are unaudited`,
  'audit-old': 'the oldest unaudited landing is over an hour old',
};
/** The owner's choice never changes automatically. Pauses clear with live recovery or
 * as bad verdicts leave the window; repeated trouble advises switching to strict. */
export function landingModeView(
  mode: LandingMode | undefined,
  window: readonly AuditWindowSlot[] | undefined,
  audit: AuditFreshness,
  now = Date.now(),
): LandingModeView {
  const history = breaker(window);
  const progress = { ...history, limit: FAST_WINDOW };
  const base = { mode: mode ?? 'strict', window: progress };
  if (mode !== 'fast')
    return {
      ...base,
      effective: 'strict',
      state: 'strict',
      label: 'Strict landing',
      tone: 'ok',
      reason: null,
      nextStep: 'Nothing to do.',
      advice: null,
    };
  const repeated =
    history.red >= FAST_BREAKER_COUNT
      ? `${history.red} real red audits in the last ${FAST_WINDOW} audited landings`
      : history.unclear >= FAST_BREAKER_COUNT
        ? `${history.unclear} audits ended without a clean verdict (flaky or stalled) in the last ${FAST_WINDOW} audits`
        : null;
  const stale = auditStale(audit, now);
  if (repeated) {
    const reason = `Fast landing is paused: ${repeated}. It resumes automatically when the window clears and main is green and audited.`;
    const policy = { acceptance: { landingMode: 'strict' as const } };
    return {
      ...base,
      effective: 'strict',
      state: 'suspended',
      label: 'Fast landing paused',
      tone: 'attention',
      reason,
      nextStep: `${reason} Switch to strict: set-policy ${JSON.stringify(policy)}.`,
      advice: { switchTo: 'strict', reason, policy },
    };
  }
  if (stale)
    return {
      ...base,
      effective: 'strict',
      state: 'suspended',
      label: 'Fast landing paused',
      tone: 'waiting',
      reason: STALE_TEXT[stale],
      nextStep: `Fast landing is paused because ${STALE_TEXT[stale]}. Land with the second check; fast resumes automatically once main is green and audited.`,
      advice: null,
    };
  return {
    ...base,
    effective: 'fast',
    state: 'fast',
    label: 'Fast landing',
    tone: 'ok',
    reason: null,
    nextStep: 'Nothing to do.',
    advice: null,
  };
}
