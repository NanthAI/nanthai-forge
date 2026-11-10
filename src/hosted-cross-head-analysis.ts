// SPDX-License-Identifier: Apache-2.0
import { parseNativeState, type NativeState } from './native-state-format.js';
import { digest } from './hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import {
  crossHeadProofSchema,
  pathsOverlap,
  type CleanDisjointProof,
  type CrossHeadProof,
  type FastFirstCheckProof,
} from './hosted-cross-head-proof.js';
import {
  FIRST_CHECK_RISK_RULE,
  firstCheckRiskPaths,
  globalRiskBetween,
  orderSensitiveRisk,
} from './first-check-risk.js';
import type { FastRelaxed } from './landing-mode.js';
import { markdownPath, pinnedTestedDocs, TESTED_DOCS_RULE } from './tested-docs.js';
import { pinnedPackagePlacement, placeableRisk, placedRiskBetween } from './package-placement.js';

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
  | 'order-sensitive'
  | 'composition-not-exact'
  | 'unsupported-mode'
  | 'checked-not-full'
  | 'audit-not-full'
  | 'source-unavailable';
export type FirstCheckDecision =
  | {
      proof:
        | CleanDisjointProof
        | FastFirstCheckProof
        | Extract<CrossHeadProof, { algorithm: 'exact-tree-v1' }>;
    }
  | { reason: FirstCheckRecheck };
const entries = (state: NativeState) => new Map(state.files.map(file => [file.path, file]));
// Entries are strict {path, blob, mode} records, so equal blob and mode is the whole equality; comparing
// the fields avoids a schema-validated canonical encoding of every entry of every manifest.
type Entry = NativeState['files'][number];
const same = (a: Entry | undefined, b: Entry | undefined) =>
  a === b || (!!a && !!b && a.blob === b.blob && a.mode === b.mode);
const changed = (before: NativeState, after: NativeState) => {
  const a = entries(before),
    b = entries(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter(path => !same(a.get(path), b.get(path))).sort();
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
 * list) and the server composed it as a clean text merge. A manifest or lockfile
 * inside a package is risk only for the packages the checked selection's pinned
 * package graph says it reaches. Any doubt returns a recheck reason.
 *
 * `fast` (the project's earned, fresh fast landing mode, src/landing-mode.ts) relaxes two
 * refusals: a tested-doc overlap, and global risk that is not order-sensitive. Risk that is
 * order-sensitive is refused as `order-sensitive` in both modes, so the reason class says what
 * fast mode would and would not have carried. */
export async function analyzeCrossHeadReuse(
  basis: Basis,
  selectionPin: string,
  read: Reader,
  checkEntries: readonly string[] = [],
  fast = false,
  exactTreeOnly = false,
): Promise<FirstCheckDecision> {
  const heads = [basis.checkedBase.head, basis.checked.head, basis.main.head, basis.head];
  const manifestBytes = await read(heads);
  if (manifestBytes.length !== 4 || manifestBytes.some((bytes, i) => !bytes || digest(bytes) !== heads[i]))
    return { reason: 'source-unavailable' };
  const [base, checked, main, merged] = manifestBytes.map(parseNativeState);
  const candidatePaths = changed(base!, checked!),
    mainPaths = changed(base!, main!);
  if (exactTreeOnly) {
    if (changed(checked!, merged!).length) return { reason: 'composition-not-exact' };
    const [selectionBytes, auditBytes] = await read([selectionPin, basis.audit.selection]);
    const selection = json(selectionBytes, selectionPin),
      audit = json(auditBytes, basis.audit.selection);
    if (!selection || !audit) return { reason: 'source-unavailable' };
    if (selection.scope !== 'full') return { reason: 'checked-not-full' };
    if (audit.scope !== 'full') return { reason: 'audit-not-full' };
    const proof = crossHeadProofSchema.parse({
      ...basis,
      algorithm: 'exact-tree-v1',
      candidatePaths,
      mainPaths,
      checkedScope: 'full',
      checkEntries: [...checkEntries],
      checkedSelection: selectionPin,
      cleanComposition: true,
    }) as Extract<CrossHeadProof, { algorithm: 'exact-tree-v1' }>;
    return Buffer.byteLength(canonicalPayload(proof)) <= 128 * 1024
      ? { proof }
      : { reason: 'source-unavailable' };
  }
  if (!candidatePaths.length || !mainPaths.length) return { reason: 'composition-not-exact' };
  // Exact paths both sides changed; a directory/file prefix collision is never a docs overlap.
  const mainSet = new Set(mainPaths),
    docsOverlap = candidatePaths.filter(path => mainSet.has(path)),
    docsSet = new Set(docsOverlap);
  const rest = (paths: string[]) => paths.filter(path => !docsSet.has(path));
  if (pathsOverlap(rest(candidatePaths), mainPaths) || pathsOverlap(candidatePaths, rest(mainPaths)))
    return { reason: 'path-overlap' };
  if (!docsOverlap.every(markdownPath)) return { reason: 'path-overlap' };
  // A manifest or lockfile inside a package may still be placed by the checked run's package graph
  // (rule v3, Issue 5cfcca4b); every other risk path decides here, on paths alone.
  const risky = globalRiskBetween(candidatePaths, mainPaths, checkEntries);
  const sensitive = risky && orderSensitiveRisk(candidatePaths, mainPaths, checkEntries).length > 0;
  const riskRefusal = sensitive ? ('order-sensitive' as const) : ('global-risk' as const);
  const relaxRisk = fast && risky && !sensitive;
  const relaxed: FastRelaxed[] = [];
  if (risky && !relaxRisk && !placeableRisk(candidatePaths, mainPaths, checkEntries))
    return { reason: riskRefusal };
  // The recomposition must be precisely the union of both deltas, including modes/deletions.
  // An overlapping Markdown file is the server's clean text merge: it exists on all four
  // sides as a plain file (no add, delete or mode change) and takes the composed bytes.
  const current = entries(main!),
    expected = new Map(current),
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
  // Paths are unique per manifest (parseNativeState), so the recomposition is exact when both sides
  // hold the same paths with the same blob and mode; order is not part of it.
  if (
    expected.size !== composed.size ||
    [...expected].some(([path, file]) => !same(file, composed.get(path)))
  )
    return { reason: 'composition-not-exact' };
  // A symlink or submodule that either delta adds, removes or retargets can redirect what
  // the other side's paths resolve to, so path-disjointness no longer holds. Untouched
  // links (any repository with a linked skills folder or a vendored submodule) are the
  // same bytes on all four sides, so only the changed paths are judged.
  const sides = [original, source, current, composed];
  if (
    [...candidatePaths, ...mainPaths].some(path =>
      sides.some(side => {
        const mode = side.get(path)?.mode;
        return mode !== undefined && mode !== 'file' && mode !== 'executable';
      }),
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
  // A placed manifest is the stronger evidence, so it is tried first even in fast mode.
  const placement = risky
    ? placedRiskBetween(candidatePaths, mainPaths, checkEntries, pinnedPackagePlacement(selection))
    : [];
  if (!placement && !relaxRisk) return { reason: riskRefusal };
  if (!placement) relaxed.push('global-risk');
  const placed = placement ?? [];
  if (docsOverlap.length) {
    // Tested on the checked source, or on the audited main (when its run pinned a list).
    const checkedDocs = pinnedTestedDocs(selection),
      auditDocs = pinnedTestedDocs(audit);
    if (!checkedDocs || docsOverlap.some(path => checkedDocs.has(path) || auditDocs?.has(path))) {
      if (!fast) return { reason: 'tested-doc' };
      relaxed.push('tested-doc');
    }
  }
  const proof = crossHeadProofSchema.parse({
    ...basis,
    ...(relaxed.length
      ? {
          algorithm: 'fast-first-check-v1',
          relaxed,
          riskPaths: relaxed.includes('global-risk')
            ? firstCheckRiskPaths([...candidatePaths, ...mainPaths], checkEntries).slice(0, 32)
            : [],
        }
      : { algorithm: 'clean-disjoint-v2', ...(placed.length ? { placedRisk: placed } : {}) }),
    candidatePaths,
    mainPaths,
    docsOverlap,
    testedDocsRule: TESTED_DOCS_RULE,
    checkedSelection: selectionPin,
    cleanComposition: true,
    riskRule: FIRST_CHECK_RISK_RULE,
    checkEntries: [...checkEntries],
    checkedScope,
  }) as CleanDisjointProof | FastFirstCheckProof;
  return Buffer.byteLength(canonicalPayload(proof)) <= 128 * 1024
    ? { proof }
    : { reason: 'source-unavailable' };
}
