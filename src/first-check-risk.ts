// SPDX-License-Identifier: Apache-2.0
/** Global-risk paths for landing on the first (admission) check.
 *
 * A change lands on the check it already passed, after main moved, only when
 * neither side of the composition touches a file that can change how every
 * test, build or check behaves. This is the one list (docs/pre-queue-checks.md
 * names it). It reads paths only, so it works with any CI. A match always
 * keeps today's recheck; so does any doubt.
 */
export const FIRST_CHECK_RISK_RULE = 'first-check-risk-v1';
const patterns: { reason: string; test: RegExp }[] = [
  // Package manifests and lockfiles, for the common ecosystems.
  {
    reason: 'package manifest or lockfile',
    test: /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|pnpm-(?:lock|workspace)\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc(?:\.yml)?|Cargo\.(?:toml|lock)|go\.(?:mod|sum|work)|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(?:\.lock)?|requirements[^/]*\.txt|setup\.(?:py|cfg)|Gemfile(?:\.lock)?|composer\.(?:json|lock)|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradle\.properties)$/,
  },
  // TypeScript, build, lint, format and test runner configuration.
  {
    reason: 'build, lint or test configuration',
    test: /(?:^|\/)(?:tsconfig[^/]*\.json|jsconfig\.json|[^/]+\.config\.[cm]?[jt]s|\.oxlintrc[^/]*|\.oxfmtrc[^/]*|\.eslintrc[^/]*|eslint\.config\.[^/]+|\.prettierrc[^/]*|\.babelrc[^/]*|babel\.config\.[^/]+|\.swcrc|\.editorconfig|\.nvmrc|\.node-version|\.tool-versions|Makefile|Dockerfile)$/,
  },
  // CI configuration, on any provider.
  {
    reason: 'CI configuration',
    test: /^(?:\.github\/|\.gitlab-ci\.yml$|\.gitlab\/|\.circleci\/|\.buildkite\/|\.forgejo\/|\.woodpecker|Jenkinsfile$|azure-pipelines\.yml$|bitbucket-pipelines\.yml$)/,
  },
  // This repository's check scripts, check contract and shared test runtime.
  {
    reason: 'check script or check contract',
    test: /^(?:scripts\/(?:forge-check|verify|verify-queue|github-actions-check|check-contract|check-path-scopes|check-foundation|test-[^/]+)\.(?:[cm]?[jt]s|d\.m?ts)|tests\/(?:check-runtime|worker-budget)\.mjs)$/,
  },
  // Database schema.
  { reason: 'database schema', test: /(?:^|\/)(?:convex\/schema\.ts|schema\.prisma)$/ },
];

/** Root files are configuration unless they are plain prose. */
const rootConfig = (path: string) => !path.includes('/') && !/\.(?:md|txt)$/i.test(path);

/** Reason the path is global-risk, or null. `checkEntries` are the files the
 * project's check definition runs (its own data, any runner). */
export function firstCheckRisk(path: string, checkEntries: readonly string[] = []): string | null {
  if (checkEntries.includes(path)) return 'check script or check contract';
  if (rootConfig(path)) return 'root configuration';
  return patterns.find(pattern => pattern.test.test(path))?.reason ?? null;
}

export function firstCheckRiskPaths(paths: readonly string[], checkEntries: readonly string[] = []) {
  return paths.filter(path => firstCheckRisk(path, checkEntries) !== null);
}
