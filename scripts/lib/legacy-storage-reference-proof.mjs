// SPDX-License-Identifier: Apache-2.0
import { readFile } from 'node:fs/promises';
import { closeBodies, catalogDigest, closureHash } from './legacy-storage-closure.mjs';
const proofFields = p => ({
  schema: p.schema,
  complete: p.complete,
  catalogDigest: p.catalogDigest,
  roots: p.roots,
  rootDigest: p.rootDigest,
  references: p.references,
  failures: p.failures,
  checkedAt: p.checkedAt,
  metrics: p.metrics,
});
export async function readBodyProof(path, audit) {
  if (!path) throw new Error('CLEANUP_BODY_COVERAGE_REQUIRED');
  const p = JSON.parse(await readFile(path, 'utf8'));
  if (
    p.schema !== 1 ||
    p.catalogDigest !== catalogDigest(audit.files) ||
    !Array.isArray(p.references) ||
    !Array.isArray(p.failures) ||
    closureHash(proofFields(p)) !== p.sha256
  )
    throw new Error('CLEANUP_BODY_PROOF_INVALID');
  return p;
}
export function requireBodyProof(proof) {
  if (proof.complete !== true || proof.failures.length) throw new Error('CLEANUP_BODY_COVERAGE_REQUIRED');
}
/** Immutable bodies can reuse full-hash inspection; the frozen roots and the
 * complete physical catalog must still be re-established in the pause. */
export async function withBodyCoverage(audit, scan, reader, config, out, progress) {
  const proof = await closeBodies(audit, scan, reader, config, out, { progress });
  requireBodyProof(proof);
  const covered = {
    ...scan,
    references: [...scan.references, ...proof.references],
    bodyCoverage: {
      complete: true,
      sha256: proof.sha256,
      catalogDigest: proof.catalogDigest,
      rootDigest: proof.rootDigest,
      checkedAt: proof.checkedAt,
    },
  };
  delete covered.sha256;
  covered.sha256 = closureHash(covered);
  return covered;
}

/** Only owner-approved removal of every referring row may precede closure.
 * This never qualifies file deletion: fresh frozen closure is still mandatory. */
export function requirePreparedBodies(proof, bench) {
  if (proof.complete) return requireBodyProof(proof);
  if (
    !bench ||
    !bench.sourceReferenceProof?.missingRootRefsAccounted ||
    bench.sourceReferenceProof.bodyCoverageSha256 !== proof.sha256 ||
    bench.sourceReferenceProof.missingRoots !== proof.failures.length ||
    !proof.failures.length ||
    proof.failures.some(
      f => f.code !== 'CLOSURE_BODY_MISSING' || f.node.kind !== 'r2' || f.node.project !== bench.projectId,
    )
  )
    throw new Error('CLEANUP_BODY_COVERAGE_REQUIRED');
}
