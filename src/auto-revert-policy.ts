// SPDX-License-Identifier: Apache-2.0
import type { AutonomyPolicy } from './autonomy-policy.js';
import { governanceReason, type DefinedChecks } from './public-governance.js';

/** Absent keeps the automatic revert of a proven culprit on; only `false` turns it off. */
export const autoRevertEnabled = (policy: AutonomyPolicy) => policy.acceptance.autoRevert !== false;

/** Why a proven culprit's reverse must wait for a person, or null. It applies the landing queue's own
 * rule for the owner's agent (owner-approval and protected paths, unknown coverage) to the culprit's
 * paths when retained and to the reverse's actual paths, so nothing is checked or landed that the
 * queue would only hold afterwards. */
export function autoRevertHold(input: {
  project: { owner: string; visibility?: string };
  policy: AutonomyPolicy;
  culpritPaths: string[] | null;
  reversePaths: string[] | null;
  checks?: DefinedChecks;
}): string | null {
  const actor = { id: input.project.owner, kind: 'agent' as const };
  const reasons = [
    input.culpritPaths &&
      governanceReason(input.project, input.policy, actor, input.culpritPaths, input.checks),
    governanceReason(input.project, input.policy, actor, input.reversePaths, input.checks),
  ].filter((reason): reason is string => !!reason);
  return reasons.length ? [...new Set(reasons)].join('; ') : null;
}
