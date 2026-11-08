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
export function governanceReason(
  project: { owner: string; visibility?: string },
  policy: AutonomyPolicy,
  actor: AcceptanceActor,
  paths: string[] | null,
  ownerInputs = false,
  checks?: DefinedChecks,
): string | null {
  if (project.visibility !== 'public') return reviewReason(policy, actor, paths);
  const owner = actor.id === project.owner;
  if (owner && actor.kind === 'person') return null;
  if (!owner || !ownerInputs) {
    const protectedPath = ownerApprovalMatcher(policy, checks);
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
