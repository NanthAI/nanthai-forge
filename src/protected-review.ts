// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { AcceptanceActor, AutonomyPolicy } from './autonomy-policy.js';
import { governanceReason, protectedPathMatches } from './public-governance.js';
import { SECRET_SCAN_ALLOW_FILE } from './secret-allow.js';

/** Item fe2b0a86: what an owner's protected-path approval is bound to when main moves under a held
 * submission. Present only when the hold is provably about protected paths alone; otherwise the
 * whole changed-file list must match, as before. */
export type ReviewProtect = {
  acceptance: Pick<AutonomyPolicy['acceptance'], 'ownerApprovalPaths' | 'protectedPaths'>;
  checkEntries: string[];
};

/** The protected scope for comparing an approved Candidate with its recomposition, or undefined
 * (fail closed: compare every changed file). Both Candidates' changed paths must be known, each
 * must touch a protected path, and nothing but those paths may hold it for a person: with the
 * protected paths removed, the same policy would accept the rest without review. Check entries
 * must be the project's derived list, so no check entry can fall outside the matcher. */
export function reviewProtect(
  project: { owner: string; visibility?: string },
  policy: Pick<AutonomyPolicy, 'acceptance'>,
  actorId: string,
  paths: (string[] | null)[],
  checkEntries: string[] | undefined,
): ReviewProtect | undefined {
  if (!checkEntries || !paths.length) return undefined;
  // The agent reading is the strict one: a person can only remove reasons, never add them.
  const actor: AcceptanceActor = { kind: 'agent', id: actorId };
  const scope: ReviewProtect = {
    acceptance: {
      protectedPaths: policy.acceptance.protectedPaths,
      ...(policy.acceptance.ownerApprovalPaths
        ? { ownerApprovalPaths: policy.acceptance.ownerApprovalPaths }
        : {}),
    },
    checkEntries,
  };
  for (const list of paths) {
    if (list === null) return undefined;
    const matched = new Set(
      protectedPathMatches(scope as unknown as Pick<AutonomyPolicy, 'acceptance'>, list, checkEntries),
    );
    if (!matched.size) return undefined;
    const rest = list.filter(path => !matched.has(path));
    if (governanceReason(project, policy, actor, rest, checkEntries) !== null) return undefined;
  }
  return scope;
}

/** The changed-file entries an approval is bound to under `scope`: every protected path (with its
 * before and after content, so a main change to an approved file always asks again) and the
 * secret-allow file, whose additions the owner also saw. */
export function protectedEntries<T extends { path: string }>(files: readonly T[], scope: ReviewProtect): T[] {
  const matched = new Set(
    protectedPathMatches(
      scope as unknown as Pick<AutonomyPolicy, 'acceptance'>,
      files.map(file => file.path),
      scope.checkEntries,
    ),
  );
  return files.filter(file => matched.has(file.path) || file.path === SECRET_SCAN_ALLOW_FILE);
}

/** Item fe2b0a86 part B: the protected scope for reusing an earlier submission's owner approval of the
 * same work. Unlike reviewProtect it does not require the hold to be about protected paths alone: only
 * the protected reason is lifted, so every other reason still holds. Undefined (no reuse) when either
 * Candidate's changed paths or the project's derived check entries are unknown, or either Candidate
 * touches no protected path. */
export function carryScope(
  policy: Pick<AutonomyPolicy, 'acceptance'>,
  paths: (string[] | null)[],
  checkEntries: string[] | undefined,
): ReviewProtect | undefined {
  if (!checkEntries || paths.length !== 2) return undefined;
  const scope: ReviewProtect = {
    acceptance: {
      protectedPaths: policy.acceptance.protectedPaths,
      ...(policy.acceptance.ownerApprovalPaths
        ? { ownerApprovalPaths: policy.acceptance.ownerApprovalPaths }
        : {}),
    },
    checkEntries,
  };
  for (const list of paths) if (list === null || !protectedPaths(scope, list).length) return undefined;
  return scope;
}

/** The changed paths `scope` protects (the paths an earlier owner approval may stand for). */
export function protectedPaths(scope: ReviewProtect, paths: readonly string[]): string[] {
  return (
    protectedPathMatches(
      scope as unknown as Pick<AutonomyPolicy, 'acceptance'>,
      [...paths],
      scope.checkEntries,
    ) ?? []
  );
}
