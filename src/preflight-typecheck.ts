// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join, normalize, relative } from 'node:path';
import { spawnCaptured } from './agent-preflight-capture.js';
import { ecosystemEntry, manifestNames, pinLockfiles } from './ecosystems.js';
import type { StaticCheck } from './agent-preflight-static.js';

/** The typecheck steps preflight derives from a project's own typecheck script (Item ad80e037 fix 6).
 * The landing check typechecks every TypeScript project the script names; a declared static list that
 * leaves one out (convex/ here, 11-19) lets a type error reach the landing check. So preflight reads the
 * script itself: each `tsc` (or `tsgo`) step becomes its own static check, and the commands before the
 * first one (code generation the compilers read, and npm's own `pre<script>`) run once first. A step
 * refuses a landing only in a project that declares its static checks (`preflight.static`, as Forge
 * does): elsewhere it is advice, since such a project may not keep its typecheck clean on main.
 * Nothing is guessed: a script with shell syntax this reader does not follow, or a `post<script>`,
 * runs whole, as advice. */
export const TYPECHECK_SCRIPTS = ['typecheck', 'type-check', 'check:types', 'check-types', 'types:check'];
/** A change to one of these reaches every program: compiler settings, and the JavaScript ecosystem's
 * manifests and lockfiles (installed types), named by the ecosystem registry. */
const js = [ecosystemEntry('js')];
const everyProgram = new Set([...manifestNames(js), ...pinLockfiles(js)]);
/** Paths that can change what any TypeScript program contains or how it checks. */
const TYPECHECK_INPUTS = [
  '**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx,json}',
  ...[...everyProgram].map(name => `**/${name}`),
];
const reachesEveryProgram = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return /^[jt]sconfig[^/]*\.json$/.test(name) || everyProgram.has(name);
};
const SOURCE = /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx|json)$/;

export type TypecheckStep = {
  /** The project file the step compiles, relative to the root; null when it cannot be listed
   * (build mode), so the step runs whenever a TypeScript input changes. */
  project: string | null;
  /** Commands the script runs before its first compiler step, in order. */
  setup: string[][];
};
export type TypecheckCheck = StaticCheck & { typecheck: TypecheckStep };

const npm = (script: string) => ['npm', 'run', '-s', script];

/** Words of a POSIX shell command joined by `&&`, one array per command. Null for anything else
 * (pipes, `;`, `||`, redirection, substitution, variables, unquoted globs, assignments): those run whole. */
export function shellSteps(text: string): string[][] | null {
  const steps: string[][] = [[]];
  let word: string | null = null;
  const end = () => {
    if (word !== null) steps.at(-1)!.push(word);
    word = null;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    // A newline separates commands in a shell: not a plain `&&` list.
    if (char === '\n' || char === '\r') return null;
    if (char === ' ' || char === '\t') end();
    else if (char === '&' && text[i + 1] === '&') {
      end();
      if (!steps.at(-1)!.length) return null;
      steps.push([]);
      i++;
    } else if (char === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return null;
      word = (word ?? '') + text.slice(i + 1, close);
      i = close;
    } else if (char === '"') {
      let value = '';
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '$' || text[i] === '`') return null;
        if (text[i] === '\\' && /["\\$`]/.test(text[i + 1] ?? '')) i++;
        value += text[i];
      }
      if (i >= text.length) return null;
      word = (word ?? '') + value;
    } else if (char === '\\') {
      if (i + 1 >= text.length) return null;
      word = (word ?? '') + text[++i];
    } else if (/[|;<>()$`*?[\]{}~#!&]/.test(char)) return null;
    else if (char === '=' && word !== null && !steps.at(-1)!.length) return null;
    else word = (word ?? '') + char;
  }
  end();
  return steps.every(step => step.length) ? steps : null;
}

/** The compiler step's project file, or undefined when STEP is not a TypeScript compiler run. */
function compilerProject(step: string[]): string | null | undefined {
  const at = step.findIndex(word => /(?:^|\/)(?:tsc|tsgo)$/.test(word));
  // `tsc` itself, `npx tsc`, or a runtime running the compiler's script (`node …/bin/tsc`).
  if (at < 0 || (at > 0 && !(at === 1 && /(?:^|\/)(?:node|npx|bunx|pnpx)$/.test(step[0]!)))) return undefined;
  const args = step.slice(at + 1);
  if (args.some(arg => arg === '-b' || arg === '--build' || arg === '--watch' || arg === '-w')) return null;
  const flag = args.findIndex(arg => arg === '-p' || arg === '--project');
  if (flag >= 0) {
    const value = args[flag + 1];
    return value ? (value.endsWith('.json') ? value : join(value, 'tsconfig.json')) : null;
  }
  // File arguments compile those files, not a project: list nothing, run it on any input.
  return args.some(arg => !arg.startsWith('-') && SOURCE.test(arg)) ? null : 'tsconfig.json';
}

/** The typecheck checks for SCRIPTS, unless DECLARED already runs that script. GATES: the project
 * declares its static checks, so its compiler steps refuse a landing like them; otherwise advice. */
export function typecheckChecks(
  scripts: Record<string, unknown>,
  declared: StaticCheck[],
  gates = true,
): TypecheckCheck[] {
  const name = TYPECHECK_SCRIPTS.find(each => typeof scripts[each] === 'string');
  if (!name) return [];
  const whole = npm(name).join(' ');
  if (declared.some(check => check.name === name || check.command.join(' ') === whole)) return [];
  const steps = shellSteps(scripts[name] as string);
  const projects = steps?.map(compilerProject);
  const first = projects?.findIndex(project => project !== undefined) ?? -1;
  // Every command after the first compiler step must be a compiler step too: otherwise the order
  // between them may matter, so the script runs whole.
  if (
    !steps ||
    first < 0 ||
    projects!.slice(first).some(project => project === undefined) ||
    typeof scripts[`post${name}`] === 'string'
  )
    return [
      {
        name,
        command: npm(name),
        inputs: TYPECHECK_INPUTS,
        source: 'conventional',
        typecheck: { project: null, setup: [] },
      },
    ];
  // `npm run` runs pre<script> first; generated code it writes is what the compiler reads.
  const setup = [
    ...(typeof scripts[`pre${name}`] === 'string' ? [npm(`pre${name}`)] : []),
    ...steps.slice(0, first),
  ];
  return steps.slice(first).map((command, index) => {
    const project = projects![first + index] as string | null;
    return {
      name: `typecheck ${project ?? command.join(' ').slice(0, 80)}`,
      command,
      inputs: TYPECHECK_INPUTS,
      source: gates ? 'derived' : 'conventional',
      typecheck: { project, setup },
    };
  });
}

export const isTypecheck = <T extends { typecheck?: TypecheckStep | undefined }>(
  check: T,
): check is T & { typecheck: TypecheckStep } => check.typecheck !== undefined;
type Step = { name: string; command: string[]; typecheck: TypecheckStep };

/** ENV with the project's own bin folder first on PATH, as its package scripts run (`tsc` alone). */
export function typecheckEnv(root: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, PATH: [join(root, 'node_modules', '.bin'), env.PATH].filter(Boolean).join(delimiter) };
}

/** Runs one setup command in ROOT, output to stderr; true when it exits 0 within TIMEOUT_MS. */
export function runTypecheckSetup(
  root: string,
  command: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) {
  process.stderr.write(`preflight: typecheck setup ${command.join(' ').slice(0, 120)}…\n`);
  const [program, ...args] = command as [string, ...string[]];
  const run = spawnCaptured(program, args, { cwd: root, env, timeout: timeoutMs }, false);
  if (run.status !== 0)
    process.stderr.write(
      `preflight: typecheck setup failed (${run.errorCode ?? `exit ${run.status}`}); every typecheck step runs and reports what it finds.\n`,
    );
  return run.status === 0;
}

/** The changed paths inside PROJECT's program (`--listFilesOnly`: every file the compiler reads,
 * includes and imports alike, relative to ROOT). Null when it cannot be listed: then it runs. */
function programTouches(root: string, check: Step, changed: Set<string>, env: NodeJS.ProcessEnv) {
  const [program, ...args] = check.command as [string, ...string[]];
  const listed = spawnSync(program, [...args, '--listFilesOnly'], {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  });
  if (listed.status !== 0) return null;
  const roots = [root];
  try {
    roots.push(realpathSync(root));
  } catch {
    /* The path as given still matches. */
  }
  for (const line of listed.stdout.split('\n')) {
    const path = line.trim();
    if (!path) continue;
    for (const at of roots) {
      const inside = relative(at, path).replaceAll('\\', '/');
      if (!inside.startsWith('../') && changed.has(inside)) return true;
    }
  }
  return false;
}

/** PROJECT and the local files it `extends` (any name, such as a monorepo's base.json), relative to
 * ROOT, so a change to a base config runs the steps that read it. Package specifiers are installed
 * packages (a manifest or lockfile change already runs every step). One visited list across every
 * branch: a cycle (which tsc reports itself) ends the walk, and at most 32 configs are read. */
export function configChain(root: string, project: string) {
  const chain: string[] = [];
  const local = (from: string, base: string) =>
    normalize(join(dirname(from), base.endsWith('.json') ? base : `${base}.json`));
  const walk = (at: string) => {
    if (chain.length >= 32 || chain.includes(at)) return;
    chain.push(at);
    let text: string;
    try {
      // JSONC comments that start a line out first, so a commented-out `extends` is not read (a
      // glob such as "src/**/*" inside a string is left alone).
      text = readFileSync(join(root, at), 'utf8').replace(/^\s*(?:\/\*[\s\S]*?\*\/|\/\/.*$)/gm, '');
    } catch {
      return;
    }
    const value = /"extends"\s*:\s*("(?:[^"\\]|\\.)*"|\[[^\]]*\])/.exec(text)?.[1];
    const bases = value ? [...value.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => match[1]!) : [];
    for (const base of bases) if (base.startsWith('.')) walk(local(at, base));
  };
  walk(normalize(project));
  return chain.map(path => path.replaceAll('\\', '/'));
}

/** Which typecheck steps the change reaches. A step whose program holds no changed path cannot fail
 * because of it, so it does not run here; the landing check still runs it. Every step runs when the
 * paths are unknown, compiler settings or installed packages change, a source file was removed (its
 * importers are in some program, it no longer is), or a program cannot be listed. SETUP runs first,
 * once, because listing reads what it generates; its own failure leaves every step to run and say so. */
export function selectTypechecks<T extends Step>(
  root: string,
  checks: T[],
  changed: string[] | null | undefined,
  env: NodeJS.ProcessEnv,
  run: (command: string[]) => boolean,
): { selected: T[]; untouched: string[] } {
  if (!checks.length) return { selected: [], untouched: [] };
  const setupOk = (checks[0]!.typecheck.setup ?? []).every(command => run(command));
  if (
    !setupOk ||
    !changed ||
    changed.some(path => reachesEveryProgram(path) || (SOURCE.test(path) && !existsSync(join(root, path))))
  )
    return { selected: checks, untouched: [] };
  const paths = new Set(changed);
  const selected: T[] = [];
  const untouched: string[] = [];
  for (const check of checks)
    if (
      check.typecheck.project === null ||
      configChain(root, check.typecheck.project).some(path => paths.has(path)) ||
      programTouches(root, check, paths, env) !== false
    )
      selected.push(check);
    else untouched.push(check.name);
  return { selected, untouched };
}
