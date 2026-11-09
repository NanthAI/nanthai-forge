// SPDX-License-Identifier: Apache-2.0
/** Global-risk paths for landing on the first (admission) check.
 *
 * A change lands on the check it already passed, after main moved, only when
 * neither side of the composition touches a file that can change how every
 * test, build or check behaves. This is the one list (docs/pre-queue-checks.md
 * names it). It reads paths only, so it works with any CI. A match always
 * keeps today's recheck; so does any doubt.
 */
import { globPattern } from './autonomy-policy.js';
import { isStandardForgeCheck, STANDARD_CHECK_INPUTS } from './standard-check.js';
import { HARNESS_RISK_V4, MOBILE_BUILD_RISK_V6, proseRootText } from './first-check-risk-v4.js';

/** Proofs pin the rule they were decided under: v1 receipts keep v1 decisions, v2 added nested
 * non-JS build inputs, database schema files and sequence folders; v3 keeps v2's list and places a
 * manifest or lockfile inside a package of the pinned package graph (src/package-placement.ts); v4
 * adds test-harness, runner and build files of every ecosystem by shape (src/first-check-risk-v4.ts)
 * and counts a root `.txt` as prose only by name; v5 adds shared fixture and snapshot folders to the
 * sequence-folder rule (Issue c6b81429); v6 adds Xcode project, Gradle script and Swift/Dart tool
 * configuration files (src/first-check-risk-v4.ts, Issue 870791c3). Declared `globalRiskPaths` join
 * the check entries. */
export const FIRST_CHECK_RISK_RULES = [
  'first-check-risk-v1',
  'first-check-risk-v2',
  'first-check-risk-v3',
  'first-check-risk-v4',
  'first-check-risk-v5',
  'first-check-risk-v6',
] as const;
export type FirstCheckRiskRule = (typeof FIRST_CHECK_RISK_RULES)[number];
export const FIRST_CHECK_RISK_RULE: FirstCheckRiskRule = 'first-check-risk-v6';
/** True when `rule` is `from` or a later rule. */
export const riskRuleSince = (rule: FirstCheckRiskRule, from: FirstCheckRiskRule) =>
  FIRST_CHECK_RISK_RULES.indexOf(rule) >= FIRST_CHECK_RISK_RULES.indexOf(from);
const since = riskRuleSince;
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
  ...HARNESS_RISK_V4.map(test => ({
    reason: 'build, lint or test configuration',
    since: 'first-check-risk-v4' as const,
    test,
  })),
  { reason: 'build, lint or test configuration', since: 'first-check-risk-v6', test: MOBILE_BUILD_RISK_V6 },
];

/** A check entry: an exact path, or a glob where `*` stays inside one path
 * segment and `{a,b}` is a choice (no nesting). A declared global-risk glob may also
 * use `**`, `?` and `[...]`; one that does not compile matches every path (widen). */
function entryMatcher(entry: string): (path: string) => boolean {
  if (/\*\*|[?[]/.test(entry)) {
    try {
      const pattern = globPattern(entry);
      return path => pattern.test(path);
    } catch {
      return () => true;
    }
  }
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

/** Root files are configuration unless they are plain prose. Before v4 every root `.txt` was prose;
 * from v4 only a prose name is (a root `constraints.txt` or `CMakeLists.txt` is a build input). */
const rootConfig = (path: string, rule: FirstCheckRiskRule) =>
  !path.includes('/') &&
  !/\.md$/i.test(path) &&
  !(/\.txt$/i.test(path) && (!since(rule, 'first-check-risk-v4') || proseRootText(path)));

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
  if (rootConfig(path, rule)) return 'root configuration';
  return (
    patterns.find(pattern => (!pattern.since || since(rule, pattern.since)) && pattern.test.test(path))
      ?.reason ?? null
  );
}

/** A folder whose files are applied in order, so two sides that each add one cannot both be right
 * without a look: Django/Rails/Flyway/Prisma `migrations`, `db/migrate`, Alembic `versions`.
 * The key is the folder itself; files below it (Prisma's one folder per migration) share it. */
const SEQUENCE_FOLDER = /^(.*?(?:^|\/)(?:migrations?|db\/migrate|alembic\/versions))\//;
/** v5 (Issue c6b81429, hermeticity): a folder tests read as a whole. A snapshot runner fails on an
 * obsolete or unexpected snapshot, and fixture, golden and recorded-cassette folders are often listed
 * or globbed by the tests that read them, so two sides that each add or edit a file in one can break
 * a test neither ran with the other's file. The key is the outermost such folder. */
const SHARED_TEST_FOLDER =
  /^(.*?(?:^|\/)(?:__snapshots__|__fixtures__|fixtures?|snapshots?|testdata|test-?data|goldens?|golden-?files|cassettes))\//;
const foldersOf = (paths: readonly string[], rule: FirstCheckRiskRule) =>
  new Set(
    paths
      .map(
        path =>
          SEQUENCE_FOLDER.exec(path)?.[1] ??
          (since(rule, 'first-check-risk-v5') ? SHARED_TEST_FOLDER.exec(path)?.[1] : undefined),
      )
      .filter((folder): folder is string => !!folder),
  );

/** v2: both sides changed files in the same sequence folder (paths only; a disjoint
 * `0005_a.py` and `0005_b.py` is exactly this). Earlier rules had no such check. v5 adds fixture,
 * snapshot, golden and test-data folders. */
export function sharedSequenceFolders(
  candidatePaths: readonly string[],
  mainPaths: readonly string[],
  rule: FirstCheckRiskRule = FIRST_CHECK_RISK_RULE,
): string[] {
  if (!since(rule, 'first-check-risk-v2')) return [];
  const main = foldersOf(mainPaths, rule);
  return [...foldersOf(candidatePaths, rule)].filter(folder => main.has(folder));
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

/** Entry files of a check run: its command's entries (above, same order), then those of the
 * Actions setup command it runs first, which can change every result just as the check script can
 * (the same files governance protects, src/public-governance.ts definedCheckEntryPaths), then the
 * definition's declared `globalRiskPaths` globs (risk only; governance does not protect them). */
export function checkRunEntryPaths(check: {
  executable: string;
  args: readonly string[];
  actions?: { setup?: { executable: string; args: readonly string[] } | undefined } | undefined;
  globalRiskPaths?: readonly string[] | undefined;
}) {
  const paths = checkEntryPaths(check);
  const setup = check.actions?.setup;
  for (const path of [...(setup ? checkEntryPaths(setup) : []), ...(check.globalRiskPaths ?? [])])
    if (!paths.includes(path)) paths.push(path);
  return paths;
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
