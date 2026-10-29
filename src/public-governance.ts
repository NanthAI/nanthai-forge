// SPDX-License-Identifier: Apache-2.0
import { globPattern, reviewReason, type AutonomyPolicy, type AcceptanceActor } from './autonomy-policy.js';

export const DEFAULT_OWNER_APPROVAL_PATHS = [
  '.github/**',
  'scripts/forge-check.mjs',
  '.forge/**',
  // Source-controlled check/runner and future deployment definitions live here.
  'forge.config.*',
  'netlify.toml',
  'netlify/**',
  'scripts/deploy*',
  'scripts/deploy/**',
];
export function governanceReason(
  project: { owner: string; visibility?: string },
  policy: AutonomyPolicy,
  actor: AcceptanceActor,
  paths: string[] | null,
  ownerInputs = false,
): string | null {
  if (project.visibility !== 'public') return reviewReason(policy, actor, paths);
  const owner = actor.id === project.owner;
  if (owner && actor.kind === 'person') return null;
  if (!owner || !ownerInputs) {
    const patterns = (policy.acceptance.ownerApprovalPaths ?? DEFAULT_OWNER_APPROVAL_PATHS).map(globPattern);
    if (paths === null && patterns.length)
      return 'needs owner approval: protected-path coverage is unavailable';
    const matched = (paths ?? []).filter(path => patterns.some(pattern => pattern.test(path)));
    if (matched.length) return `needs owner approval: protected paths ${matched.join(', ')}`;
  }
  // Account authentication is not owner approval. Contributors follow automatic policy.
  return reviewReason(policy, { ...actor, kind: 'agent' }, paths);
}
export const requiresGovernedCheck = (
  project: { owner: string; visibility?: string },
  actor: AcceptanceActor,
) => actor.kind === 'agent' || (project.visibility === 'public' && actor.id !== project.owner);
