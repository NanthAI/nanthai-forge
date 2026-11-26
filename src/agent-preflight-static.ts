// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import {
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnCaptured, failureExcerpt } from './agent-preflight-capture.js';
import { safeRelative } from './safe-relative.js';
import { linkDirectory, writeSourceLink } from './source-links.js';
import { globRegExp } from './path-glob.js';
import { declaredPreflight } from './project-config.js';
import { typecheckChecks, type TypecheckStep } from './preflight-typecheck.js';

export { globRegExp };

/** A cheap, repository-wide check the landing check also runs. Declared as `preflight.static` in a
 * root forge.json (any language) or as `forge.preflight.static` in package.json; each entry is a
 * package.json script name or an object:
 * `{ name?, script? | command?: string[], inputs?: glob[], packageFiles?: true }`. `inputs` limits the check to changes
 * touching them; without it any change triggers the check. Absent a declaration, only formatter
 * checks the project already names conventionally run. Nothing else is guessed: an unknown
 * `check` script may be a full verification. Either way, the compiler steps of the project's own
 * typecheck script follow (src/preflight-typecheck.ts), unless a declaration already runs it. */
export type StaticCheck = {
  name: string;
  command: string[];
  fix?: string[];
  inputs: string[] | null;
  /** `derived`: read from the project's own typecheck script (src/preflight-typecheck.ts); judged as declared. */
  source: 'declared' | 'conventional' | 'derived';
  /** Set on the typecheck script's steps: what to run first and which program to list. */
  typecheck?: TypecheckStep;
};
/** `failed` blocks the landing; every other outcome is reported and never blocks. `pre-existing`: the
 * check reproduces the same diagnostic on the Lane's base.
 * `unjudged`: it failed, but whether the change caused it is unknown (changed paths unknown, no base
 * copy to compare, or its program is not installed here); the landing check still runs it.
 * `forge-metadata`: it fails only on files Forge itself writes into the Lane (forgeWritten), which are
 * never the change's input, whatever the repository's tool configuration covers. */
export type StaticCheckResult = {
  name: string;
  outcome: 'passed' | 'failed' | 'timed-out' | 'pre-existing' | 'unjudged' | 'forge-metadata';
  ms: number;
  command?: string[];
  fix?: string[];
  excerpt?: string;
  /** Files the failure names: the Lane's own (failed) or the ones it does not touch (pre-existing). */
  files?: string[];
  /** One line on why a failure does not block. */
  advisory?: string;
};
/** What a static failure is judged against. `changed`: the saved paths base to head (adds, edits,
 * deletes, both sides of a rename); null when unknown. `base`: a path's bytes on the Lane's base,
 * null when base lacks it, undefined when not known here. `scratch`: a directory on the Lane's volume
 * for the temporary base copy. */
export type StaticScope = {
  changed: string[] | null;
  base?: ((path: string) => Buffer | null | undefined) | undefined;
  /** The full base delta before paths already on newer main are dropped from `changed`. */
  comparisonPaths?: () => string[];
  /** Generated files in the scratch copy may still reflect Lane inputs. */
  hasBaseFile?: (path: string) => boolean;
  scratch?: string | undefined;
  /** A directory that outlives the run, for checks' own caches (each check gets a folder of its own). */
  cache?: string | undefined;
};
export const STATIC_CHECK_TIMEOUT_MS = 120_000;
/** What a static command may read to do less (all optional; a command that ignores them runs in full).
 * FORGE_PREFLIGHT_CHANGED_FILE: a file of the saved paths base to head, each followed by a NUL byte
 * (adds, edits, deletes and both sides of a rename). Absent when the paths are unknown: then check
 * everything. FORGE_PREFLIGHT_CACHE_DIR: a folder this check may keep a cache in between runs.
 * The landing check sets neither and runs in full. */
const CHANGED_FILE_ENV = 'FORGE_PREFLIGHT_CHANGED_FILE';
const CACHE_DIR_ENV = 'FORGE_PREFLIGHT_CACHE_DIR';
const INFERRED_ADVICE =
  'inferred from a conventional script name, not declared under preflight.static: advice only; the landing check still runs it. Declare it to make it block.';
const CONVENTIONAL_FORMAT_SCRIPTS = ['format:check', 'check:format', 'fmt:check'];
const CODE_INPUTS = ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx,json,css}'];

const npm = (script: string) => ['npm', 'run', '-s', script];
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length && value.every(item => typeof item === 'string')
    ? (value as string[])
    : null;

/** The project's static checks from its forge.json and package.json texts. Unparseable or absent
 * package.json text declares none; a malformed forge.json throws (src/project-config.ts). */
export function staticChecks(packageJson: string | undefined, forgeJson?: string): StaticCheck[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(packageJson ?? '');
  } catch {
    /* Only forge.json can declare checks. */
  }
  const scripts = record(manifest) && record(manifest.scripts) ? manifest.scripts : {};
  const found = declaredPreflight('static', packageJson, forgeJson);
  const declared = found?.value;
  if (Array.isArray(declared)) {
    const checks: StaticCheck[] = [];
    for (const item of declared) {
      const entry = typeof item === 'string' ? { script: item } : record(item) ? item : {};
      const command = strings(entry.command) ?? (typeof entry.script === 'string' ? npm(entry.script) : null);
      // The first word names the program to run; an empty one could never start.
      // A declared script the project no longer has must not silently stop checking: fail the plan.
      if (!command?.[0] || (typeof entry.script === 'string' && typeof scripts[entry.script] !== 'string'))
        throw new Error(
          `${found!.label} names a check that cannot run: ${JSON.stringify(item).slice(0, 120)}`,
        );
      const inputs = strings(entry.inputs);
      const packageFiles = entry.packageFiles === true && record(manifest) ? strings(manifest.files) : null;
      checks.push({
        name:
          typeof entry.name === 'string' && entry.name
            ? entry.name
            : String(entry.script ?? command.join(' ')),
        command,
        ...(strings(entry.fix) ? { fix: strings(entry.fix)! } : {}),
        inputs: packageFiles
          ? [...(inputs ?? []), ...packageFiles.flatMap(path => [path, `${path}/**`])]
          : inputs,
        source: 'declared',
      });
    }
    return [...checks, ...typecheckChecks(scripts, checks, true)];
  }
  const script = CONVENTIONAL_FORMAT_SCRIPTS.find(name => typeof scripts[name] === 'string');
  const format: StaticCheck[] = script
    ? [{ name: script, command: npm(script), inputs: CODE_INPUTS, source: 'conventional' }]
    : [];
  return [...format, ...typecheckChecks(scripts, format, false)];
}

/** A cheap guard test the project always wants run first when a change touches its `inputs`
 * (declared as `preflight.guards` in forge.json or `forge.preflight.guards` in package.json:
 * `{name, tests: [path, ...], inputs?: [glob, ...]}`).
 * Guards join the protected mandatory tier: the local time budget never trims or stops them. */
export type PreflightGuard = {
  name: string;
  tests: string[];
  inputs: string[] | null;
  /** `demote: true`: the guard still joins the plan when its inputs are touched, but it ranks below the
   * learned guard set, takes no room from it and is stopped by the wall clock like any other file
   * (the landing check still runs it). For a guard that has not failed a landing in a long window. */
  demote?: boolean;
};

/** The project's declared guards. A malformed entry or a test file the project lacks throws, so a
 * renamed guard test cannot silently stop guarding. */
export function preflightGuards(
  packageJson: string | undefined,
  hasFile: (path: string) => boolean,
  forgeJson?: string,
) {
  const found = declaredPreflight('guards', packageJson, forgeJson);
  const declared = found?.value;
  if (!Array.isArray(declared)) return [];
  return declared.map((item): PreflightGuard => {
    const entry = record(item) ? item : {};
    const tests = strings(entry.tests);
    if (typeof entry.name !== 'string' || !entry.name || !tests?.every(test => hasFile(test)))
      throw new Error(`${found!.label} names a guard that cannot run: ${JSON.stringify(item).slice(0, 120)}`);
    return {
      name: entry.name,
      tests,
      inputs: strings(entry.inputs),
      ...(entry.demote === true ? { demote: true } : {}),
    };
  });
}

/** Guards whose inputs the saved change touches (no `inputs`: every change), and the ones it does not. */
export function selectGuards(guards: PreflightGuard[], changedPaths: string[]) {
  const selected: PreflightGuard[] = [];
  const untouched: string[] = [];
  for (const guard of guards) {
    const patterns = guard.inputs?.map(globRegExp);
    if (!patterns || changedPaths.some(path => patterns.some(pattern => pattern.test(path))))
      selected.push(guard);
    else untouched.push(guard.name);
  }
  return { selected, untouched };
}

/** Checks whose inputs the saved change touches, and the ones it does not (named, never silent). */
export function selectStaticChecks(checks: StaticCheck[], changedPaths: string[]) {
  const selected: StaticCheck[] = [];
  const untouched: string[] = [];
  for (const check of checks) {
    const patterns = check.inputs?.map(globRegExp);
    if (!patterns || changedPaths.some(path => patterns.some(pattern => pattern.test(path))))
      selected.push(check);
    else untouched.push(check.name);
  }
  return { selected, untouched };
}

/** Runs each check in the Lane root, output to stderr, all of them even after a failure (they are
 * short and one report names every static problem), in ENV: the run's clean environment
 * (cleanCommandEnvironment), never the agent's. A check that exceeds its timeout is reported,
 * not counted as a pass or a failure: the landing check still runs it.
 *
 * With SCOPE, a failure blocks only when it is the change's: the output names a changed file (fast,
 * no second run), or the check passes on a copy of the Lane's base. A diagnosis reproduced on the
 * base copy is pre-existing and advisory. Checks are opaque repository commands, so files are
 * read from their output. Without SCOPE every failure blocks. */
export function runStaticChecks(
  root: string,
  checks: StaticCheck[],
  env: NodeJS.ProcessEnv,
  timeoutMs = STATIC_CHECK_TIMEOUT_MS,
  scope?: StaticScope,
): StaticCheckResult[] {
  let base: string | null | undefined;
  const baseCopy = () =>
    base === undefined
      ? (base = scope?.changed ? copyBase(root, scope.comparisonPaths?.() ?? scope.changed, scope) : null)
      : base;
  const changed = new Set(scope?.changed ?? []);
  const known = (dir: string) => (path: string) => isFile(join(dir, path));
  const hints = scope?.changed ? changedHints(scope.changed, scope) : undefined;
  try {
    return checks.map(check => {
      const started = Date.now();
      const [command, ...args] = check.command as [string, ...string[]];
      const head = mentions(root, known(root), changed);
      process.stderr.write(`preflight: static ${check.name}…\n`);
      const run = spawnCaptured(
        command,
        args,
        { cwd: root, env: hints ? hints(env, check.name) : env, timeout: timeoutMs },
        false,
        { ...(scope ? { onText: head.push } : {}) },
      );
      const timedOut = run.errorCode === 'ETIMEDOUT';
      const outcome = timedOut ? 'timed-out' : run.status === 0 ? 'passed' : 'failed';
      const result: StaticCheckResult = {
        name: check.name,
        outcome,
        ms: 0,
        command: check.command,
        ...(check.fix ? { fix: check.fix } : {}),
        ...(run.status !== 0 ? { excerpt: failureExcerpt(run.tail) } : {}),
      };
      if (outcome === 'failed' && check.source === 'conventional') {
        // Nothing declared this command a gate: report it, never refuse on it.
        result.outcome = 'unjudged';
        result.advisory = INFERRED_ADVICE;
        process.stderr.write(`preflight: ${check.name}: ${INFERRED_ADVICE}\n`);
      } else if (outcome === 'failed' && scope) {
        // The comparison run on the Lane's base gets no change hints: it answers whether base fails too.
        const verdict = judge(root, check, run, head.end(), scope, baseCopy, env, timeoutMs, known);
        Object.assign(result, verdict);
        if (verdict.advisory) process.stderr.write(`preflight: ${check.name}: ${verdict.advisory}\n`);
      }
      result.ms = Date.now() - started;
      return result;
    });
  } finally {
    if (base) rmSync(base, { recursive: true, force: true });
    hints?.dispose();
  }
}

/** The saved paths as a NUL-terminated file plus the base and cache hints, for ENV per check. */
function changedHints(paths: string[], scope: StaticScope) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-static-paths-'));
  const file = join(directory, 'changed-paths');
  writeFileSync(file, paths.map(path => `${path}\0`).join(''), { mode: 0o600 });
  const hint = (env: NodeJS.ProcessEnv, name: string): NodeJS.ProcessEnv => {
    const next: NodeJS.ProcessEnv = { ...env, [CHANGED_FILE_ENV]: file };
    if (scope.cache) {
      try {
        const own = join(scope.cache, createHash('sha256').update(name).digest('hex').slice(0, 16));
        mkdirSync(own, { recursive: true, mode: 0o700 });
        next[CACHE_DIR_ENV] = own;
      } catch {
        /* No cache folder: the check runs in full. */
      }
    }
    return next;
  };
  hint.dispose = () => rmSync(directory, { recursive: true, force: true });
  return hint;
}

/** Files Forge itself writes into a Lane and never saves: its root `.forge/` folder (the checkout
 * marker hosted-lane.json, work records, native.json, index.json, contracts.json, materialization.json,
 * hosted-main.json) and the root dependency link it places (`node_modules`). A check's failure on them
 * is never the change's. Local to this judgement: nested names are the repository's own, and the
 * save and cache policy (src/forge-cache-paths.ts) is unchanged. */
export const forgeWritten = (path: string) =>
  path === '.forge' ||
  path.startsWith('.forge/') ||
  path === 'node_modules' ||
  path.startsWith('node_modules/');

type Run = ReturnType<typeof spawnCaptured>;
/** What a check's output names: the change's own paths (`own`, recognized however long the output),
 * other repository files (`paths`) and Forge-written ones (`forge`). `overflow`: past the scan caps;
 * `partial`: a changed path appears only in part. Either means `paths` and `forge` are not the whole
 * story, so no "only" claim may rest on them. */
type Found = { own: string[]; paths: string[]; forge: string[]; overflow: boolean; partial: boolean };
const list = (paths: string[]) =>
  `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` and ${paths.length - 5} more` : ''}`;
const NOT_BLOCKING = 'not blocking; the landing check still runs it.';

/** Whether a failed check is the change's (outcome stays `failed`) or advisory. */
function judge(
  root: string,
  check: StaticCheck,
  run: Run,
  head: Found,
  scope: StaticScope,
  baseCopy: () => string | null,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  known: (dir: string) => (path: string) => boolean,
): Partial<StaticCheckResult> {
  // 127 is the shell's "command not found"; ENOENT a program that is not installed at all.
  if (run.status === 127 || run.errorCode === 'ENOENT')
    return {
      outcome: 'unjudged',
      advisory: `its program is not installed here (${run.errorCode ?? `exit ${run.status}`}); ${NOT_BLOCKING}`,
    };
  if (!scope.changed)
    return {
      outcome: 'unjudged',
      advisory: `failed, but this change's saved paths are unknown, so it cannot tell whether the failure is the change's; ${NOT_BLOCKING}`,
    };
  const changed = new Set(scope.changed);
  // The change's own files fail: block in seconds, with no second run.
  if (head.own.length) return { outcome: 'failed', files: head.own };
  const certain = !head.overflow && !head.partial;
  // Only Forge's own Lane metadata fails (a formatter covering .forge/): never this change's, no base run.
  if (certain && head.forge.length && !head.paths.length)
    return {
      outcome: 'forge-metadata',
      files: head.forge,
      advisory: `fails only on files Forge writes into the Lane (${list(head.forge)}), never this change's input; ignore .forge/ in this tool's configuration to silence it; ${NOT_BLOCKING}`,
    };
  const untouched = head.paths;
  const uncertain = (scan: Found) => ({
    outcome: 'unjudged' as const,
    advisory: `failed, and its output could not be fully attributed to files (${
      scan.overflow ? 'too long to scan in full' : 'a changed path appears in it only in part'
    }), so it cannot tell whether the failure is the change's; ${NOT_BLOCKING}`,
  });
  const dir = baseCopy();
  if (!dir)
    return !certain
      ? uncertain(head)
      : {
          outcome: 'unjudged',
          advisory: `failed without naming a file this Lane changes, and no copy of the Lane's base was available to compare; ${NOT_BLOCKING}`,
        };
  const found = mentions(dir, known(dir), changed);
  const [command, ...args] = check.command as [string, ...string[]];
  const before = spawnCaptured(command, args, { cwd: dir, env, timeout: timeoutMs }, false, {
    echo: false,
    onText: found.push,
  });
  const onBase = found.end();
  if (before.status === 0)
    return {
      outcome: 'failed',
      ...(untouched.length ? { files: untouched } : {}),
      excerpt: `${failureExcerpt(run.tail)} (passes on the Lane's base: this change causes it)`.slice(0, 700),
    };
  if (before.errorCode || before.status === null || before.status === 127)
    return !certain
      ? uncertain(head)
      : {
          outcome: 'unjudged',
          advisory: `failed, and its run on the Lane's base did not finish (${before.errorCode ?? `exit ${before.status}`}), so it cannot tell whether the failure is new; ${NOT_BLOCKING}`,
        };
  // A capped or partial scan on either side cannot say which failures are new.
  if (!certain) return uncertain(head);
  if (onBase.overflow || onBase.partial) return uncertain(onBase);
  if (untouched.length) {
    // The base names files too, and this run names an untouched file it does not: the change broke it.
    const baseFiles = new Set(onBase.paths);
    const added = untouched.filter(path => !baseFiles.has(path));
    if (added.length && onBase.paths.length)
      return {
        outcome: 'failed',
        files: added,
        excerpt: `${failureExcerpt(run.tail)} (new compared with the Lane's base: ${list(added)})`.slice(
          0,
          700,
        ),
      };
  }
  const { hasBaseFile } = scope;
  const generated = hasBaseFile && untouched.some(path => !hasBaseFile(path));
  if (!generated && !run.truncated && !before.truncated && sameFailure(run.tail, root, before.tail, dir))
    return {
      outcome: 'pre-existing',
      ...(untouched.length ? { files: untouched } : {}),
      advisory: `pre-existing on the Lane's base${untouched.length ? ` (${list(untouched)})` : ''}: same diagnostic, ${NOT_BLOCKING}`,
    };
  return {
    outcome: 'unjudged',
    advisory: `fails on the Lane and its base, but the full diagnostic could not be matched; ${NOT_BLOCKING}`,
  };
}

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const MAX_TOKENS = 5_000;
const MAX_FILES = 200;
// Separators around a path in tool output: whitespace, quotes, brackets, commas, pipes.
const TOKEN = /[^\s'"`()[\]{}<>,;|]+/g;
const SEPARATOR = /[\s'"`()[\]{}<>,;|]/;
const PATH_CHARACTER = /[\w.\-/@+~]/;

/** Whether TEXT names PATH whole: not inside a longer name. A leading ./ belongs to it; a trailing
 * period ends a sentence unless a name continues after it. */
function namesPath(text: string, path: string) {
  for (let at = text.indexOf(path); at >= 0; at = text.indexOf(path, at + 1)) {
    const start = text.startsWith('./', at - 2) ? at - 2 : at;
    const before = text[start - 1];
    const after = text[at + path.length];
    const ends =
      !after ||
      !PATH_CHARACTER.test(after) ||
      (after === '.' && !PATH_CHARACTER.test(text[at + path.length + 1] ?? ''));
    if ((!before || !PATH_CHARACTER.test(before)) && ends) return true;
  }
  return false;
}

/** Collects the files a check's output names, relative to DIR (absolute, file:// and ./ forms,
 * :line:col suffixes, Windows and escaped separators included). CHANGED paths are found as whole
 * strings first, so a name with spaces or quotes is never split, and past every cap: the change's own
 * failure is always seen. Other names are bounded; past the caps `overflow` is set. */
function mentions(dir: string, known: (path: string) => boolean, changed: ReadonlySet<string>) {
  const prefixes = [dir];
  try {
    prefixes.push(realpathSync(dir));
  } catch {
    /* The path as given still matches. */
  }
  // Changed paths a token split would cut, and the last piece of each (seen alone: named only in part).
  const split = [...changed]
    .filter(path => SEPARATOR.test(path))
    .map(path => ({ path, tail: path.split(SEPARATOR).pop() ?? '' }))
    // A bare extension (".md") or a tiny piece is too common to say the path was named in part.
    .map(entry => (entry.tail.length >= 3 && !/^\.\w*$/.test(entry.tail) ? entry : { ...entry, tail: '' }));
  const seen = new Set<string>();
  const own = new Set<string>();
  const paths: string[] = [];
  const forge: string[] = [];
  let carry = '';
  let overflow = false;
  let partial = false;
  const line = (raw: string) => {
    let text = raw
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      .replace(/\\ /g, ' ')
      .replace(/\\/g, '/')
      .split('file://')
      .join('');
    for (const prefix of prefixes) text = text.split(`${prefix}/`).join('');
    for (const { path, tail } of split)
      if (namesPath(text, path)) own.add(path);
      else if (tail && text.includes(tail)) partial = true;
    for (const match of text.matchAll(TOKEN)) {
      const token = match[0]
        .replace(/^\.\//, '')
        .replace(/(:\d+)+:?$/, '')
        .replace(/:$/, '');
      if (!token || token.length > 512) continue;
      if (changed.has(token)) {
        own.add(token);
        continue;
      }
      if (seen.has(token)) continue;
      // Past the cap, keep looking for changed paths only (a set lookup, no file check).
      if (seen.size >= MAX_TOKENS) {
        overflow = true;
        continue;
      }
      seen.add(token);
      if (!safeRelative(token) || !known(token)) continue;
      const into = forgeWritten(token) ? forge : paths;
      if (into.length >= MAX_FILES) overflow = true;
      else into.push(token);
    }
  };
  return {
    push: (text: string) => {
      const lines = (carry + text).split('\n');
      carry = lines.pop() ?? '';
      for (const each of lines) line(each);
    },
    end: (): Found => {
      if (carry) line(carry);
      carry = '';
      return { own: [...own], paths, forge, overflow, partial };
    },
  };
}

/** Whether two failure outputs are the same once their directories and timings are set aside. */
function sameFailure(head: string, root: string, base: string, dir: string) {
  const normal = (text: string, at: string) =>
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
      .split(at)
      .join('<root>')
      .replace(/\b\d+(\.\d+)?\s?(ms|s)\b/g, '<time>')
      .trim();
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return (
    normal(normal(head, root), real(root)) === normal(normal(base, dir), real(dir)) && head.trim() !== ''
  );
}

/** A temporary copy of the Lane's base: the Lane's files with each changed path put back as base has
 * it (or removed when base lacks it). Dependency folders and symbolic links point at the Lane's own;
 * files are cloned where the filesystem can (same volume), else copied. Null when any changed path's
 * base bytes are unknown here: an incomplete copy would judge the wrong tree. */
function copyBase(root: string, changed: string[], scope: StaticScope): string | null {
  if (!scope.base) return null;
  const bytes = new Map<string, Buffer | null>();
  for (const path of changed) {
    if (!safeRelative(path)) return null;
    const content = scope.base(path);
    if (content === undefined) return null;
    bytes.set(path, content);
  }
  let dir: string | undefined;
  try {
    if (scope.scratch) mkdirSync(scope.scratch, { recursive: true, mode: 0o700 });
    dir = mkdtempSync(join(scope.scratch ?? dirname(root), 'forge-static-base-'));
    copyTree(root, dir, '');
    for (const [path, content] of bytes) {
      const target = join(dir, path);
      rmSync(target, { recursive: true, force: true });
      if (content) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    }
    return dir;
  } catch {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

function copyTree(from: string, to: string, at: string) {
  for (const entry of readdirSync(join(from, at), { withFileTypes: true })) {
    // A version-control folder is not part of the tree under check. Forge's own metadata is copied, so
    // a tool that reads it fails the same way on both sides.
    if (!at && entry.name === '.git') continue;
    const path = at ? `${at}/${entry.name}` : entry.name;
    const source = join(from, path);
    const target = join(to, path);
    if (entry.name === 'node_modules' || entry.isSymbolicLink()) {
      try {
        const resolved = realpathSync(source);
        if (statSync(resolved).isDirectory()) linkDirectory(resolved, target);
        else writeSourceLink(resolved, target);
      } catch {
        /* A dangling link has nothing to point at. */
      }
    } else if (entry.isDirectory()) {
      mkdirSync(target);
      copyTree(from, to, path);
    } else if (entry.isFile()) copyFileSync(source, target, constants.COPYFILE_FICLONE);
  }
}
