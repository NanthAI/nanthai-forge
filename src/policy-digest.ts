// SPDX-License-Identifier: Apache-2.0
import { digest } from './portable-hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import type { AutonomyPolicy } from './autonomy-policy.js';

/** The policy a landing is pinned to. Agent defaults change how agents work, not what is accepted,
 * so editing them never invalidates queued landings. Policies without them digest as before. */
export function acceptancePolicyDigest(policy: AutonomyPolicy) {
  const acceptance = { ...policy };
  delete acceptance.agentDefaults;
  return digest(canonicalPayload(acceptance));
}
