// SPDX-License-Identifier: Apache-2.0
import { changeSalt, stableKey } from '../scripts/test-tiebreak.mjs';
import { globRegExp } from './path-glob.js';
import { safeRelative } from './safe-relative.js';
import { documentationPath } from './prose-paths.js';
import type { PackageGraph } from './package-graph.js';
import {
  FILES_PLACEHOLDER,
  NODE_GLOBS,
  commandRunner,
  scriptRunners,
  type RunnerPart,
} from './test-script-runner.js';
export { FILES_PLACEHOLDER, SCRIPT_DEPTH, type RunnerPart } from './test-script-runner.js';
import { declaredPreflight } from './project-config.js';
import { STANDARD_CHECK_ENTRY } from './standard-check.js';

/** How a project runs its test files: which paths are tests (`globs`) and the argv that runs some of
 * them (`command`; an element `{files}` expands to the files, else they are appended). Preflight, the
 * `tests` read, Intent contract tests and semantic union tests all use it, for every project.
 *
 * Resolution, first match wins, and never runs repository code:
 * 1. declared: `preflight.tests` `{ glob: string | string[], command: string[] }` in a root
 *    `forge.json` (any language) or under `forge` in package.json (declaring it in both is an error);
 * 2. inferred from the package.json `test` script: `node --test [globs]`, `tsx --test [globs]`,
 *    `vitest`, `jest`, through named scripts (`npm run NAME`, `npm test`, `pnpm NAME`, `yarn NAME`,
 *    `run-s`; src/test-script-runner.ts), every runner of a chained script kept (`parts`);
 * 3. no `test` script: a `vitest` or `jest` dependency, else, in a project with a package.json, files
 *    that match Node's own test file patterns (the only runner that needs no dependency; without a
 *    package.json, `.js` fixtures under `test/` do not make a Go or Python repository a Node one);
 * 4. when the caller supplies the manifest package graph (src/package-graph.ts): each ecosystem's own
 *    command per affected package (`go test`, `cargo test -p`, pytest, Gradle, Maven, `dotnet test`,
 *    the workspace package manager), when that command is unambiguous.
 * An unrecognized `test` script (a task runner, make, another language) is not guessed: tests are
 * `unavailable` with a reason, never Forge's layout. `layout: 'forge-node'` (Node's runner over
 * `tests/*.test.mjs`) keeps Forge's import-graph selector and is never inferred from that file
 * layout alone: a project declares it, or it has Forge's own check entry (STANDARD_CHECK_ENTRY);
 * an outside `node --test` project with the same folders gets the generic runner. `packages` runs package commands; any other
 * runner selects by path and, in local preflight, by a generic JS/TS import graph (src/js-import-graph.ts). */
export type TestRunner = {
  source: 'declared' | 'test-script' | 'dependency' | 'files' | 'package-graph';
  program: 'node' | 'tsx' | 'vitest' | 'jest' | 'declared' | 'packages' | 'chained';
  /** Every runner's globs (the union for a chained script). */
  globs: string[];
  /** The argv (for a chained script, its first runner's; `runnerCommand` routes files by `parts`). */
  command: string[];
  /** A chained script's runners (`npm run a && npm run b`), each with its own globs and command. */
  parts?: RunnerPart[];
  layout: 'forge-node' | 'generic' | 'packages';
  /** Where a declared runner was found. */
  declaredIn?: 'forge.json' | 'package.json';
  /** Ecosystems whose package commands run (`layout: 'packages'`). */
  ecosystems?: string[];
  /** `layout: 'packages'` in a checked-out workspace: each named test file's package command (an argv),
   * or why that file has none. Filled by src/workspace-test-runner.ts for the Intent union rerun. */
  fileCommands?: Record<string, string[] | { unavailable: string }>;
};
export type RunnerOptions = {
  /** Text of the root forge.json, when the head has one. */
  forgeJson?: string | undefined;
  /** The head's package graph, built only when rules 1-3 find no runner. */
  packages?: (() => PackageGraph) | undefined;
};
export type TestRunnerResolution =
  | { status: 'available'; runner: TestRunner }
  | { status: 'unavailable'; reason: string };

export const FORGE_TEST_GLOB = 'tests/*.test.mjs';
const DECLARE =
  'declare preflight.tests {"glob":[…],"command":[…,"{files}"]} in a root forge.json (any language), or forge.preflight.tests in package.json';
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length && value.every(item => typeof item === 'string' && item)
    ? (value as string[])
    : null;

/** Paths a runner never reads as tests: installed packages and hidden folders. */
const ignored = (path: string) =>
  path.split('/').some(part => part === 'node_modules' || part.startsWith('.'));
const matcher = (globs: string[]) => {
  const patterns = globs.map(globRegExp);
  return (path: string) =>
    safeRelative(path) && !ignored(path) && patterns.some(pattern => pattern.test(path));
};

/** Whether `path` is one of this runner's test files. */
export function runnerTestPath(runner: TestRunner, path: string) {
  return matcher(runner.globs)(path);
}

const expand = (command: string[], files: string[]) => {
  const at = command.indexOf(FILES_PLACEHOLDER);
  return at < 0 ? [...command, ...files] : [...command.slice(0, at), ...files, ...command.slice(at + 1)];
};
const shellWord = (word: string) =>
  /^[A-Za-z0-9_./=@:,+-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

/** The argv that runs exactly `files` with this runner. A chained script's runner sends each file to
 * the first of its `parts` whose globs match; files of several parts run as one `sh -c` line. */
export function runnerCommand(runner: Pick<TestRunner, 'command' | 'parts'>, files: string[]) {
  if (!files.length) throw new Error('No test files selected; refusing to run the default suite.');
  if (!runner.parts?.length) return expand(runner.command, files);
  const matchers = runner.parts.map(part => matcher(part.globs));
  const groups = runner.parts.map(() => [] as string[]);
  for (const file of files)
    groups[
      Math.max(
        0,
        matchers.findIndex(test => test(file)),
      )
    ]!.push(file);
  const argvs = runner.parts.flatMap((part, i) =>
    groups[i]!.length ? [expand(part.command, groups[i]!)] : [],
  );
  return argvs.length === 1
    ? argvs[0]!
    : ['sh', '-c', argvs.map(argv => argv.map(shellWord).join(' ')).join(' && ')];
}

// Forge's own Node layout is `node --test` itself: another program (tsx) keeps its own command.
// `shape` is true when the project declared the runner or has Forge's own check entry; a file
// layout of `tests/*.test.mjs` alone is any Node library's, and Forge's selector must not plan it.
const layout = (program: TestRunner['program'], globs: string[], shape: boolean): TestRunner['layout'] =>
  shape && program === 'node' && globs.length === 1 && globs[0] === FORGE_TEST_GLOB
    ? 'forge-node'
    : 'generic';

/** The package manager's way to run an installed binary, from `packageManager` or the lockfile. */
function execPrefix(manifest: Record<string, unknown>, paths: Set<string>) {
  const declared = typeof manifest.packageManager === 'string' ? manifest.packageManager : '';
  if (declared.startsWith('pnpm@') || paths.has('pnpm-lock.yaml')) return ['pnpm', 'exec'];
  if (declared.startsWith('yarn@') || paths.has('yarn.lock')) return ['yarn'];
  if (declared.startsWith('bun@') || paths.has('bun.lock') || paths.has('bun.lockb')) return ['bun', 'x'];
  return ['npx', '--no-install'];
}

/** Rule 2: every runner the `test` script runs, as one runner (with `parts` when there are several). */
function scriptRunner(
  scripts: Record<string, unknown>,
  prefix: () => string[],
): Omit<TestRunner, 'source' | 'layout'> | { refusal: string } | null {
  const found = scriptRunners(scripts, 'test', prefix);
  if ('refusal' in found) return found;
  const [first, ...more] = found.parts;
  if (!first) return null;
  if (!more.length) return { ...first };
  return {
    program: 'chained',
    globs: [...new Set(found.parts.flatMap(part => part.globs))],
    command: first.command,
    parts: found.parts,
  };
}

/** Rule 4: the package graph's per-ecosystem commands, or why there is none. */
function graphRunner(options: RunnerOptions, reason: string): TestRunnerResolution {
  const graph = options.packages?.();
  if (graph?.status === 'available')
    return {
      status: 'available',
      runner: {
        source: 'package-graph',
        program: 'packages',
        globs: [],
        command: [],
        layout: 'packages',
        ecosystems: graph.ecosystems.map(item => item.ecosystem),
      },
    };
  return {
    status: 'unavailable',
    reason: graph ? `${reason}; package graph unknown: ${graph.reason}` : reason,
  };
}

/** The project's test runner from its package.json and forge.json texts and its file paths (read
 * only for rule 3). A malformed declaration throws: a typo must not silently fall back to a guess. */
export function projectTestRunner(
  packageJson: string | undefined,
  paths: () => Iterable<string>,
  options: RunnerOptions = {},
): TestRunnerResolution {
  let manifest: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(packageJson ?? '');
    if (record(parsed)) manifest = parsed;
  } catch {
    /* No manifest: only the file rule can apply. */
  }
  const found = declaredPreflight('tests', packageJson, options.forgeJson);
  const declared = found?.value;
  if (found && declared !== undefined) {
    const where = found.from;
    const entry = record(declared) ? declared : {};
    const globs = typeof entry.glob === 'string' && entry.glob ? [entry.glob] : strings(entry.glob);
    const command = strings(entry.command);
    if (!globs?.every(glob => safeRelative(glob)) || !command)
      throw new Error(
        `${found.label} needs {"glob": string | string[], "command": string[]}: ${JSON.stringify(declared).slice(0, 120)}`,
      );
    const program = command[0] === 'node' && command.includes('--test') ? 'node' : 'declared';
    return {
      status: 'available',
      runner: {
        source: 'declared',
        program,
        globs,
        command,
        layout: layout(program, globs, true),
        declaredIn: where,
      },
    };
  }
  const scripts = record(manifest.scripts) ? manifest.scripts : {};
  let known: Set<string> | undefined;
  const all = () => (known ??= new Set(paths()));
  const forgeShape = () => all().has(STANDARD_CHECK_ENTRY);
  if (typeof scripts.test === 'string') {
    const found = scriptRunner(scripts, () => execPrefix(manifest, all()));
    // `node --test` with no path runs Node's own patterns; top-level `tests/*.test.mjs` files keep
    // the import-graph selector that reads that layout, as with rule 3.
    if (
      found &&
      'globs' in found &&
      found.globs === NODE_GLOBS &&
      forgeShape() &&
      [...all()].some(matcher([FORGE_TEST_GLOB]))
    )
      found.globs = [FORGE_TEST_GLOB];
    if (found && 'refusal' in found)
      return graphRunner(options, `no test runner declared, and ${found.refusal}; ${DECLARE}`);
    return found
      ? {
          status: 'available',
          runner: {
            ...found,
            source: 'test-script',
            layout: layout(found.program, found.globs, forgeShape()),
          },
        }
      : graphRunner(
          options,
          `no test runner declared, and the package.json test script names none Forge can run per file (node --test, tsx --test, vitest, jest); ${DECLARE}`,
        );
  }
  const dependencies = {
    ...(record(manifest.dependencies) ? manifest.dependencies : {}),
    ...(record(manifest.devDependencies) ? manifest.devDependencies : {}),
  };
  const files = all();
  if ('vitest' in dependencies || 'jest' in dependencies) {
    const found = commandRunner(['vitest' in dependencies ? 'vitest' : 'jest'], () =>
      execPrefix(manifest, files),
    )!;
    return { status: 'available', runner: { ...found, source: 'dependency', layout: 'generic' } };
  }
  // Rule 3 is for Node projects: with no package.json, stray `.js` files (fixtures under `test/`)
  // do not make a Go, Rust or Python repository one; the package graph or forge.json runs it.
  const node = packageJson === undefined ? [] : [...files].filter(matcher(NODE_GLOBS));
  if (node.length) {
    // Top-level `tests/*.test.mjs` files keep the import-graph selector that reads that layout.
    const globs = forgeShape() && node.some(matcher([FORGE_TEST_GLOB])) ? [FORGE_TEST_GLOB] : NODE_GLOBS;
    return {
      status: 'available',
      runner: {
        source: 'files',
        program: 'node',
        globs,
        command: ['node', '--test', FILES_PLACEHOLDER],
        layout: layout('node', globs, forgeShape()),
      },
    };
  }
  return graphRunner(
    options,
    packageJson === undefined
      ? `no test runner declared or inferred (no package.json, so no Node runner applies); ${DECLARE}`
      : `no test runner declared or inferred (no package.json test script, test framework dependency or Node test file); ${DECLARE}`,
  );
}

/** `projectTestRunner` that reports a malformed declaration as unavailable instead of throwing. */
export function resolveTestRunner(
  packageJson: string | undefined,
  paths: () => Iterable<string>,
  options: RunnerOptions = {},
): TestRunnerResolution {
  try {
    return projectTestRunner(packageJson, paths, options);
  } catch (error) {
    return { status: 'unavailable', reason: (error as Error).message.slice(0, 300) };
  }
}

const testSuffix = /(?:[.\-_](?:test|spec))?\.[cm]?[jt]sx?$/;
const stem = (path: string) => (path.split('/').pop() ?? '').replace(testSuffix, '').replace(/^test-/, '');
const commonDirs = (a: string, b: string) => {
  const left = a.split('/').slice(0, -1);
  const right = b.split('/').slice(0, -1);
  let n = 0;
  while (n < left.length && n < right.length && left[n] === right[n]) n++;
  return n;
};
/** A runner tier's execution order: nearest folder to a changed path first, then a stable hash of
 * the change and the test, never the file name (Issue 964e2d2b). Membership is unchanged. */
export function orderRunnerTests(tests: string[], changedPaths: string[]): string[] {
  const salt = changeSalt(changedPaths);
  const nearest = (test: string) => Math.max(0, ...changedPaths.map(path => commonDirs(path, test)));
  return tests
    .map(test => ({ test, near: nearest(test), key: stableKey(salt, test) }))
    .sort((a, b) => b.near - a.near || (a.key < b.key ? -1 : 1))
    .map(item => item.test);
}
/** Prose only (src/prose-paths.ts): a dependency, build or fixture `.txt` is never docs. */
const documentation = documentationPath;

/** Tests an import graph reached for the change (src/js-import-graph.ts importGraphTests). */
export type ImportedTests = { tests: string[]; openTests: number; untraced: string[] };

/** Selection for a generic runner: changed test files, then the tests named for a changed module
 * (`sum.test.ts` for `sum.ts`, the closest by folder when several share the name) and, when the
 * caller built a JS/TS import graph, every test that reaches a changed file through imports. Every
 * other test is the landing check's; this is advisory local evidence, never an independence proof.
 * Reads no source bytes itself. */
export function runnerSelection(
  runner: TestRunner,
  allPaths: Iterable<string>,
  changedPaths: string[],
  imported?: ImportedTests,
) {
  const isTest = matcher(runner.globs);
  const tests = [...new Set(allPaths)].filter(isTest).sort();
  const present = new Set(tests);
  const changedTests = changedPaths.filter(path => present.has(path)).sort();
  const named = new Set<string>();
  for (const path of changedPaths) {
    if (present.has(path) || documentation(path) || !/\.[cm]?[jt]sx?$/.test(path)) continue;
    const name = stem(path);
    const same = tests.filter(test => !changedTests.includes(test) && stem(test) === name);
    const closest = Math.max(-1, ...same.map(test => commonDirs(path, test)));
    for (const test of same) if (commonDirs(path, test) === closest) named.add(test);
  }
  const byName = named.size;
  for (const test of imported?.tests ?? [])
    if (present.has(test) && !changedTests.includes(test)) named.add(test);
  const namedTests = [...named].sort();
  const docsOnly = changedPaths.length > 0 && changedPaths.every(documentation);
  const run = runnerLabel(runner);
  return {
    scope: docsOnly ? 'docs' : changedTests.length || namedTests.length ? 'scoped' : 'none',
    reason: imported
      ? `project test runner ${run}: ${changedTests.length} changed test file(s), ${byName} named for a changed module and ` +
        `${namedTests.length - byName} more reached through imports (${imported.openTests} through computed imports); ` +
        `${imported.untraced.length} changed code file(s) no import reaches; the other tests run in the landing check`
      : `project test runner ${run}: ${changedTests.length} changed test file(s) and ${namedTests.length} named for a changed module; ` +
        'no import graph for this layout, so the other tests run in the landing check',
    changedTests,
    namedTests,
    tests: [...changedTests, ...namedTests],
    available: tests,
  };
}

/** `vitest (test-script)`: the program and where Forge found it. */
export const runnerLabel = (runner: TestRunner) =>
  runner.layout === 'packages'
    ? `package commands (${runner.ecosystems?.join(', ')})`
    : `${runner.parts ? runner.parts.map(part => part.program).join(' + ') : runner.program} (${runner.declaredIn ? `declared in ${runner.declaredIn}` : runner.source})`;
