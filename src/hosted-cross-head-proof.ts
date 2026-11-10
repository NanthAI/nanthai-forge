// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { canonicalPayload } from './hosted-source-operation.js';
import {
  FIRST_CHECK_RISK_RULES,
  globalRiskBetween,
  orderSensitiveRisk,
  riskRuleSince,
} from './first-check-risk.js';
import { FAST_RELAXED } from './landing-mode.js';
import { markdownPath, TESTED_DOCS_RULE } from './tested-docs.js';
import { validPlacedRisk } from './package-placement.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const main = z.object({ head: hash, receiptId: z.string().min(1) }).strict();
const selection = z
  .object({ head: hash, scope: z.enum(['docs', 'scoped']), tests: z.array(z.string()) })
  .strict();
const basis = {
  checked: z.object({ id: z.uuid(), head: hash, digest: hash }).strict(),
  checkedBase: main,
  main,
  head: hash,
  runId: z.uuid(),
  terminalDigest: hash,
  planDigest: hash,
  candidatePaths: z.array(z.string()),
  mainPaths: z.array(z.string()),
  checkedSelection: hash,
  cleanComposition: z.literal(true),
  audit: z
    .object({
      source: z.enum(['audit', 'main-receipt']),
      head: hash,
      runId: z.uuid(),
      terminalDigest: hash,
      planDigest: hash,
      selection: hash,
      sequence: z.number().safe().nonnegative(),
      coverage: z.literal('main-audit-debt'),
    })
    .strict(),
};
/** Retained for receipts and attempts written before 2026-11-06. */
const conservativeImpactProof = z
  .object({
    algorithm: z.literal('conservative-impact-v1'),
    ...basis,
    candidateSelections: z.array(selection).length(4),
    mainSelections: z.array(selection).length(4),
    candidateTests: z.array(z.string()),
    mainTests: z.array(z.string()),
  })
  .strict();
/** Land on the first check (owner decision 2026-11-06, Issue 7fe54c7c): a clean,
 * byte-exact composition whose paths are disjoint from main's gains and touch no
 * global-risk file. The main audit verifies the new head afterwards. */
const cleanDisjointV1 = {
  ...basis,
  riskRule: z.enum(FIRST_CHECK_RISK_RULES),
  checkEntries: z.array(z.string()),
  checkedScope: z.enum(['full', 'docs']),
};
/** Retained for receipts written before clean-disjoint-v2. */
const cleanDisjointProofV1 = z
  .object({ algorithm: z.literal('clean-disjoint-v1'), ...cleanDisjointV1 })
  .strict();
/** v1, plus paths both sides changed when each is a text-clean Markdown merge that
 * no test or script reads (owner decision 2026-11-06 10:45Z). */
const cleanDisjointProof = z
  .object({
    algorithm: z.literal('clean-disjoint-v2'),
    ...cleanDisjointV1,
    docsOverlap: z.array(z.string()),
    /** Entries (including absence) verified identical on checked, main and recomposed trees. */
    identicalPaths: z.array(z.string()).min(1).optional(),
    testedDocsRule: z.literal(TESTED_DOCS_RULE),
    /** Rule v3 and later (Issue 5cfcca4b): manifests and lockfiles placed inside a package, with
     * the package keys each can affect; the other side changed nothing those packages hold. */
    placedRisk: z
      .array(z.object({ path: z.string().min(1), reach: z.array(z.string().min(1)).min(1) }).strict())
      .min(1)
      .optional(),
  })
  .strict();
/** Fast landing mode (Issue 81d12a32): clean-disjoint-v2's composition rules, but the named refusal
 * classes were relaxed because the project has earned fast mode and its main audit was fresh. Never
 * holds an order-sensitive risk path. The main audit verifies the new head at once. */
const fastFirstCheckProof = z
  .object({
    algorithm: z.literal('fast-first-check-v1'),
    ...cleanDisjointV1,
    docsOverlap: z.array(z.string()),
    identicalPaths: z.array(z.string()).min(1).optional(),
    testedDocsRule: z.literal(TESTED_DOCS_RULE),
    relaxed: z.array(z.enum(FAST_RELAXED)).min(1).max(FAST_RELAXED.length),
    /** The global-risk paths that were relaxed (first 32). */
    riskPaths: z.array(z.string().min(1)).max(32),
  })
  .strict();
/** Recomposition changed ancestry only: the complete checked file tree, including
 * paths, blob hashes and modes, is unchanged. Still requires the current audit. */
const exactTreeProof = z
  .object({
    algorithm: z.literal('exact-tree-v1'),
    ...basis,
    checkedScope: z.literal('full'),
    checkEntries: z.array(z.string()),
  })
  .strict();
/** Server analysis of verified immutable bytes, never a client assertion. */
export const crossHeadProofSchema = z.discriminatedUnion('algorithm', [
  conservativeImpactProof,
  cleanDisjointProofV1,
  cleanDisjointProof,
  fastFirstCheckProof,
  exactTreeProof,
]);
export type FastFirstCheckProof = z.infer<typeof fastFirstCheckProof>;
/** A proof that needs the project's earned fast mode and a fresh audit when it is published. */
export const fastProof = (proof: CrossHeadProof | undefined): proof is FastFirstCheckProof =>
  proof?.algorithm === 'fast-first-check-v1';
export type CrossHeadProof = z.infer<typeof crossHeadProofSchema>;
export type CleanDisjointProof = z.infer<typeof cleanDisjointProof>;
/** A proof that landed a change on its first check (any clean-disjoint version, or fast mode). */
export const firstCheckProof = (proof: CrossHeadProof | undefined) =>
  proof?.algorithm === 'clean-disjoint-v1' ||
  proof?.algorithm === 'clean-disjoint-v2' ||
  proof?.algorithm === 'fast-first-check-v1';
/** True when a path of one list equals, contains or sits inside a path of the other. Linear in the
 * total path depth: each path checks its own ancestors against the other list's set. */
export function pathsOverlap(a: string[], b: string[]) {
  const inA = new Set(a),
    inB = new Set(b);
  const underAny = (path: string, set: Set<string>) => {
    for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1))
      if (set.has(path.slice(0, slash))) return true;
    return false;
  };
  return a.some(x => inB.has(x) || underAny(x, inB)) || b.some(y => underAny(y, inA));
}
export function validCrossHeadProof(proof: CrossHeadProof) {
  if (proof.algorithm === 'exact-tree-v1') return proof.checkedScope === 'full';
  const identical =
    proof.algorithm === 'clean-disjoint-v2' || proof.algorithm === 'fast-first-check-v1'
      ? (proof.identicalPaths ?? [])
      : [];
  const candidateSet = new Set(proof.candidatePaths),
    mainSet = new Set(proof.mainPaths);
  if (identical.some(path => !candidateSet.has(path) || !mainSet.has(path))) return false;
  const shared = new Set(identical);
  const candidatePaths = proof.candidatePaths.filter(path => !shared.has(path)),
    mainPaths = proof.mainPaths.filter(path => !shared.has(path));
  const docs =
    proof.algorithm === 'clean-disjoint-v2' || proof.algorithm === 'fast-first-check-v1'
      ? proof.docsOverlap
      : [];
  const docSet = new Set(docs);
  const rest = (paths: string[]) => paths.filter(path => !docSet.has(path));
  if (
    docs.some(path => shared.has(path)) ||
    pathsOverlap(rest(candidatePaths), mainPaths) ||
    pathsOverlap(candidatePaths, rest(mainPaths))
  )
    return false;
  if (proof.algorithm === 'fast-first-check-v1')
    return (
      proof.candidatePaths.length > 0 &&
      proof.mainPaths.length > 0 &&
      docs.every(path => markdownPath(path) && candidateSet.has(path) && mainSet.has(path)) &&
      // A relaxed class is named for what it relaxed, and nothing order-sensitive is ever relaxed.
      (!proof.relaxed.includes('tested-doc') || docs.length > 0) &&
      proof.relaxed.includes('global-risk') ===
        globalRiskBetween(candidatePaths, mainPaths, proof.checkEntries, proof.riskRule) &&
      orderSensitiveRisk(candidatePaths, mainPaths, proof.checkEntries, proof.riskRule).length === 0
    );
  if (proof.algorithm !== 'conservative-impact-v1')
    return (
      proof.candidatePaths.length > 0 &&
      proof.mainPaths.length > 0 &&
      docs.every(path => markdownPath(path) && candidateSet.has(path) && mainSet.has(path)) &&
      (proof.algorithm === 'clean-disjoint-v2' && proof.placedRisk
        ? riskRuleSince(proof.riskRule, 'first-check-risk-v3') &&
          validPlacedRisk({ ...proof, candidatePaths, mainPaths })
        : !globalRiskBetween(candidatePaths, mainPaths, proof.checkEntries, proof.riskRule))
    );
  const heads = [proof.checkedBase.head, proof.checked.head, proof.main.head, proof.head];
  const union = (selections: typeof proof.candidateSelections) =>
    [...new Set(selections.flatMap(s => s.tests))].sort();
  return (
    !proof.candidateTests.some(test => proof.mainTests.includes(test)) &&
    [proof.candidateSelections, proof.mainSelections].every(selections =>
      selections.every((s, i) => s.head === heads[i]),
    ) &&
    canonicalPayload(union(proof.candidateSelections)) === canonicalPayload(proof.candidateTests) &&
    canonicalPayload(union(proof.mainSelections)) === canonicalPayload(proof.mainTests)
  );
}
