// SPDX-License-Identifier: Apache-2.0
import { digest } from './portable-hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import type { AutonomyPolicy } from './autonomy-policy.js';
import { effectiveAgentDefaults } from './agent-parallel-defaults.js';

/** The part of the policy that decides what a landing may accept: gate, mode, protected paths, auto
 * actors, checks, lifecycle and enforced trust. The preset is only a label (any edit turns it into
 * `custom`). Agent defaults, notifications, the GitHub mirror (read
 * live after acceptance) and trust in shadow mode (`enabled:false` records history, changes no gate) do
 * not change an attempt, so editing them never invalidates a pinned landing. Neither does the landing
 * mode: it is read live when a first-check proof is decided and again when it is published. */
function landingPolicy(policy: AutonomyPolicy) {
  const kept: Partial<AutonomyPolicy> = { ...policy, acceptance: withoutLandingMode(policy) };
  delete kept.agentDefaults;
  delete kept.notify;
  delete kept.githubMirror;
  delete kept.preset;
  if (!policy.trust?.enabled) delete kept.trust;
  return kept;
}
function withoutLandingMode(policy: AutonomyPolicy) {
  const { landingMode: _mode, ...acceptance } = policy.acceptance;
  void _mode;
  return acceptance;
}
/** The policy a landing is pinned to. */
export const acceptancePolicyDigest = (policy: AutonomyPolicy) =>
  digest(canonicalPayload(landingPolicy(policy)));
/** Attempts pinned before the narrower digest used the policy minus agent defaults; they stay valid
 * until the policy changes in a way that matters to them (or, for them, any other field). */
const legacyDigest = (policy: AutonomyPolicy) => {
  const legacy: Partial<AutonomyPolicy> = { ...policy, acceptance: withoutLandingMode(policy) };
  delete legacy.agentDefaults;
  return digest(canonicalPayload(legacy));
};
/** True when an attempt pinned to `pinned` is still valid under `policy`. */
export const policyDigestCurrent = (policy: AutonomyPolicy, pinned: string) =>
  pinned === acceptancePolicyDigest(policy) || pinned === legacyDigest(policy);

/** `relax` holds a change only when it lowers owner oversight: `held(previous, next)` says when. */
type Relax = { relax: string; held: (previous: AutonomyPolicy, policy: AutonomyPolicy) => boolean };
type GateClass = 'gated' | Relax | { exempt: string };
const alertsOf = (policy: AutonomyPolicy) => effectiveAgentDefaults(policy.agentDefaults).stallAlerts;
const landingModeOf = (policy: AutonomyPolicy) => policy.acceptance.landingMode ?? 'strict';
const notLanding = 'the landing check still decides what lands';
const timing = 'alert timing, capped by the schema (first alert within 24 h, repeat within 48 h)';
/** The owner gate (Issue 470ef29b): how an agent sign-in's policy edit is decided, per field. `gated`
 * holds any change for the owner person; `relax` holds a change that lowers owner oversight; an exempt
 * field applies at once, for the stated reason. A field that is not listed is gated, and a test fails
 * until it is listed (tests/public-governance.test.mjs). */
export const OWNER_GATE: Readonly<Record<string, GateClass>> = {
  preset: { exempt: 'a label: an edit that changes behaviour also changes a gated field' },
  'githubMirror.repo': 'gated',
  'githubMirror.autoPush': 'gated',
  'githubMirror.laneRefs': 'gated',
  'githubMirror.inbound': 'gated',
  'autoExchange.enabled': 'gated',
  'autoExchange.debounceMs': 'gated',
  'autoExchange.maxPendingAgeMs': 'gated',
  'autoExchange.pauseOnDailySpend': 'gated',
  'checkLogs.uploadLocal': 'gated',
  'checkLogs.retentionDays': 'gated',
  // Trust in shadow mode (enabled:false) records history and changes no gate; enabling it is gated.
  'trust.enabled': 'gated',
  'trust.trustedAt': 'gated',
  'trust.autonomousAt': 'gated',
  'trust.halfLifeDays': 'gated',
  'trust.culpritKeep': 'gated',
  'trust.probationLandings': 'gated',
  'trust.vendors': 'gated',
  'trust.establishedVendors': 'gated',
  'agentDefaults.preflight': { exempt: `a local step before submitting; ${notLanding}` },
  'agentDefaults.preflightMaxMinutes': { exempt: `a local step before submitting; ${notLanding}` },
  'agentDefaults.urgentRoles': {
    exempt:
      'queue order only, and a default-behaviour guard: an owner-account CLI can already ask as the owner',
  },
  'agentDefaults.overlapGate': { exempt: 'retired: stored values are ignored' },
  'agentDefaults.checkpointNudgeMinutes': { exempt: 'a save reminder' },
  'agentDefaults.autoClaim': { exempt: 'board notes about touched paths' },
  'agentDefaults.dormantAfterDays': { exempt: 'marks idle Lanes in listings; nothing is removed' },
  'agentDefaults.stacking': { exempt: `where a Lane is based before its check; ${notLanding}` },
  // Turning alerts off removes owner oversight, like relaxing the landing mode; turning them on is free.
  'agentDefaults.stallAlerts.enabled': {
    relax: 'turning alerts off is held',
    held: (previous, policy) => alertsOf(previous).enabled && !alertsOf(policy).enabled,
  },
  'agentDefaults.stallAlerts.notifyAfterMinutes': { exempt: timing },
  'agentDefaults.stallAlerts.repeatAfterMinutes': { exempt: timing },
  // The webhook URL comes from deployment settings; switching the message format among presets is free.
  'agentDefaults.stallAlerts.webhook': {
    relax: 'turning the webhook off is held',
    held: (previous, policy) => alertsOf(previous).webhook !== 'off' && alertsOf(policy).webhook === 'off',
  },
  // Recipients are who receives project notices outside Forge.
  'agentDefaults.stallAlerts.email': 'gated',
  'acceptance.mode': 'gated',
  'acceptance.gate': 'gated',
  'acceptance.disjointFastPath': 'gated',
  'acceptance.autoRevert': 'gated',
  'acceptance.hostedCrossHeadReuse': 'gated',
  // Outside the pinned digest so queued landings survive a switch; back to strict needs no one.
  'acceptance.landingMode': {
    relax: 'switching fast landing on is held',
    held: (previous, policy) =>
      landingModeOf(policy) !== 'strict' && landingModeOf(policy) !== landingModeOf(previous),
  },
  'acceptance.scopedRecheck': 'gated',
  'acceptance.landing': 'gated',
  'acceptance.admissionCheck': 'gated',
  'acceptance.batchMaxSize': 'gated',
  'acceptance.batchWindowMs': 'gated',
  'acceptance.autoActors': 'gated',
  'acceptance.protectedPaths': 'gated',
  'acceptance.ownerApprovalPaths': 'gated',
  'checks.runner': 'gated',
  'checks.fallback': 'gated',
  'checks.repo': 'gated',
  'checks.runsOn': 'gated',
  'checks.shards': 'gated',
  'checks.credentialsRef': 'gated',
  'checks.ratesUsdPerMinute': 'gated',
  'checks.concurrency': 'gated',
  'integrationPreview.auto': 'gated',
  ownerRootUpdates: 'gated',
  autoSnapshot: 'gated',
  autoSnapshotIntervalMinutes: 'gated',
  laneUpdates: 'gated',
  'lifecycle.completeOnAccept': 'gated',
  'lifecycle.cleanRegenerableCopies': 'gated',
  'lifecycle.closeOnLand': 'gated',
  'notify.awaySummary': { exempt: "the owner's own away summary" },
};
/** The policy with exempt and relax-only fields removed: everything else, listed or not, is gated. */
function gateView(policy: AutonomyPolicy) {
  const view = JSON.parse(JSON.stringify(policy)) as Record<string, unknown>;
  if (!policy.trust?.enabled) delete view.trust;
  for (const [path, rule] of Object.entries(OWNER_GATE)) {
    if (rule === 'gated') continue;
    const keys = path.split('.');
    let node: Record<string, unknown> | undefined = view;
    for (const key of keys.slice(0, -1)) node = node?.[key] as Record<string, unknown> | undefined;
    if (node) delete node[keys.at(-1)!];
  }
  return pruned(view);
}
/** An object left empty by the removal reads as absent, so adding an exempt field is no change. */
function pruned(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const kept = Object.entries(value)
    .map(([key, item]) => [key, pruned(item)] as const)
    .filter(([, item]) => item !== undefined);
  return kept.length ? Object.fromEntries(kept) : undefined;
}
/** True when an agent sign-in's edit from `previous` to `policy` needs the owner person. */
export const ownerGated = (previous: AutonomyPolicy, policy: AutonomyPolicy) =>
  canonicalPayload(gateView(previous) ?? null) !== canonicalPayload(gateView(policy) ?? null) ||
  Object.values(OWNER_GATE).some(
    rule => typeof rule === 'object' && 'held' in rule && rule.held(previous, policy),
  );
