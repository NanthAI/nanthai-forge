// SPDX-License-Identifier: Apache-2.0
import { digest } from './portable-hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import type { AutonomyPolicy } from './autonomy-policy.js';

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
