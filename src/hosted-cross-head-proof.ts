// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { canonicalPayload } from './hosted-source-operation.js';
import { FIRST_CHECK_RISK_RULE, firstCheckRiskPaths } from './first-check-risk.js';
import { markdownPath, TESTED_DOCS_RULE } from './tested-docs.js';
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
  riskRule: z.literal(FIRST_CHECK_RISK_RULE),
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
    testedDocsRule: z.literal(TESTED_DOCS_RULE),
  })
  .strict();
/** Server analysis of verified immutable bytes, never a client assertion. */
export const crossHeadProofSchema = z.discriminatedUnion('algorithm', [
  conservativeImpactProof,
  cleanDisjointProofV1,
  cleanDisjointProof,
]);
export type CrossHeadProof = z.infer<typeof crossHeadProofSchema>;
export type CleanDisjointProof = z.infer<typeof cleanDisjointProof>;
/** A proof that landed a change on its first check (any clean-disjoint version). */
export const firstCheckProof = (proof: CrossHeadProof | undefined) =>
  proof?.algorithm === 'clean-disjoint-v1' || proof?.algorithm === 'clean-disjoint-v2';
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
  const docs = proof.algorithm === 'clean-disjoint-v2' ? proof.docsOverlap : [];
  const rest = (paths: string[]) => paths.filter(path => !docs.includes(path));
  if (
    pathsOverlap(rest(proof.candidatePaths), proof.mainPaths) ||
    pathsOverlap(proof.candidatePaths, rest(proof.mainPaths))
  )
    return false;
  if (proof.algorithm !== 'conservative-impact-v1')
    return (
      proof.candidatePaths.length > 0 &&
      proof.mainPaths.length > 0 &&
      docs.every(
        path => markdownPath(path) && proof.candidatePaths.includes(path) && proof.mainPaths.includes(path),
      ) &&
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
