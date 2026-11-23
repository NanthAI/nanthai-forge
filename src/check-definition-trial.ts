// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Definition trial (Item 687d1eda, docs/operations/github-actions-checks.md#definition-trial).
 *
 * A hosted check always runs main's check definition: the pinned control checkout's workflow,
 * planner and executor. A change to that definition (a coverage path: the standard check's entry,
 * inputs and selection inputs, or Forge's Actions workflow) is therefore checked by main's full
 * definition, and its own definition also runs once beside it, as Candidate code: the trial. The
 * trial only adds work. It never replaces a test main's plan runs, its test reports are never check
 * evidence, and its pass decides nothing; its failure fails the check. Like a pull request that
 * edits a workflow and runs its own version, without letting the edit judge itself.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { CheckGate } from './bet2-gate.js';
import { checkRunEntryPaths, coverageChangePaths } from './first-check-risk.js';
import { STANDARD_CHECK_ENTRY, STANDARD_CHECK_INPUTS, STANDARD_SELECTION_INPUTS } from './standard-check.js';
import { isBrowserTest } from '../scripts/browser-test-policy.mjs';

/** Set only for the trial child; the Candidate's entry then runs its own definition's extra tests. */
export const DEFINITION_TRIAL_ENV = 'FORGE_CHECK_TRIAL';
/** The Candidate's check entry declares that it runs the trial; read as data, never imported. */
const DECLARATION = /^export const CHECK_DEFINITION_TRIAL = (\d+);/m;
/** Paths named in the pinned plan; the rest are counted. */
const NAMED_PATHS = 20;
/** The standard check selects its tests through this module and every module it imports. */
const SELECTION_ROOT = 'scripts/test-impact.mjs';
/** A literal relative specifier after `from`, `import` (static, bare or dynamic) or `require`. Comment
 * mentions match too; they can only add a path. */
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;

/** The scripts/ modules scripts/test-impact.mjs imports, directly or through each other (selection-guard,
 * core-queue-paths, script-impact, docs-readers, the import graph): they decide which tests run, so
 * they are check definition. Read from the Candidate's inventory as text, never run: a Lane that
 * drops an import edits its importer, itself still in the list. The walk stays inside scripts/, the
 * only folder whose changes make the planner read the list; a selector import outside it would need
 * that condition widened. */
export function selectionModules(files: ReadonlyMap<string, string> | undefined): string[] {
  const found = new Set<string>();
  const pending = [SELECTION_ROOT];
  for (const path of pending)
    for (const [, specifier] of (files?.get(path) ?? '').matchAll(RELATIVE_IMPORT)) {
      const target = posix.join(posix.dirname(path), specifier!);
      if (!target.startsWith('scripts/') || found.has(target)) continue;
      found.add(target);
      pending.push(target);
    }
  return [...found].sort();
}

type TrialCheck = Parameters<typeof checkRunEntryPaths>[0] | undefined;
type DefinitionTrial = { paths: string[]; more?: number };

/** The changed paths that alter how Forge's standard check selects or runs tests, or null when the
 * run gets no trial: another command, no such path, or a main audit or failed-file probe (neither
 * judges a change before it lands). Paths, plus the selection modules read as text; no Candidate code runs. */
export function definitionTrialPaths(
  check: TrialCheck,
  gate: CheckGate | undefined,
  paths: readonly string[],
  files?: ReadonlyMap<string, string>,
): DefinitionTrial | null {
  if (gate?.mode === 'audit' || gate?.mode === 'probe') return null;
  // The standard check's own entries, whatever the run carries, plus its setup and declared risk paths.
  const entries = [STANDARD_CHECK_ENTRY, ...STANDARD_CHECK_INPUTS, ...STANDARD_SELECTION_INPUTS];
  // Only when a script changed: no inventory read for any other Lane.
  if (paths.some(path => path.startsWith('scripts/'))) entries.push(...selectionModules(files));
  if (Array.isArray(check?.args)) entries.push(...checkRunEntryPaths(check));
  const changed = coverageChangePaths(paths, entries);
  if (!changed.length) return null;
  const more = changed.length - NAMED_PATHS;
  return { paths: changed.slice(0, NAMED_PATHS), ...(more > 0 ? { more } : {}) };
}

/** Main's selection for a definition change: never narrower than main's full check, with the
 * trial pinned beside it. `full` computes main's full selection only when the gate chose less. */
export function definitionTrialSelection<S extends { scope: string; reason: string; tests: string[] }>(
  selected: S,
  trial: DefinitionTrial,
  full: () => S,
): S & { trial: DefinitionTrial } {
  if (selected.scope === 'full') return { ...selected, trial };
  const named = trial.paths[0] + (trial.paths.length + (trial.more ?? 0) > 1 ? ' and more' : '');
  const widened = full();
  return {
    ...widened,
    reason: `Check-definition change (${named}): main's full check plus a trial of this change's own definition`,
    trial,
  };
}

type TrialRecipe = {
  standard: boolean;
  groups: string[][];
  selection?: { browser?: unknown; trial?: unknown } | undefined;
};
/** The job index that runs the trial, or null without one: the browser job when the plan has one
 * (trial browser tests need its pinned Chromium), else the static job. */
export function definitionTrialShard(recipe: TrialRecipe): number | null {
  if (!recipe.standard || !recipe.selection?.trial) return null;
  const browser = recipe.selection.browser ? recipe.groups.findIndex(group => group.some(isBrowserTest)) : -1;
  return browser >= 0 ? browser : recipe.groups.length;
}

/** True when the Candidate's own check entry still runs the trial. Read before any Candidate code runs. */
export function declaresDefinitionTrial(directory: string) {
  const entry = join(directory, STANDARD_CHECK_ENTRY);
  try {
    const match = existsSync(entry) ? DECLARATION.exec(readFileSync(entry, 'utf8')) : null;
    return Number(match?.[1] ?? 0) >= 1;
  } catch {
    return false;
  }
}

const DEFINITION_TRIAL_UNDECLARED =
  `Definition trial: this change's ${STANDARD_CHECK_ENTRY} no longer declares CHECK_DEFINITION_TRIAL, so its own ` +
  'check definition cannot run beside main’s. Keep the trial entry (docs/operations/github-actions-checks.md#definition-trial).';

/** Runs the trial after the job's own command, once, and returns 1 when it fails the job. The trial
 * child's output reaches the log only: `spawn` never feeds test reports or JUnit evidence. */
export async function runDefinitionTrial(input: {
  declared: boolean;
  failed: boolean;
  spawn: () => Promise<number>;
  note: (line: string) => void;
}) {
  if (input.failed) {
    input.note('Definition trial: not run; this job already failed.');
    return 0;
  }
  if (!input.declared) {
    input.note(DEFINITION_TRIAL_UNDECLARED);
    return 1;
  }
  input.note(
    `Definition trial: running this change's own ${STANDARD_CHECK_ENTRY} beside main's check; it can only add failures.`,
  );
  const code = await input.spawn();
  input.note(
    code
      ? `Definition trial failed (exit ${code}): main's check passed, but this change's own check definition fails on it. Read the trial output above.`
      : "Definition trial passed: this change's own check definition runs nothing that fails.",
  );
  return code ? 1 : 0;
}
