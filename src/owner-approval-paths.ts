// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
export const DEFAULT_OWNER_APPROVAL_PATHS = [
  '.github/**',
  '.gitlab-ci.yml',
  '.gitlab/**',
  '.circleci/**',
  '.buildkite/**',
  '.forgejo/**',
  '.woodpecker.{yml,yaml}',
  '.woodpecker/**',
  'Jenkinsfile',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  '.forge/**',
  'forge.config.*',
];
const oldDefaultOwnerApprovalPaths = [
  '.github/**',
  'scripts/forge-check.mjs',
  '.forge/**',
  'forge.config.*',
  'netlify.toml',
  'netlify/**',
  'scripts/deploy*',
  'scripts/deploy/**',
];

/** Interpret a stored copy of the previous defaults using today's defaults. */
export function effectiveOwnerApprovalPaths(explicit: readonly string[] | undefined): readonly string[] {
  const usesDefault =
    !explicit ||
    (explicit.length === oldDefaultOwnerApprovalPaths.length &&
      explicit.every((path, i) => path === oldDefaultOwnerApprovalPaths[i]));
  return usesDefault ? DEFAULT_OWNER_APPROVAL_PATHS : explicit;
}
