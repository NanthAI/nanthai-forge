// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { z } from 'zod';
import {
  FAST_WINDOW,
  auditCadencePolicySchema,
  type auditDonorSignal,
  type AuditCadencePolicy,
  type AuditCoverageSample,
  type AuditWindowSlot,
} from './landing-mode.js';

const minute = 60_000;
const donorMissThreshold = 0.25;
const positive = z.number().safe().positive();
const cadenceMode = z.enum(['automatic', 'every-landing', 'manual']);
type AuditInterval = { landings: number; minutes: number };

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

const setting = {
  key: 'mainAudit.cadence',
  reason: 'Verify accepted main with fewer repeated full checks when landings arrive together.',
  signal:
    'Confirmed red audits, verified landings, audit wall time and evaluated first-check donor refusals.',
  formula: 'k = clamp(floor(0.25 / ((red + 1) / (audited landings + 2))), 1, 5)',
  donorStepdown: 'Lower k by one when at least 25% of evaluated starts refused the audit baseline.',
  bounds: { landings: [1, 5], minutes: [2, 15], window: FAST_WINDOW },
  override: 'set-policy mainAudit.cadence (automatic, every-landing, or manual with landings and minutes)',
  metric: 'Landings that stay landed',
  interactsWith: ['acceptance.gate', 'acceptance.landingMode'],
} as const;

const policyDefault = { cadence: 'automatic' } as const;
type DonorSignal = ReturnType<typeof auditDonorSignal>;

export function auditCadence(
  policy: AuditCadencePolicy | undefined,
  legacy: AuditInterval | null,
  window: readonly AuditWindowSlot[] | undefined,
  samples: readonly AuditCoverageSample[] | undefined,
  donors: DonorSignal = { evaluated: 0, refusals: 0, unevaluated: 0 },
) {
  const override = policy ?? (legacy ? { cadence: 'manual' as const, ...legacy } : null);
  const mode = (override ?? policyDefault).cadence;
  let redAudits = 0;
  let auditedLandings = 0;
  for (const slot of window ?? []) {
    if (slot.red) redAudits += slot.red.count;
    // Old green slots did not record their span. Each represents at least one verified landing.
    auditedLandings += slot.audit?.auditedLandings ?? (slot.audit?.verdict === 'green' ? 1 : 0);
  }
  auditedLandings = Math.min(FAST_WINDOW, auditedLandings);
  const durations = (samples ?? []).flatMap(s => (s.wallMs === undefined ? [] : [s.wallMs]));
  durations.sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const medianWallMs = durations.length
    ? (durations[middle]! + durations[Math.floor((durations.length - 1) / 2)]!) / 2
    : null;
  const redRate = (redAudits + 1) / (auditedLandings + 2);
  const donorMissRate = donors.evaluated ? donors.refusals / donors.evaluated : null;
  const redThreshold = clamp(Math.floor(0.25 / redRate), ...setting.bounds.landings);
  const donorStepdown = redThreshold > 1 && donorMissRate !== null && donorMissRate >= donorMissThreshold;
  const automatic = {
    landings: redThreshold - Number(donorStepdown),
    minutes: clamp((medianWallMs ?? 0) / minute, ...setting.bounds.minutes),
  };
  const effective =
    override?.cadence === 'manual'
      ? { landings: override.landings, minutes: override.minutes }
      : mode === 'every-landing'
        ? { landings: 1, minutes: 0 }
        : automatic;
  return {
    mode,
    override,
    effective,
    automatic,
    signal: {
      redAudits,
      auditedLandings,
      redRate,
      medianWallMs,
      durationSamples: durations.length,
      donors: { ...donors, missRate: donorMissRate, stepdown: donorStepdown },
    },
  };
}

export const auditStartReasonSchema = z.enum([
  'after-idle',
  'landing-threshold',
  'oldest-wait',
  'coverage-change',
  'main-red',
  'failed-full-check',
  'first-check',
  'retry',
  'manual-start',
]);
export type AuditStartReason = z.infer<typeof auditStartReasonSchema>;
type Urgency = 'coverage-change' | 'main-red' | 'failed-full-check' | 'first-check';

export function auditSchedule(
  cadence: Pick<ReturnType<typeof auditCadence>, 'mode' | 'effective'>,
  pending: { count: number; firstAt: string | null },
  lastStartedAt: number | undefined,
  urgent: Urgency | undefined,
  now: number,
): { at: number; reason: AuditStartReason } {
  if (urgent) return { at: now, reason: urgent };
  const oldest = pending.firstAt ? Date.parse(pending.firstAt) : now;
  const waitMs = cadence.effective.minutes * minute;
  if (cadence.mode === 'automatic' && (lastStartedAt === undefined || oldest - lastStartedAt >= waitMs))
    return { at: now, reason: 'after-idle' };
  if (pending.count >= cadence.effective.landings) return { at: now, reason: 'landing-threshold' };
  return { at: oldest + waitMs, reason: 'oldest-wait' };
}

const cadenceReading = z.object({ landings: positive, minutes: z.number().nonnegative() });
const signal = z.object({
  redAudits: z.number().nonnegative(),
  auditedLandings: z.number().nonnegative(),
  redRate: z.number().positive(),
  medianWallMs: z.number().nonnegative().nullable(),
  durationSamples: z.number().nonnegative(),
  donors: z
    .object({
      evaluated: z.number().nonnegative(),
      refusals: z.number().nonnegative(),
      unevaluated: z.number().nonnegative(),
      missRate: z.number().nonnegative().nullable(),
      stepdown: z.boolean(),
    })
    .optional(),
});
export const auditCoverageSchema = z.object({
  firstSequence: positive,
  throughSequence: positive,
  landings: positive,
  oldestAt: z.iso.datetime(),
  startedAt: z.iso.datetime(),
  reason: auditStartReasonSchema,
  reused: z.literal(true).optional(),
  cadence: z.object({
    mode: cadenceMode,
    override: auditCadencePolicySchema.nullable(),
    effective: cadenceReading,
    automatic: cadenceReading,
    signal,
  }),
});

export function auditCadenceView(cadence: ReturnType<typeof auditCadence>) {
  const { landings, minutes } = cadence.automatic;
  const { redAudits, auditedLandings, durationSamples, donors } = cadence.signal;
  return {
    setting,
    ...cadence,
    automaticHint: `Automatic picks ${landings} landing(s) or ${minutes} minutes because the window has ${redAudits} red audit(s), ${auditedLandings} verified landing(s) and ${durationSamples} audit duration(s). ${donors.refusals} of ${donors.evaluated} evaluated starts refused the audit baseline${donors.stepdown ? ', lowering k by one' : ''}.`,
  };
}
