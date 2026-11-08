// SPDX-License-Identifier: Apache-2.0
import { checkEntryPaths } from './first-check-risk.js';
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
/** Paths that need owner approval by default: the listed ones plus the files the
 * project's own check runs, so any project's check entry is protected, not only
 * Forge's. An explicit `ownerApprovalPaths` list replaces the defaults. */
export function ownerApprovalMatcher(
  policy: AutonomyPolicy,
  check?: { executable: string; args: readonly string[] } | null,
) {
  const explicit = policy.acceptance.ownerApprovalPaths;
  const patterns = (explicit ?? DEFAULT_OWNER_APPROVAL_PATHS).map(globPattern);
  const entries = explicit || !check ? [] : checkEntryPaths(check);
  const matches = (path: string) => entries.includes(path) || patterns.some(pattern => pattern.test(path));
  return Object.assign(matches, { any: patterns.length + entries.length > 0 });
}
export function governanceReason(
  project: { owner: string; visibility?: string },
  policy: AutonomyPolicy,
  actor: AcceptanceActor,
  paths: string[] | null,
  ownerInputs = false,
  check?: { executable: string; args: readonly string[] } | null,
): string | null {
  if (project.visibility !== 'public') return reviewReason(policy, actor, paths);
  const owner = actor.id === project.owner;
  if (owner && actor.kind === 'person') return null;
  if (!owner || !ownerInputs) {
    const protectedPath = ownerApprovalMatcher(policy, check);
    if (paths === null && protectedPath.any)
      return 'needs owner approval: protected-path coverage is unavailable';
    const matched = (paths ?? []).filter(path => protectedPath(path));
    if (matched.length) return `needs owner approval: protected paths ${matched.join(', ')}`;
  }
  // Account authentication is not owner approval. Contributors follow automatic policy.
  return reviewReason(policy, { ...actor, kind: 'agent' }, paths);
}
export const requiresGovernedCheck = (
  project: { owner: string; visibility?: string },
  actor: AcceptanceActor,
) => actor.kind === 'agent' || (project.visibility === 'public' && actor.id !== project.owner);
