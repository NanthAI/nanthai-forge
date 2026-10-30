// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { canonicalPayload } from './hosted-source-operation.js';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const main = z.object({ head: hash, receiptId: z.string().min(1) }).strict();
const selection = z
  .object({ head: hash, scope: z.enum(['docs', 'scoped']), tests: z.array(z.string()) })
  .strict();
/** Server analysis of verified immutable bytes, never a client assertion. */
export const crossHeadProofSchema = z
  .object({
    algorithm: z.literal('conservative-impact-v1'),
    checked: z.object({ id: z.uuid(), head: hash, digest: hash }).strict(),
    checkedBase: main,
    main,
    head: hash,
    runId: z.uuid(),
    terminalDigest: hash,
    planDigest: hash,
    candidatePaths: z.array(z.string()),
    mainPaths: z.array(z.string()),
    candidateSelections: z.array(selection).length(4),
    mainSelections: z.array(selection).length(4),
    candidateTests: z.array(z.string()),
    mainTests: z.array(z.string()),
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
  })
  .strict();
export type CrossHeadProof = z.infer<typeof crossHeadProofSchema>;
export function pathsOverlap(a: string[], b: string[]) {
  return a.some(x => b.some(y => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
}
export function validCrossHeadProof(proof: CrossHeadProof) {
  const heads = [proof.checkedBase.head, proof.checked.head, proof.main.head, proof.head];
  const union = (selections: CrossHeadProof['candidateSelections']) =>
    [...new Set(selections.flatMap(s => s.tests))].sort();
  return (
    !pathsOverlap(proof.candidatePaths, proof.mainPaths) &&
    !proof.candidateTests.some(test => proof.mainTests.includes(test)) &&
    [proof.candidateSelections, proof.mainSelections].every(selections =>
      selections.every((s, i) => s.head === heads[i]),
    ) &&
    canonicalPayload(union(proof.candidateSelections)) === canonicalPayload(proof.candidateTests) &&
    canonicalPayload(union(proof.mainSelections)) === canonicalPayload(proof.mainTests)
  );
}
