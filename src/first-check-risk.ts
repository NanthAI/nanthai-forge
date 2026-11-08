// SPDX-License-Identifier: Apache-2.0
/** Global-risk paths for landing on the first (admission) check.
 *
 * A change lands on the check it already passed, after main moved, only when
 * neither side of the composition touches a file that can change how every
 * test, build or check behaves. This is the one list (docs/pre-queue-checks.md
 * names it). It reads paths only, so it works with any CI. A match always
 * keeps today's recheck; so does any doubt.
 */
import { isStandardForgeCheck, STANDARD_CHECK_INPUTS } from './standard-check.js';

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
  // The check contract Forge's Actions executor reads from every Candidate, before any check
  // command (scripts/check-contract.mjs, CHECK_CONTRACT_MISMATCH), whatever the repository.
  { reason: 'check script or check contract', test: /^scripts\/check-contract\.mjs$/ },
  // Database schema.
  { reason: 'database schema', test: /(?:^|\/)(?:convex\/schema\.ts|schema\.prisma)$/ },
];

/** A check entry: an exact path, or a glob where `*` stays inside one path
 * segment and `{a,b}` is a choice (no nesting). */
function entryMatcher(entry: string): (path: string) => boolean {
  if (!/[*{]/.test(entry)) return path => path === entry;
  let source = '';
  for (const part of entry.split(/(\{[^{}]*\}|\*)/))
    if (part === '*') source += '[^/]*';
    else if (part.startsWith('{') && part.endsWith('}'))
      source += `(?:${part.slice(1, -1).split(',').map(segmentGlob).join('|')})`;
    else source += segmentGlob(part);
  const pattern = new RegExp(`^${source}$`);
  return path => pattern.test(path);
}
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const segmentGlob = (text: string) => text.split('*').map(escapeRegExp).join('[^/]*');

/** Root files are configuration unless they are plain prose. */
const rootConfig = (path: string) => !path.includes('/') && !/\.(?:md|txt)$/i.test(path);

/** Reason the path is global-risk, or null. `checkEntries` are the files the
 * project's check definition runs (its own data, any runner). */
export function firstCheckRisk(path: string, checkEntries: readonly string[] = []): string | null {
  return riskOf(path, checkEntries.map(entryMatcher));
}
function riskOf(path: string, entries: ((path: string) => boolean)[]): string | null {
  if (entries.some(entry => entry(path))) return 'check script or check contract';
  if (rootConfig(path)) return 'root configuration';
  return patterns.find(pattern => pattern.test.test(path))?.reason ?? null;
}

/** Repository files a check command names: its executable and arguments, and any
 * path inside a shell string (`bash -c "./ci/run.sh && …"`), as manifest paths. A
 * path-free command (`npm test`, `make check`) names none; its manifest or Makefile
 * is already global-risk. Absolute paths and `..` leave the repository. Forge's
 * standard check adds the extra inputs it declares (src/standard-check.ts). */
export function checkEntryPaths(check: { executable: string; args: readonly string[] }) {
  const paths = new Set<string>();
  for (const word of [check.executable, ...check.args].flatMap(text => text.split(/[\s;&|()<>'"`=,]+/))) {
    const path = word.replace(/^(?:\.\/)+/, '');
    if (/^[\w.-]+(?:\/[\w.-]+)+$/.test(path) && !path.split('/').some(part => part === '.' || part === '..'))
      paths.add(path);
  }
  if (isStandardForgeCheck(check)) for (const input of STANDARD_CHECK_INPUTS) paths.add(input);
  return [...paths];
}

export function firstCheckRiskPaths(paths: readonly string[], checkEntries: readonly string[] = []) {
  const entries = checkEntries.map(entryMatcher);
  return paths.filter(path => riskOf(path, entries) !== null);
}
