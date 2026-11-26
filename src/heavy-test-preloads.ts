// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Inspects `node --test` invocations for `nforge heavy` before a slot or build runs:
// 1. Preload refusal (frictions c804f164, dfb2a8d6): a focused `node --test FILES` that skips
//    preloads the project's test script passes (`--import`, `--require`, `-r`).
// 2. Empty-path refusal (frictions e4ce373a, 8e386100): direct `node --test`, `sh/bash/zsh -c`, or
//    a non-`test` package script that expands to `node --test` with no test file paths.
// 3. Build check (frictions aa71d3ed, bfb98e08): whether a heavy command runs tests directly or
//    through a shell so a missing or stale `dist/` is built first.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { HeavyKind } from './heavy-queue.js';

const TEST_FLAG = '--test';
const PRELOAD = new Set(['--import', '--require', '-r']);
const SHELL = /^(?:sh|bash|zsh)(?:\.exe)?$/i;
const SHELL_KEYWORD = /^(?:do|then|else|elif|while|until|\{|!|command|exec|[A-Za-z_]\w*=.*)$/;
const SHELL_WORD = /(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"\\])+/g;
const REDIR_ONLY = /^(?:\d*(?:>>?|<<?|<>|>&|<&)|&>>?)$/;
const REDIR_WITH_TARGET = /^(?:\d*(?:>>?|<<?|<>|>&|<&)|&>>?).+$/;
const ENV_BIN = /^(?:\/usr\/bin\/)?env$/;
const NODE_BIN = /(?:^|[\/\\])node(?:\.exe)?$/i;
const PKG_BIN = /^(?:npm|pnpm|yarn|bun)(?:\.cmd)?$/i;
const PKG_DIR_FLAGS = new Set(['--prefix', '-C', '--cwd', '-w', '--workspace', '--workspaces']);
const PKG_BUILTINS = new Set([
  'add',
  'audit',
  'cache',
  'ci',
  'config',
  'create',
  'dedupe',
  'dlx',
  'env',
  'exec',
  'get',
  'help',
  'info',
  'init',
  'install',
  'link',
  'list',
  'login',
  'logout',
  'ls',
  'node',
  'outdated',
  'pack',
  'patch',
  'prune',
  'publish',
  'rebuild',
  'remove',
  'search',
  'set',
  'store',
  'unlink',
  'update',
  'upgrade',
  'version',
  'view',
  'whoami',
  'why',
]);

/** Node options that take a separate value before the script or test paths. */
const NODE_VALUE_OPTIONS = new Set([
  '--allow-fs-read',
  '--allow-fs-write',
  '--build-snapshot-config',
  '--cpu-prof-dir',
  '--cpu-prof-interval',
  '--cpu-prof-name',
  '--diagnostic-dir',
  '--disable-proto',
  '--disable-warning',
  '--dns-result-order',
  '--env-file-if-exists',
  '--experimental-config-file',
  '--experimental-package-map',
  '--experimental-sea-config',
  '--experimental-test-isolation',
  '--experimental-test-tag-filter',
  '--heap-prof-dir',
  '--heap-prof-interval',
  '--heap-prof-name',
  '--heapsnapshot-near-heap-limit',
  '--heapsnapshot-signal',
  '--icu-data-dir',
  '--import',
  '--input-type',
  '--inspect-port',
  '--inspect-publish-uid',
  '--localstorage-file',
  '--max-http-header-size',
  '--max-old-space-size-percentage',
  '--network-family-autoselection-attempt-timeout',
  '--openssl-config',
  '--redirect-warnings',
  '--report-dir',
  '--report-directory',
  '--report-filename',
  '--report-signal',
  '--require',
  '--run',
  '--secure-heap',
  '--secure-heap-min',
  '--snapshot-blob',
  '-r',
  '--loader',
  '--experimental-loader',
  '--conditions',
  '-C',
  '--env-file',
  '-e',
  '--eval',
  '-p',
  '--print',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-concurrency',
  '--test-timeout',
  '--test-shard',
  '--test-isolation',
  '--test-global-setup',
  '--test-rerun-failures',
  '--test-coverage-branches',
  '--test-coverage-exclude',
  '--test-coverage-functions',
  '--test-coverage-include',
  '--test-coverage-lines',
  '--test-random-seed',
  '--title',
  '--tls-cipher-list',
  '--tls-keylog',
  '--trace-event-categories',
  '--trace-event-file-pattern',
  '--trace-require-module',
  '--unhandled-rejections',
  '--use-largepages',
  '--v8-pool-size',
  '--watch-kill-signal',
  '--watch-path',
]);

function unquoteShellWord(word: string): string {
  let out = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else out += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < word.length && /["\\$`\n]/.test(word[i + 1]!)) out += word[++i]!;
      else out += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === '\\' && i + 1 < word.length) {
      out += word[++i]!;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Quote-aware split on shell command separators (`&&`, `||`, `;`, `|`, `\n`, `(`, `)`), keeping
 * separators at odd indexes so `parts.join('')` reconstructs the original string verbatim. */
function splitShellParts(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') i++;
      else if (ch === '"') quote = null;
      continue;
    }
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      parts.push(text.slice(start, i), two);
      i++;
      start = i + 1;
    } else if (ch === ';' || ch === '|' || ch === '\n' || ch === '(' || ch === ')') {
      parts.push(text.slice(start, i), ch);
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Command tokens of one shell segment, with leading keywords, `VAR=val`, `env ...`, and shell
 * redirections stripped, and outer shell quotes removed. */
function segmentCommandTokens(segment: string): {
  rawHead: string | null;
  rawHeadEnd: number;
  words: string[];
} {
  const tokens: { text: string; end: number }[] = [];
  for (const match of segment.matchAll(SHELL_WORD))
    tokens.push({ text: match[0]!, end: match.index! + match[0]!.length });
  for (;;) {
    const first = tokens[0];
    if (first === undefined) break;
    if (SHELL_KEYWORD.test(first.text)) tokens.shift();
    else if (ENV_BIN.test(unquoteShellWord(first.text))) {
      tokens.shift();
      while (tokens[0] !== undefined) {
        const flag = unquoteShellWord(tokens[0].text);
        if (flag === '--') {
          tokens.shift();
          break;
        }
        if (/^-/.test(flag)) {
          tokens.shift();
          if (flag === '-u' || flag === '-C' || flag === '-S') tokens.shift();
        } else if (/^[A-Za-z_]\w*=/.test(flag)) {
          tokens.shift();
        } else break;
      }
    } else break;
  }
  if (!tokens.length) return { rawHead: null, rawHeadEnd: -1, words: [] };
  const rawHead = tokens[0]!.text;
  const rawHeadEnd = tokens[0]!.end;
  const words: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]!.text;
    if (i > 0 && REDIR_ONLY.test(raw)) {
      i++;
      continue;
    }
    if (i > 0 && REDIR_WITH_TARGET.test(raw)) continue;
    words.push(unquoteShellWord(raw));
  }
  return { rawHead, rawHeadEnd, words };
}

type ShellInvocation =
  | { kind: 'inline'; command: string; commandIndex: number }
  | { kind: 'script'; file: string };

function shellInvocation(args: string[]): ShellInvocation | null {
  if (!SHELL.test(basename(args[0] ?? ''))) return null;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      const file = args[index + 1];
      return file?.trim() ? { kind: 'script', file } : null;
    }
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg)) {
      const command = args[index + 1];
      return typeof command === 'string' ? { kind: 'inline', command, commandIndex: index + 1 } : null;
    }
    if (/^[+-][a-zA-Z]*o$/.test(arg)) {
      index++;
      continue;
    }
    if (/^[+-]/.test(arg)) continue;
    return arg.trim() ? { kind: 'script', file: arg } : null;
  }
  return null;
}

function isNodeBinary(head: string): boolean {
  return head === process.execPath || NODE_BIN.test(head);
}

/** Number of test paths of a `node ... --test` command, or null when the command is not one. */
export function nodeTestPathCount(args: string[]): number | null {
  const head = args[0] ?? '';
  if (!isNodeBinary(head)) return null;
  let testing = false;
  let paths = 0;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') {
      paths += args.slice(index + 1).filter(path => path.trim()).length;
      break;
    }
    if (arg !== '-' && arg.startsWith('-')) {
      if (arg === TEST_FLAG) testing = true;
      else if (NODE_VALUE_OPTIONS.has(arg)) index++;
    } else {
      // Without --test, the first positional argument starts the script's argv.
      if (!testing) return null;
      if (arg.trim()) paths++;
    }
  }
  return testing ? paths : null;
}

function readPackageScripts(cwd: string): Record<string, unknown> | null {
  try {
    const scripts = (
      JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
        scripts?: Record<string, unknown>;
      }
    )?.scripts;
    return scripts && typeof scripts === 'object' ? scripts : null;
  } catch {
    return null;
  }
}

type PackageScriptCall = {
  script: string;
  explicitFull: boolean;
  explicitRun: boolean;
  forwardedArgs: string[];
};

function parsePackageScript(args: string[]): PackageScriptCall | null {
  const bin = basename(args[0] ?? '');
  if (!PKG_BIN.test(bin)) return null;
  const manager = bin.replace(/\.cmd$/i, '').toLowerCase();
  let index = 1;
  while (index < args.length && args[index]!.startsWith('-')) {
    const flag = args[index]!;
    if (PKG_DIR_FLAGS.has(flag) || /^--(?:prefix|cwd|workspace)=/.test(flag)) return null;
    index++;
  }
  const sub = args[index];
  if (!sub) return null;
  const tail = (start: number) => {
    const rest = args.slice(start);
    return rest[0] === '--' ? rest.slice(1) : rest;
  };
  if (sub === 'test' || sub === 't' || sub === 'tst')
    return { script: 'test', explicitFull: true, explicitRun: true, forwardedArgs: tail(index + 1) };
  if (sub === 'run' || sub === 'run-script') {
    let next = index + 1;
    while (next < args.length && args[next]!.startsWith('-')) {
      const flag = args[next]!;
      if (flag === '--') break;
      if (PKG_DIR_FLAGS.has(flag) || /^--(?:prefix|cwd|workspace)=/.test(flag)) return null;
      next++;
    }
    const script = args[next];
    if (!script || script.startsWith('-')) return null;
    return {
      script,
      explicitFull: script === 'test',
      explicitRun: true,
      forwardedArgs: tail(next + 1),
    };
  }
  if ((manager === 'yarn' || manager === 'pnpm') && !PKG_BUILTINS.has(sub))
    return { script: sub, explicitFull: false, explicitRun: false, forwardedArgs: tail(index + 1) };
  return null;
}

/** Strip leading `VAR=val` assignments and `env [-i|-0|-u NAME|-C DIR|-S VAL]...` prefixes. */
function stripCommandPrefixes(args: string[]): string[] {
  const rest = args.slice();
  for (;;) {
    const first = rest[0];
    if (first === undefined) break;
    if (/^[A-Za-z_]\w*=/.test(first)) rest.shift();
    else if (ENV_BIN.test(first)) {
      rest.shift();
      while (rest[0] !== undefined) {
        const flag = rest[0]!;
        if (flag === '--') {
          rest.shift();
          break;
        }
        if (/^-/.test(flag)) {
          rest.shift();
          if (flag === '-u' || flag === '-C' || flag === '-S') rest.shift();
        } else if (/^[A-Za-z_]\w*=/.test(flag)) {
          rest.shift();
        } else break;
      }
    } else break;
  }
  return rest;
}

/** True when the command explicitly invokes the project's full-suite `test` script (`npm test`,
 * `env CI=1 npm test`, `npm run test`, `pnpm test`, `yarn test`, `bun test`). */
export function isExplicitFullTestScript(args: string[]): boolean {
  return parsePackageScript(stripCommandPrefixes(args))?.explicitFull === true;
}

function shellCommandHasEmptyNodeTest(
  command: string,
  cwd: string,
  forwardedArgs: string[],
  depth: number,
): boolean {
  const parts = splitShellParts(command);
  const segments: string[][] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const { words } = segmentCommandTokens(parts[i]!);
    if (words.length) segments.push(words);
  }
  for (let i = 0; i < segments.length; i++) {
    const isLast = i === segments.length - 1;
    const words = isLast && forwardedArgs.length ? [...segments[i]!, ...forwardedArgs] : segments[i]!;
    if (commandHasEmptyNodeTest(words, cwd, depth + 1)) return true;
  }
  return false;
}

function commandHasEmptyNodeTest(args: string[], cwd: string, depth: number): boolean {
  const clean = stripCommandPrefixes(args);
  if (depth > 2 || !clean.length) return false;
  if (nodeTestPathCount(clean) === 0) return true;
  const shell = shellInvocation(clean);
  if (shell?.kind === 'inline') return shellCommandHasEmptyNodeTest(shell.command, cwd, [], depth);
  const pkg = parsePackageScript(clean);
  if (!pkg || pkg.explicitFull) return false;
  const scripts = readPackageScripts(cwd);
  const body = scripts?.[pkg.script];
  if (typeof body !== 'string') return false;
  return shellCommandHasEmptyNodeTest(body, cwd, pkg.forwardedArgs, depth);
}

/**
 * True when a heavy command runs `node ... --test` with no test path — directly, inside a shell
 * `-c` string, or through a non-`test` npm/pnpm/yarn/bun script — so Node would fall back to
 * discovering and running the whole suite (frictions e4ce373a, 8e386100).
 */
export function nodeTestWithoutPaths(args: string[], cwd = process.cwd()): boolean {
  return commandHasEmptyNodeTest(args, cwd, 0);
}

/**
 * True when a heavy command runs tests directly (`node ... --test FILES`) or through a shell
 * (`sh <script>`, or `sh -c` with `node ... --test`), so a missing or stale `dist/` must be
 * built or checked before it runs (frictions aa71d3ed, bfb98e08).
 */
export function needsCoreBuild(args: string[]): boolean {
  if (nodeTestPathCount(args)) return true;
  const shell = shellInvocation(args);
  if (!shell) return false;
  if (shell.kind === 'script') return true;
  return nodeTestSegments(shell.command).found.length > 0;
}

/** Preload flags (`--import X`, `--import=X`, `--require X`, `-r X`) in one word list. */
function preloads(words: string[]) {
  const found: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const joined = /^(--import|--require)=(.+)$/.exec(word);
    if (joined) found.push(`${joined[1]} ${joined[2]}`);
    else if (PRELOAD.has(word) && words[i + 1])
      found.push(`${word === '-r' ? '--require' : word} ${words[++i]}`);
  }
  return found;
}

/** The `node … --test` segments of a shell string (separators kept at the odd indexes of `parts`). */
function nodeTestSegments(text: string) {
  const parts = splitShellParts(text);
  const found: { at: number; rawHeadEnd: number; words: string[] }[] = [];
  parts.forEach((part, at) => {
    if (at % 2) return;
    const { rawHead, rawHeadEnd, words } = segmentCommandTokens(part);
    if (rawHead && nodeTestPathCount(words) !== null) found.push({ at, rawHeadEnd, words });
  });
  return { parts, found };
}

/** The kind of a heavy command from its words, for the history only (the words are never stored). */
export function commandKind(args: string[]): HeavyKind {
  const text = ` ${args.join(' ')} `;
  const command = stripCommandPrefixes(args);
  const shell = shellInvocation(command);
  if (
    nodeTestPathCount(command) !== null ||
    (shell?.kind === 'inline' && nodeTestSegments(shell.command).found.length) ||
    /\b(?:npm|pnpm|yarn|bun)(?:\.cmd)?\s+(?:run\s+(?:(?:-s|--silent)\s+)?)?test\b/.test(text) ||
    /\b(?:vitest|jest|mocha|preflight)\b/.test(text)
  )
    return 'test';
  if (/\b(?:tsc|tsgo|vue-tsc|typecheck)\b/.test(text)) return 'typecheck';
  if (/\b(?:build|esbuild|webpack|rollup|vite)\b/.test(text)) return 'build';
  return 'other';
}

/** The preloads of the project's `test` script (package.json in `cwd` only); a missing, unreadable
 * or non-node test script asks for nothing. */
function wantedPreloads(cwd: string) {
  const wanted = new Set<string>();
  const script = readPackageScripts(cwd)?.test;
  if (typeof script !== 'string') return wanted;
  for (const { words } of nodeTestSegments(script).found)
    for (const flag of preloads(words.slice(1))) wanted.add(flag);
  return wanted;
}

const quote = (word: string) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);

/** The refusal for a heavy command whose `node --test` leaves out preloads the project's test script
 * passes: a direct `node --test`, or a node segment inside one `sh -c`/`bash -c`/`zsh -c` string.
 * Names the missing flags and the corrected command; it never rewrites what runs. Null when nothing
 * is missing. Reads package.json only for a command that could be such a test. */
export function preloadRefusal(args: string[], cwd: string): string | null {
  const first = args[0] ?? '';
  const shell = shellInvocation(args);
  const inline = shell?.kind === 'inline' ? shell : null;
  const segments = inline ? nodeTestSegments(inline.command) : null;
  if (segments ? !segments.found.length : nodeTestPathCount(args) === null) return null;
  const wanted = wantedPreloads(cwd);
  if (!wanted.size) return null;
  // A preload the caller exports in NODE_OPTIONS reaches the test runner too.
  const inherited = preloads((process.env.NODE_OPTIONS ?? '').split(/\s+/));
  const lacking = (words: string[]) => {
    const own = new Set([...preloads(words), ...inherited]);
    return [...wanted].filter(flag => !own.has(flag));
  };
  let missing: string[];
  let corrected: string;
  if (inline && segments) {
    const { parts, found } = segments;
    const all = new Set<string>();
    for (const { at, rawHeadEnd, words } of found) {
      const need = lacking(words.slice(1));
      for (const flag of need) all.add(flag);
      if (need.length && rawHeadEnd >= 0) {
        parts[at] = `${parts[at]!.slice(0, rawHeadEnd)} ${need.join(' ')}${parts[at]!.slice(rawHeadEnd)}`;
      }
    }
    missing = [...all];
    const rebuilt = [
      ...args.slice(0, inline.commandIndex),
      parts.join(''),
      ...args.slice(inline.commandIndex + 1),
    ];
    corrected = rebuilt.map(quote).join(' ');
  } else {
    missing = lacking(args.slice(1));
    corrected = [first, ...missing.flatMap(flag => flag.split(' ')), ...args.slice(1)].map(quote).join(' ');
  }
  if (!missing.length) return null;
  return (
    `heavy: refused before taking a slot or running anything: this project's test script runs node --test ` +
    `with ${missing.join(' ')}; this command's node --test does not, so test setup it provides is missing ` +
    `(a test would fail on the real user path). Add ${missing.join(' ')} before --test. ` +
    `Corrected command: nforge heavy ${corrected}`
  );
}
