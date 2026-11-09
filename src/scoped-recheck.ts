// SPDX-License-Identifier: Apache-2.0
import { documentation, selectImpactPair, smokeTests } from '../scripts/test-impact.mjs';
import { docsReaders } from '../scripts/docs-readers.mjs';

/** `fallback` names why the recheck could not be scoped (src/fallback-reasons.ts). */
type Selection = {
  scope: 'full' | 'scoped';
  reason: string;
  tests: string[];
  fallback?: 'scoped-root-config' | 'scoped-unclassified';
};
type Side = ReturnType<typeof selectImpactPair>[number];
/** The standard plan's full suite in the composed Candidate (one rule, docs/forge-only-rules.md). */
const suiteTests = (files: Map<string, string>) =>
  [...files.keys()].filter(path => /^tests\/[^/]+\.test\.mjs$/.test(path)).sort();
const rootConfig = (paths: string[]) => paths.find(path => !path.includes('/') && !documentation(path));

/** Runner-side selection on the exact recomposed Candidate, from one import graph: the tests that
 * can see both changes, affected(main delta) ∩ affected(this change), plus this change's own test
 * files, the composed Intent union and fixed smoke. The rest passed on the checked head or on main
 * and become main-audit debt, never a skipped own test.
 *
 * Only this change's side can widen the recheck to the full suite (a root, unclassified or deleted
 * path, or the check pipeline). Main's delta already passed main's own checks: a main path the
 * selector cannot place reaches every test, so the shared set is this change's affected set (Issue
 * fc215574). A Markdown-only side is affected through the tests that read its documents, so a
 * change that meets main only on a tested document reruns just those readers (Issue debe08fa). */
export function scopedRecheckSelection(input: {
  lanePaths: string[];
  mainPaths: string[];
  files: Map<string, string>;
  semanticTests?: string[];
}): Selection {
  const all = suiteTests(input.files);
  const full = (reason: string, fallback: NonNullable<Selection['fallback']>): Selection => ({
    scope: 'full',
    reason: `Scoped recheck needs full: ${reason}`,
    tests: all,
    fallback,
  });
  const root = rootConfig(input.lanePaths);
  if (root) return full(`root configuration ${root}`, 'scoped-root-config');
  const [laneSide, mainSide] = selectImpactPair(input.files, [input.lanePaths, input.mainPaths]) as [
    Side,
    Side,
  ];
  if (laneSide.scope === 'full') return full(laneSide.reason, 'scoped-unclassified');
  const affected = (side: Side, paths: string[]) =>
    side.scope === 'docs'
      ? [...docsReaders(input.files, paths.filter(documentation)).keys()]
      : (side.affectedTests ?? []);
  const lane = affected(laneSide, input.lanePaths);
  const mainRoot = rootConfig(input.mainPaths);
  const everything = mainRoot
    ? `root configuration ${mainRoot}`
    : mainSide.scope === 'full'
      ? mainSide.reason
      : null;
  const shared = new Set(everything ? lane : affected(mainSide, input.mainPaths));
  const both = lane.filter(test => shared.has(test));
  const own = input.lanePaths.filter(path => all.includes(path));
  const semantic = input.semanticTests ?? [];
  if (semantic.some(test => !input.files.has(test)))
    throw new Error('An Intent contract test is absent from the composed Candidate.');
  const tests = [
    ...new Set([...both, ...own, ...semantic, ...smokeTests.filter(test => all.includes(test))]),
  ].sort();
  const basis = everything
    ? ` (main reaches every test: ${everything.slice(0, 120)})`
    : laneSide.scope === 'docs' || mainSide.scope === 'docs'
      ? ' (through the tests that read a changed document)'
      : '';
  return {
    scope: 'scoped',
    reason:
      `Scoped recheck: ${both.length} tests affected by main and this change${basis}, ${own.length} own tests, ` +
      `fixed smoke; ${all.length - tests.length} of ${all.length} full-suite tests are main-audit debt`,
    tests,
  };
}

/** A cohort's main-race recheck (Issue 28f08555): the union of each member's scoped selection, where a
 * member's change is what its full pass checked (checked base → checked head) and the other side is
 * everything that differs in the cohort's Candidate (main's delta and the other members). Any member
 * whose own side needs full (a root, unclassified or deleted path) keeps the full union. One graph:
 * `selectImpactPair` runs once per member on the same file map. */
export function batchScopedRecheckSelection(input: {
  members: { lanePaths: string[]; mainPaths: string[] }[];
  files: Map<string, string>;
  semanticTests?: string[];
}): Selection {
  const selections = input.members.map(member =>
    scopedRecheckSelection({ ...member, files: input.files, semanticTests: input.semanticTests ?? [] }),
  );
  const full = selections.find(selection => selection.scope === 'full');
  if (full) return { ...full, reason: `Cohort member: ${full.reason}` };
  const suite = suiteTests(input.files);
  const all = suite.length;
  // A cohort with no basis is never scoped (the gate parser refuses one); fail safe all the same.
  if (!selections.length)
    return {
      scope: 'full',
      reason: 'Scoped recheck needs full: cohort without a basis',
      tests: suite,
      fallback: 'scoped-unclassified',
    };
  const tests = [...new Set(selections.flatMap(selection => selection.tests))].sort();
  return {
    scope: 'scoped',
    reason:
      `Scoped cohort recheck: union of ${selections.length} member selection(s), ${tests.length} tests; ` +
      `${all - tests.length} of ${all} full-suite tests are main-audit debt`,
    tests,
  };
}
