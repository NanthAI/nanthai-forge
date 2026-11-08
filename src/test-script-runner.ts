// SPDX-License-Identifier: Apache-2.0
import { safeRelative } from './safe-relative.js';

/** Test runners read from a package.json `test` script (src/project-test-runner.ts rule 2). Reads the
 * script text only, never runs it: named-script indirection (`npm run NAME`, `npm test`, `pnpm NAME`,
 * `yarn NAME`, `bun run NAME`) is followed up to SCRIPT_DEPTH scripts, cycle-safe, and every runner of
 * a chained script is kept. A runner Forge cannot run per file, a folder change or another package's
 * scripts make the whole script a refusal with the reason, never a silently dropped runner. */

export const FILES_PLACEHOLDER = '{files}';
/** Named scripts followed at most from `test` (`test` → a → b → c → d). */
export const SCRIPT_DEPTH = 4;
const CODE = '{js,mjs,cjs,ts,mts,cts,jsx,tsx}';
/** Node's own test file patterns (`node --test` with no path). */
export const NODE_GLOBS = [
  '**/*.test.{js,mjs,cjs}',
  '**/*-test.{js,mjs,cjs}',
  '**/*_test.{js,mjs,cjs}',
  '**/test-*.{js,mjs,cjs}',
  '**/test.{js,mjs,cjs}',
  '**/test/**/*.{js,mjs,cjs}',
];
/** The same patterns with TypeScript extensions: `tsx --test` with no path. */
const TSX_GLOBS = NODE_GLOBS.map(glob => glob.replace('{js,mjs,cjs}', '{js,mjs,cjs,ts,mts,cts}'));
export const VITEST_GLOBS = [`**/*.{test,spec}.${CODE}`];
export const JEST_GLOBS = [`**/__tests__/**/*.${CODE}`, `**/*.{test,spec}.${CODE}`];

/** One per-file runner: the paths it owns and the argv that runs some of them. */
export type RunnerPart = { program: 'node' | 'tsx' | 'vitest' | 'jest'; globs: string[]; command: string[] };

/** Flags of `node` (and `tsx`) whose value is the next word. */
const VALUE_FLAGS = new Set([
  '--import',
  '--require',
  '-r',
  '--loader',
  '--experimental-loader',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--env-file',
  '--conditions',
  '-C',
  '--tsconfig',
]);
/** Test runners Forge does not run per file: a chained script that also runs one is refused. */
const OTHER_RUNNERS = new Set([
  'mocha',
  'ava',
  'tap',
  'tape',
  'jasmine',
  'karma',
  'uvu',
  'cypress',
  'playwright',
  'wdio',
  'pytest',
  'rspec',
  'phpunit',
  'tox',
  'nox',
  'lerna',
  'turbo',
  'nx',
]);
/** A later word that makes a command a test run of another tool (`go test`, `make test`, `python -m pytest`). */
const TEST_WORDS = new Set(['test', 'unittest', 'pytest']);
/** Coverage wrappers: the runner they wrap is the runner. */
const WRAPPERS = new Set(['c8', 'nyc']);
/** Package-manager flags that run another package's scripts. */
const ELSEWHERE = /^(?:--prefix|--dir|--cwd|--filter|--workspaces?|--recursive|-C|-F|-w|-ws|-r)(?:=|$)/;

const unquote = (word: string) => word.replace(/^(['"])(.*)\1$/, '$2');
const ENV = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** The words of one shell command, unquoted, after env assignments (and `cross-env`/`env`). */
function commandWords(segment: string) {
  const words = segment.trim().split(/\s+/).filter(Boolean).map(unquote);
  while (words.length && ENV.test(words[0]!)) words.shift();
  if (words[0] === 'cross-env' || words[0] === 'env') {
    words.shift();
    while (words.length && ENV.test(words[0]!)) words.shift();
  }
  return words;
}

/** The program words of one command after package-manager launchers and coverage wrappers. */
function programWords(command: string[]) {
  const words = [...command];
  const launchers = [['pnpm', 'exec'], ['npm', 'exec'], ['bun', 'x'], ['npx'], ['pnpm'], ['yarn'], ['bunx']];
  for (const launcher of launchers)
    if (launcher.every((word, i) => words[i] === word)) {
      words.splice(0, launcher.length);
      while (words[0]?.startsWith('-')) words.shift();
      break;
    }
  if (WRAPPERS.has(words[0]!)) {
    const at = words.findIndex(
      word => ['node', 'tsx', 'vitest', 'jest'].includes(word) || OTHER_RUNNERS.has(word),
    );
    return at < 0 ? words : words.slice(at);
  }
  return words;
}

/** `node|tsx … --test [paths]`: its flags stay, its paths become the globs. */
function nodeTestRunner(words: string[], prefix: () => string[]): RunnerPart | null {
  if ((words[0] !== 'node' && words[0] !== 'tsx') || !words.includes('--test')) return null;
  const flags: string[] = [];
  const paths: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    if (word.startsWith('-')) {
      flags.push(word);
      if (VALUE_FLAGS.has(word) && i + 1 < words.length) flags.push(words[++i]!);
    } else paths.push(word.replace(/^\.\//, '').replace(/\/$/, ''));
  }
  const tsx = words[0] === 'tsx';
  const defaults = tsx ? TSX_GLOBS : NODE_GLOBS;
  // A folder runs the runner's own patterns below it; a path or glob is used as written.
  const globs = paths.length
    ? paths.flatMap(path =>
        /[*?{]/.test(path) || /\.[cm]?[jt]sx?$/.test(path) ? [path] : defaults.map(glob => `${path}/${glob}`),
      )
    : defaults;
  if (!globs.every(glob => safeRelative(glob))) return null;
  // tsx is a project dependency: run it through the package manager, as vitest and jest.
  return tsx
    ? { program: 'tsx', globs, command: [...prefix(), 'tsx', ...flags, FILES_PLACEHOLDER] }
    : { program: 'node', globs, command: ['node', ...flags, FILES_PLACEHOLDER] };
}

/** The per-file runner one command is, if any. */
export function commandRunner(words: string[], prefix: () => string[]): RunnerPart | null {
  const node = nodeTestRunner(words, prefix);
  if (node) return node;
  if (words[0] === 'vitest')
    return {
      program: 'vitest',
      globs: VITEST_GLOBS,
      command: [...prefix(), 'vitest', 'run', FILES_PLACEHOLDER],
    };
  if (words[0] === 'jest')
    return {
      program: 'jest',
      globs: JEST_GLOBS,
      command: [...prefix(), 'jest', '--runTestsByPath', FILES_PLACEHOLDER],
    };
  return null;
}

/** A runner Forge cannot run per file, by name (`mocha`, `bun test`), or null. */
function otherRunner(words: string[]) {
  if (OTHER_RUNNERS.has(words[0]!)) return words[0]!;
  const word = words.slice(1).find(item => TEST_WORDS.has(item));
  if (word) return `${words[0]} … ${word}`;
  if (WRAPPERS.has(words[0]!)) return words[0]!;
  return null;
}

type Target = { name: string; extra: string };
/** `npm-run-all` patterns: `*` stays inside one `:` segment, `**` crosses them. */
const scriptPattern = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split('**')
      .map(part =>
        part
          .split('*')
          .map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^:]*'),
      )
      .join('.*')}$`,
  );
/** The named scripts one command runs (`npm run NAME`, `npm test`, `pnpm NAME`, `yarn NAME`,
 * `bun run NAME`, `run-s`/`run-p`/`npm-run-all NAMES`), each with the arguments the package manager
 * appends to it; null when the command runs no named script. */
function scriptTargets(
  words: string[],
  scripts: Record<string, unknown>,
): Target[] | { refusal: string } | null {
  const tool = words[0];
  if (tool === 'run-s' || tool === 'run-p' || tool === 'npm-run-all') {
    const names = words.slice(1).filter(word => !word.startsWith('-'));
    return names.flatMap(name => {
      if (!name.includes('*')) return [{ name, extra: '' }];
      const pattern = scriptPattern(name);
      return Object.keys(scripts)
        .filter(script => pattern.test(script))
        .sort()
        .map(script => ({ name: script, extra: '' }));
    });
  }
  if (tool !== 'npm' && tool !== 'pnpm' && tool !== 'yarn' && tool !== 'bun') return null;
  const end = words.indexOf('--');
  const own = end < 0 ? words : words.slice(0, end);
  const rest = own.slice(1).filter(word => !word.startsWith('-'));
  const sub = rest[0];
  const elsewhere =
    own.find(word => ELSEWHERE.test(word)) ??
    (sub === 'workspace' || sub === 'workspaces' ? `${tool} ${sub}` : undefined);
  let name: string | undefined;
  let after: number;
  if (sub === 'run' || sub === 'run-script' || (tool === 'npm' && (sub === 'rum' || sub === 'urn'))) {
    name = rest[1];
    after = 2;
  } else if ((sub === 'test' || sub === 't' || sub === 'tst') && tool !== 'bun') {
    name = 'test';
    after = 1;
  } else if (
    (tool === 'pnpm' || tool === 'yarn') &&
    sub &&
    sub !== 'exec' &&
    sub !== 'dlx' &&
    typeof scripts[sub] === 'string'
  ) {
    name = sub;
    after = 1;
  } else if (elsewhere) {
    name = sub ?? '';
    after = 1;
  } else return null;
  if (elsewhere)
    return {
      refusal: `${words.join(' ')} runs another package's scripts (${elsewhere}); Forge reads the root package.json scripts only`,
    };
  if (!name) return null;
  if (tool === 'bun' && typeof scripts[name] !== 'string') return null; // `bun run FILE` runs a file
  // npm passes only the words after `--`; pnpm, yarn and bun pass every word after the name.
  const extra = tool === 'npm' ? (end < 0 ? [] : words.slice(end + 1)) : rest.slice(after);
  return [{ name, extra: extra.length ? ` ${extra.join(' ')}` : '' }];
}

/** Every per-file runner the `start` script runs, or why the script cannot be read as runners. */
export function scriptRunners(
  scripts: Record<string, unknown>,
  start: string,
  prefix: () => string[],
): { parts: RunnerPart[] } | { refusal: string } {
  const parts: RunnerPart[] = [];
  const visit = (script: string, chain: string[]): string | null => {
    for (const segment of script.split(/&&|\|\||;/)) {
      const words = commandWords(segment);
      if (!words.length) continue;
      if (words[0] === 'cd' || words[0] === 'pushd')
        return `the ${chain.at(-1)} script changes folder (${words.join(' ')}); Forge reads the root package.json scripts only`;
      const targets = scriptTargets(words, scripts);
      if (targets && 'refusal' in targets) return targets.refusal;
      if (targets) {
        for (const target of targets) {
          const path = [...chain, target.name];
          if (chain.includes(target.name)) return `the ${chain[0]} script runs itself: ${path.join(' → ')}`;
          if (chain.length > SCRIPT_DEPTH)
            return `the ${chain[0]} script goes through more than ${SCRIPT_DEPTH} named scripts (${path.join(' → ')})`;
          const body = scripts[target.name];
          // A missing script fails in the package manager itself: there is nothing to run here.
          if (typeof body !== 'string') continue;
          const failed = visit(`${body}${target.extra}`, path);
          if (failed) return failed;
        }
        continue;
      }
      const program = programWords(words);
      const part = commandRunner(program, prefix);
      if (part) {
        const same = parts.find(item => JSON.stringify(item.command) === JSON.stringify(part.command));
        if (same) same.globs = [...new Set([...same.globs, ...part.globs])];
        else parts.push(part);
        continue;
      }
      const other = otherRunner(program);
      if (other)
        return `the ${chain.at(-1)} script runs ${other}, which Forge cannot run per file${chain.length > 1 ? ` (${chain.join(' → ')})` : ''}`;
    }
    return null;
  };
  const failed = visit(typeof scripts[start] === 'string' ? (scripts[start] as string) : '', [start]);
  return failed ? { refusal: failed } : { parts };
}
