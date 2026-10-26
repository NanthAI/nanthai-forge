// SPDX-License-Identifier: Apache-2.0
import { performance } from 'node:perf_hooks';
import { capture, normalizeRoot } from './snapshot.js';
import { analyze, analysisProvider } from './analyze.js';
import { saveArtifact, loadArtifact } from './artifact.js';
import { ForgeError, invariant } from './errors.js';
import type { CompilerSession } from './compiler.js';
import type { GraphPack, Limits, Snapshot } from './types.js';

export { capture, DEFAULT_LIMITS } from './snapshot.js';
export { analyze } from './analyze.js';
export { validateArtifact } from './artifact-validation.js';
export { recoverSecretArchive } from './secretArchive.js';
export { secretKeyring, type SecretKeyring } from './secret-crypto.js';
export { ForgeError } from './errors.js';
export type * from './types.js';

export type IndexSession = CompilerSession;
export function indexRepository(root: string, limits?: Limits, session: IndexSession = {}) {
  const start = performance.now(),
    snapshot = capture(root, limits);
  let retained: GraphPack | undefined;
  try {
    retained = loadArtifact(snapshot.root);
  } catch (error) {
    if (!(error instanceof ForgeError))
      throw error; /* An unusable derived artifact is rebuilt from captured source. */
  }
  const reusedArtifact =
    retained?.source.id === snapshot.source.id &&
    JSON.stringify(retained.source) === JSON.stringify(snapshot.source) &&
    JSON.stringify(retained.analysis) === JSON.stringify(analysisProvider());
  const pack = reusedArtifact ? retained! : analyze(snapshot, session);
  const verification = capture(root, snapshot.source.policy.limits);
  invariant(
    snapshot.source.id === verification.source.id,
    'SOURCE_CHANGED',
    'Source changed during indexing; retry. Previous artifact is unchanged.',
  );
  if (!reusedArtifact) saveArtifact(snapshot.root, pack);
  return {
    pack,
    elapsedMs: Math.round(performance.now() - start),
    work: {
      reusedArtifact,
      sourceCaptures: 2,
      capturedFiles: snapshot.source.files.length + verification.source.files.length,
      capturedBytes: [...snapshot.source.files, ...verification.source.files].reduce(
        (sum, file) => sum + file.bytes,
        0,
      ),
      parsedFiles: reusedArtifact ? 0 : (session.parsedFiles ?? 0),
      reusedSyntaxFiles: reusedArtifact ? 0 : (session.reusedFiles ?? 0),
      analyzedFiles: reusedArtifact ? 0 : snapshot.source.files.length,
    },
  };
}
export function openRepository(root: string): {
  pack: GraphPack;
  snapshot: Snapshot;
  freshness: 'current' | 'stale';
} {
  const pack = loadArtifact(normalizeRoot(root));
  const snapshot = capture(root, pack.source.policy.limits);
  return { pack, snapshot, freshness: pack.source.id === snapshot.source.id ? 'current' : 'stale' };
}

export { autonomyPolicySchema, policyPreset, legacyPolicy } from './autonomy-policy.js';
export type { AutonomyPolicy, PolicyWrite, AcceptanceActor } from './autonomy-policy.js';
