// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { canonicalPayload } from './hosted-source-operation.js';
import { FIRST_CHECK_RISK_RULE, firstCheckRiskPaths } from './first-check-risk.js';
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
const cleanDisjointProof = z
  .object({
    algorithm: z.literal('clean-disjoint-v1'),
    ...basis,
    riskRule: z.literal(FIRST_CHECK_RISK_RULE),
    checkEntries: z.array(z.string()),
    checkedScope: z.enum(['full', 'docs']),
  })
  .strict();
/** Server analysis of verified immutable bytes, never a client assertion. */
export const crossHeadProofSchema = z.discriminatedUnion('algorithm', [
  conservativeImpactProof,
  cleanDisjointProof,
]);
export type CrossHeadProof = z.infer<typeof crossHeadProofSchema>;
export type CleanDisjointProof = z.infer<typeof cleanDisjointProof>;
export function pathsOverlap(a: string[], b: string[]) {
  return a.some(x => b.some(y => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
}
export function validCrossHeadProof(proof: CrossHeadProof) {
  if (pathsOverlap(proof.candidatePaths, proof.mainPaths)) return false;
  if (proof.algorithm === 'clean-disjoint-v1')
    return (
      proof.candidatePaths.length > 0 &&
      proof.mainPaths.length > 0 &&
      firstCheckRiskPaths([...proof.candidatePaths, ...proof.mainPaths], proof.checkEntries).length === 0
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
