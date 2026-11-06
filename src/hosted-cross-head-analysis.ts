// SPDX-License-Identifier: Apache-2.0
import { parseNativeState, type NativeState } from './native-state-format.js';
import { digest } from './hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import {
  crossHeadProofSchema,
  pathsOverlap,
  type CleanDisjointProof,
  type CrossHeadProof,
} from './hosted-cross-head-proof.js';
import { FIRST_CHECK_RISK_RULE, firstCheckRiskPaths } from './first-check-risk.js';
import { markdownPath, pinnedTestedDocs, TESTED_DOCS_RULE } from './tested-docs.js';

type Basis = Pick<
  CrossHeadProof,
  'checked' | 'checkedBase' | 'main' | 'head' | 'runId' | 'terminalDigest' | 'planDigest' | 'audit'
>;
type Reader = (digests: string[]) => Promise<Uint8Array[]>;
/** Why a change rechecks instead of landing on its first check (receipt field). */
export type FirstCheckRecheck =
  | 'path-overlap'
  | 'tested-doc'
  | 'global-risk'
  | 'composition-not-exact'
  | 'unsupported-mode'
  | 'checked-not-full'
  | 'audit-not-full'
  | 'source-unavailable';
export type FirstCheckDecision = { proof: CleanDisjointProof } | { reason: FirstCheckRecheck };
const entries = (state: NativeState) => new Map(state.files.map(file => [file.path, file]));
const changed = (before: NativeState, after: NativeState) => {
  const a = entries(before),
    b = entries(after);
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter(path => canonicalPayload(a.get(path) ?? null) !== canonicalPayload(b.get(path) ?? null))
    .sort();
};
const json = (bytes: Uint8Array | undefined, pin: string): Record<string, unknown> | null => {
  if (!bytes || digest(bytes) !== pin) return null;
  const value: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
};
/** Land on the first check (clean-disjoint-v2, Issue 7fe54c7c). Reads exactly the
 * four verified manifests and two selection pins: no source text, no import graph
 * and no repository code. Paths both sides changed are allowed only when every one
 * is a Markdown file that no test or script reads (the checked selection's pinned
 * list) and the server composed it as a clean text merge. Any doubt returns a
 * recheck reason. */
export async function analyzeCrossHeadReuse(
  basis: Basis,
  selectionPin: string,
  read: Reader,
  checkEntries: readonly string[] = [],
): Promise<FirstCheckDecision> {
  const heads = [basis.checkedBase.head, basis.checked.head, basis.main.head, basis.head];
  const manifestBytes = await read(heads);
  if (manifestBytes.length !== 4 || manifestBytes.some((bytes, i) => !bytes || digest(bytes) !== heads[i]))
    return { reason: 'source-unavailable' };
  const [base, checked, main, merged] = manifestBytes.map(parseNativeState);
  const candidatePaths = changed(base!, checked!),
    mainPaths = changed(base!, main!);
  if (!candidatePaths.length || !mainPaths.length) return { reason: 'composition-not-exact' };
  // Exact paths both sides changed; a directory/file prefix collision is never a docs overlap.
  const docsOverlap = candidatePaths.filter(path => mainPaths.includes(path));
  const rest = (paths: string[]) => paths.filter(path => !docsOverlap.includes(path));
  if (pathsOverlap(rest(candidatePaths), mainPaths) || pathsOverlap(candidatePaths, rest(mainPaths)))
    return { reason: 'path-overlap' };
  if (!docsOverlap.every(markdownPath)) return { reason: 'path-overlap' };
  if (firstCheckRiskPaths([...candidatePaths, ...mainPaths], checkEntries).length)
    return { reason: 'global-risk' };
  // The recomposition must be precisely the union of both deltas, including modes/deletions.
  // An overlapping Markdown file is the server's clean text merge: it exists on all four
  // sides as a plain file (no add, delete or mode change) and takes the composed bytes.
  const expected = entries(main!),
    source = entries(checked!),
    composed = entries(merged!),
    original = entries(base!);
  for (const path of docsOverlap) {
    const sides = [original, source, expected, composed].map(side => side.get(path));
    if (sides.some(file => file?.mode !== 'file')) return { reason: 'composition-not-exact' };
    expected.set(path, sides[3]!);
  }
  for (const path of rest(candidatePaths)) {
    const file = source.get(path);
    if (file) expected.set(path, file);
    else expected.delete(path);
  }
  if (
    canonicalPayload([...expected.values()].sort((a, b) => a.path.localeCompare(b.path))) !==
    canonicalPayload([...merged!.files].sort((a, b) => a.path.localeCompare(b.path)))
  )
    return { reason: 'composition-not-exact' };
  if (
    [base, checked, main, merged].some(state =>
      state!.files.some(f => !['file', 'executable'].includes(f.mode)),
    )
  )
    return { reason: 'unsupported-mode' };
  const [selectionBytes, auditBytes] = await read([selectionPin, basis.audit.selection]);
  const selection = json(selectionBytes, selectionPin),
    audit = json(auditBytes, basis.audit.selection);
  if (!selection || !audit) return { reason: 'source-unavailable' };
  // The first check must have run the project's whole check (or, for a docs-only
  // change, its docs selection); a scoped admission run never carries a landing.
  const checkedScope = selection.scope;
  if (checkedScope !== 'full' && checkedScope !== 'docs') return { reason: 'checked-not-full' };
  if (audit.scope !== 'full') return { reason: 'audit-not-full' };
  if (docsOverlap.length) {
    // Tested on the checked source, or on the audited main (when its run pinned a list).
    const checkedDocs = pinnedTestedDocs(selection),
      auditDocs = pinnedTestedDocs(audit);
    if (!checkedDocs || docsOverlap.some(path => checkedDocs.has(path) || auditDocs?.has(path)))
      return { reason: 'tested-doc' };
  }
  const proof = crossHeadProofSchema.parse({
    ...basis,
    algorithm: 'clean-disjoint-v2',
    candidatePaths,
    mainPaths,
    docsOverlap,
    testedDocsRule: TESTED_DOCS_RULE,
    checkedSelection: selectionPin,
    cleanComposition: true,
    riskRule: FIRST_CHECK_RISK_RULE,
    checkEntries: [...checkEntries],
    checkedScope,
  }) as CleanDisjointProof;
  return Buffer.byteLength(canonicalPayload(proof)) <= 128 * 1024
    ? { proof }
    : { reason: 'source-unavailable' };
}
