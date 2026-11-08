// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import { globRegExp } from './path-glob.js';
import { declaredPreflight } from './project-config.js';

export { globRegExp };

/** A cheap, repository-wide check the landing check also runs. Declared as `preflight.static` in a
 * root forge.json (any language) or as `forge.preflight.static` in package.json; each entry is a
 * package.json script name or an object:
 * `{ name?, script? | command?: string[], inputs?: glob[] }`. `inputs` limits the check to changes
 * touching them; without it any change triggers the check. Absent a declaration, only formatter
 * checks the project already names conventionally run. Nothing else is guessed: an unknown
 * `check` script may be a full verification. */
export type StaticCheck = {
  name: string;
  command: string[];
  inputs: string[] | null;
  source: 'declared' | 'conventional';
};
export type StaticCheckResult = {
  name: string;
  outcome: 'passed' | 'failed' | 'timed-out';
  ms: number;
};
export const STATIC_CHECK_TIMEOUT_MS = 120_000;
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
      checks.push({
        name:
          typeof entry.name === 'string' && entry.name
            ? entry.name
            : String(entry.script ?? command.join(' ')),
        command,
        inputs: strings(entry.inputs),
        source: 'declared',
      });
    }
    return checks;
  }
  const script = CONVENTIONAL_FORMAT_SCRIPTS.find(name => typeof scripts[name] === 'string');
  return script ? [{ name: script, command: npm(script), inputs: CODE_INPUTS, source: 'conventional' }] : [];
}

/** A cheap guard test the project always wants run first when a change touches its `inputs`
 * (declared as `preflight.guards` in forge.json or `forge.preflight.guards` in package.json:
 * `{name, tests: [path, ...], inputs?: [glob, ...]}`).
 * Guards join the protected mandatory tier: the local time budget never trims or stops them. */
export type PreflightGuard = { name: string; tests: string[]; inputs: string[] | null };

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
    return { name: entry.name, tests, inputs: strings(entry.inputs) };
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
 * short and one report names every static problem). A check that exceeds its timeout is reported,
 * not counted as a pass or a failure: the landing check still runs it. */
export function runStaticChecks(
  root: string,
  checks: StaticCheck[],
  timeoutMs = STATIC_CHECK_TIMEOUT_MS,
): StaticCheckResult[] {
  return checks.map(check => {
    const started = Date.now();
    const [command, ...args] = check.command as [string, ...string[]];
    const run = spawnSync(command, args, { cwd: root, stdio: ['ignore', 2, 2], timeout: timeoutMs });
    const timedOut = (run.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    return {
      name: check.name,
      outcome: timedOut ? 'timed-out' : run.status === 0 ? 'passed' : 'failed',
      ms: Date.now() - started,
    };
  });
}
