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

/** Proofs pin the rule they were decided under: v1 receipts keep v1 decisions, new ones use v2
 * (nested non-JS build inputs, database schema files and sequence folders). */
export const FIRST_CHECK_RISK_RULES = ['first-check-risk-v1', 'first-check-risk-v2'] as const;
export type FirstCheckRiskRule = (typeof FIRST_CHECK_RISK_RULES)[number];
export const FIRST_CHECK_RISK_RULE: FirstCheckRiskRule = 'first-check-risk-v2';
const since = (rule: FirstCheckRiskRule, from: FirstCheckRiskRule) =>
  FIRST_CHECK_RISK_RULES.indexOf(rule) >= FIRST_CHECK_RISK_RULES.indexOf(from);
const patterns: { reason: string; test: RegExp; since?: FirstCheckRiskRule }[] = [
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
  // v2: build inputs of other ecosystems at any depth (root files are already root configuration).
  {
    reason: 'build, lint or test configuration',
    since: 'first-check-risk-v2',
    test: new RegExp(
      '(?:^|/)(?:' +
        [
          // Rust
          'build\\.rs|rust-toolchain(?:\\.toml)?|\\.cargo/config(?:\\.toml)?',
          // Python
          'conftest\\.py|pytest\\.ini|tox\\.ini|noxfile\\.py|mypy\\.ini|\\.python-version',
          // Gradle
          'gradle/libs\\.versions\\.toml|[^/]+\\.versions\\.toml|gradle-wrapper\\.properties|buildSrc/.*',
          // Bazel
          'BUILD(?:\\.bazel)?|WORKSPACE(?:\\.bazel)?|MODULE\\.bazel|\\.bazelrc|[^/]+\\.bzl',
          // CMake
          'CMakeLists\\.txt|CMakePresets\\.json|[^/]+\\.cmake',
          // Go
          'go\\.work\\.sum',
        ].join('|') +
        ')$',
    ),
  },
  {
    // .NET project, solution and central-package files; their names are mixed-case in the wild.
    reason: 'build, lint or test configuration',
    since: 'first-check-risk-v2',
    test: /(?:^|\/)(?:[^/]+\.(?:cs|fs|vb)proj|[^/]+\.slnx?|Directory\.(?:Build\.(?:props|targets)|Packages\.props)|packages\.lock\.json|global\.json|nuget\.config)$/i,
  },
  {
    reason: 'database schema',
    since: 'first-check-risk-v2',
    test: /(?:^|\/)(?:schema\.(?:rb|sql)|structure\.sql)$/,
  },
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
export function firstCheckRisk(
  path: string,
  checkEntries: readonly string[] = [],
  rule: FirstCheckRiskRule = FIRST_CHECK_RISK_RULE,
): string | null {
  return riskOf(path, checkEntries.map(entryMatcher), rule);
}
function riskOf(
  path: string,
  entries: ((path: string) => boolean)[],
  rule: FirstCheckRiskRule,
): string | null {
  if (entries.some(entry => entry(path))) return 'check script or check contract';
  if (rootConfig(path)) return 'root configuration';
  return (
    patterns.find(pattern => (!pattern.since || since(rule, pattern.since)) && pattern.test.test(path))
      ?.reason ?? null
  );
}

/** A folder whose files are applied in order, so two sides that each add one cannot both be right
 * without a look: Django/Rails/Flyway/Prisma `migrations`, `db/migrate`, Alembic `versions`.
 * The key is the folder itself; files below it (Prisma's one folder per migration) share it. */
const SEQUENCE_FOLDER = /^(.*?(?:^|\/)(?:migrations?|db\/migrate|alembic\/versions))\//;
const sequenceFolders = (paths: readonly string[]) =>
  new Set(paths.map(path => SEQUENCE_FOLDER.exec(path)?.[1]).filter((folder): folder is string => !!folder));

/** v2: both sides changed files in the same sequence folder (paths only; a disjoint
 * `0005_a.py` and `0005_b.py` is exactly this). Earlier rules had no such check. */
export function sharedSequenceFolders(
  candidatePaths: readonly string[],
  mainPaths: readonly string[],
  rule: FirstCheckRiskRule = FIRST_CHECK_RISK_RULE,
): string[] {
  if (!since(rule, 'first-check-risk-v2')) return [];
  const main = sequenceFolders(mainPaths);
  return [...sequenceFolders(candidatePaths)].filter(folder => main.has(folder));
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

export function firstCheckRiskPaths(
  paths: readonly string[],
  checkEntries: readonly string[] = [],
  rule: FirstCheckRiskRule = FIRST_CHECK_RISK_RULE,
) {
  const entries = checkEntries.map(entryMatcher);
  return paths.filter(path => riskOf(path, entries, rule) !== null);
}

/** True when the two sides' changes together are global-risk under `rule`. */
export function globalRiskBetween(
  candidatePaths: readonly string[],
  mainPaths: readonly string[],
  checkEntries: readonly string[] = [],
  rule: FirstCheckRiskRule = FIRST_CHECK_RISK_RULE,
) {
  return (
    firstCheckRiskPaths([...candidatePaths, ...mainPaths], checkEntries, rule).length > 0 ||
    sharedSequenceFolders(candidatePaths, mainPaths, rule).length > 0
  );
}
