// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { effectiveOwnerApprovalPaths } from './owner-approval-paths.js';
export { DEFAULT_OWNER_APPROVAL_PATHS } from './owner-approval-paths.js';
import { checkEntryPaths } from './first-check-risk.js';
import {
  globPattern,
  reviewReason,
  protectedMatches,
  type AutonomyPolicy,
  type AcceptanceActor,
} from './autonomy-policy.js';

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
 * defined check and setup action of the project runs. An explicit `ownerApprovalPaths`
 * list replaces the built-in list; derived check entries remain protected. */
export function ownerApprovalMatcher(policy: Pick<AutonomyPolicy, 'acceptance'>, checks?: DefinedChecks) {
  const patterns = effectiveOwnerApprovalPaths(policy.acceptance.ownerApprovalPaths).map(globPattern);
  const entries = definedCheckEntryPaths(checks);
  const matches = (path: string) => entries.includes(path) || patterns.some(pattern => pattern.test(path));
  return Object.assign(matches, { any: patterns.length + entries.length > 0 });
}
/** Paths held by either existing protection list, including derived check entries. */
export function protectedPathMatches(
  policy: Pick<AutonomyPolicy, 'acceptance'>,
  paths: string[] | null,
  checks?: DefinedChecks,
) {
  if (paths === null) return null;
  const owner = ownerApprovalMatcher(policy, checks);
  const protectedPaths = new Set(protectedMatches(policy, paths));
  return paths.filter(path => owner(path) || protectedPaths.has(path));
}
/** Why a landing waits for the owner person, or null. Issue 470ef29b: the owner-approval list holds
 * every agent on every project, the owner's own agents included (an agent signed in with the owner's
 * account is still an agent); only the owner person keeps the fast path. Contributor persons
 * follow automatic policy on private and public projects. */
export function governanceReason(
  project: { owner: string; visibility?: string },
  policy: Pick<AutonomyPolicy, 'acceptance'>,
  actor: AcceptanceActor,
  paths: string[] | null,
  checks?: DefinedChecks,
  uncheckedPerson = false,
): string | null {
  if (actor.id === project.owner && actor.kind === 'person') return null;
  const protectedPath = ownerApprovalMatcher(policy, checks);
  if (paths === null && protectedPath.any)
    return 'needs owner approval: protected-path coverage is unavailable';
  const matched = (paths ?? []).filter(path => protectedPath(path));
  if (matched.length) return `needs owner approval: protected paths ${matched.join(', ')}`;
  // Only explicitly permitted unchecked people skip automatic review; protected paths still apply.
  return reviewReason(
    policy,
    actor.id !== project.owner && !uncheckedPerson ? { ...actor, kind: 'agent' } : actor,
    paths,
  );
}

export type ProtectedPathPolicy = Pick<AutonomyPolicy, 'acceptance'> & { checkEntries: string[] };

/** The acceptance rule owns matching and the hold; this is only its early explanation for agents.
 * Bound the reply, not the operation: every path still receives the existing policy at acceptance. */
export function protectedPathNotice(policy: ProtectedPathPolicy, paths: string[] | null) {
  const matched = protectedPathMatches(policy, paths, policy.checkEntries);
  const owner = ownerApprovalMatcher(policy, policy.checkEntries);
  if (matched === null && !owner.any && !policy.acceptance.protectedPaths.length) return undefined;
  if (matched?.length === 0) return undefined;
  const reason = governanceReason(
    { owner: '' },
    policy,
    { id: '', kind: 'agent' },
    paths,
    policy.checkEntries,
  );
  if (!reason) return undefined;
  const approver = matched?.some(path => owner(path))
    ? 'project owner (a person)'
    : 'a person allowed to accept';
  let bytes = 0;
  const shown = (matched ?? [])
    .filter(path => {
      bytes += path.length;
      return bytes <= 1200;
    })
    .slice(0, 10);
  return {
    message:
      matched === null
        ? 'Landing may need protected-path approval; path coverage is unavailable. Read policy for the configured approver.'
        : `Landing will need approval from ${approver} under the current protected-path policy.`,
    paths: shown,
    more: (matched?.length ?? 0) - shown.length,
    coverage: matched === null ? ('unavailable' as const) : ('complete' as const),
  };
}
