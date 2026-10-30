// SPDX-License-Identifier: Apache-2.0
import { documentation, selectImpactPair, smokeTests } from '../scripts/test-impact.mjs';

type Selection = { scope: 'full' | 'scoped'; reason: string; tests: string[] };
/** Runner-side selection on the exact recomposed Candidate, from one import graph.
 * Tests outside affected(main delta) ∩ affected(this change) passed on either the
 * checked head or main; they become main-audit debt, never a skipped own test. */
export function scopedRecheckSelection(input: {
  lanePaths: string[];
  mainPaths: string[];
  files: Map<string, string>;
  semanticTests?: string[];
}): Selection {
  const all = [...input.files.keys()].filter(path => /^tests\/[^/]+\.test\.mjs$/.test(path)).sort();
  const full = (reason: string): Selection => ({
    scope: 'full',
    reason: `Scoped recheck needs full: ${reason}`,
    tests: all,
  });
  const root = [...input.lanePaths, ...input.mainPaths].find(
    path => !path.includes('/') && !documentation(path),
  );
  if (root) return full(`root configuration ${root}`);
  const sides = selectImpactPair(input.files, [input.lanePaths, input.mainPaths]);
  const unclassified = sides.find(side => side.scope === 'full');
  if (unclassified) return full(unclassified.reason);
  const [lane, main] = sides.map(side => side.affectedTests ?? []);
  const shared = new Set(main);
  const both = lane!.filter(test => shared.has(test));
  const own = input.lanePaths.filter(path => all.includes(path));
  const semantic = input.semanticTests ?? [];
  if (semantic.some(test => !input.files.has(test)))
    throw new Error('An Intent contract test is absent from the composed Candidate.');
  const tests = [
    ...new Set([...both, ...own, ...semantic, ...smokeTests.filter(test => all.includes(test))]),
  ].sort();
  return {
    scope: 'scoped',
    reason:
      `Scoped recheck: ${both.length} tests affected by main and this change, ${own.length} own tests, ` +
      `fixed smoke; ${all.length - tests.length} of ${all.length} full-suite tests are main-audit debt`,
    tests,
  };
}
