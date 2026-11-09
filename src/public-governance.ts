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
type CommandLike = { executable: string; args: readonly string[] };
/** A defined check: its command and the optional Actions setup command it runs first. */
export type DefinedCheck = CommandLike & { actions?: { setup?: CommandLike } | undefined };
/** Checks to protect: one check, a list of checks, or entry paths already derived from them. */
export type DefinedChecks = DefinedCheck | readonly (DefinedCheck | string)[] | null | undefined;
/** Repository files every given check command and setup action runs, as manifest paths. */
export function definedCheckEntryPaths(checks: DefinedChecks) {
  const list = !checks ? [] : 'executable' in checks ? [checks] : checks;
  const paths = new Set<string>();
  for (const check of list) {
    if (typeof check === 'string') paths.add(check);
    else
      for (const command of [check, check.actions?.setup])
        for (const path of command ? checkEntryPaths(command) : []) paths.add(path);
  }
  return [...paths].sort();
}
/** Paths that need owner approval by default: the listed ones plus the files every
 * defined check and setup action of the project runs, so any project's check entries
 * are protected, not only Forge's. An explicit `ownerApprovalPaths` list replaces the
 * defaults. */
export function ownerApprovalMatcher(policy: AutonomyPolicy, checks?: DefinedChecks) {
  const explicit = policy.acceptance.ownerApprovalPaths;
  const patterns = (explicit ?? DEFAULT_OWNER_APPROVAL_PATHS).map(globPattern);
  const entries = explicit ? [] : definedCheckEntryPaths(checks);
  const matches = (path: string) => entries.includes(path) || patterns.some(pattern => pattern.test(path));
  return Object.assign(matches, { any: patterns.length + entries.length > 0 });
}
/** Why a landing waits for the owner person, or null. Issue 470ef29b: the owner-approval list holds
 * every agent on every project, the owner's own agents included (an agent signed in with the owner's
 * account is still an agent); only the owner person keeps the fast path. On a public project it also
 * holds contributor persons, who then follow automatic policy like agents. */
export function governanceReason(
  project: { owner: string; visibility?: string },
  policy: AutonomyPolicy,
  actor: AcceptanceActor,
  paths: string[] | null,
  checks?: DefinedChecks,
): string | null {
  if (actor.id === project.owner && actor.kind === 'person') return null;
  const isPublic = project.visibility === 'public';
  if (isPublic || actor.kind === 'agent') {
    const protectedPath = ownerApprovalMatcher(policy, checks);
    if (paths === null && protectedPath.any)
      return 'needs owner approval: protected-path coverage is unavailable';
    const matched = (paths ?? []).filter(path => protectedPath(path));
    if (matched.length) return `needs owner approval: protected paths ${matched.join(', ')}`;
  }
  // Account authentication is not owner approval. Public contributors follow automatic policy.
  return reviewReason(policy, isPublic ? { ...actor, kind: 'agent' } : actor, paths);
}
export const requiresGovernedCheck = (
  project: { owner: string; visibility?: string },
  actor: AcceptanceActor,
) => actor.kind === 'agent' || (project.visibility === 'public' && actor.id !== project.owner);
