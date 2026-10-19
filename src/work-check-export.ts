// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { fingerprintPrivateFile } from './files.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { runOutputDirectory } from './work-run.js';
import type { WorkStore } from './work-store.js';
import { inspectArtifacts } from './work-artifacts.js';

export async function exportCheck(store: WorkStore, id: string, revision: number) {
  invariant(Number.isSafeInteger(revision) && revision >= 0, 'BAD_ARGUMENT', 'Send a valid work revision.');
  const run = store.load().runs.find(item => item.id === id);
  invariant(run, 'NOT_FOUND', 'Select an existing local check run.');
  const directory = runOutputDirectory(store, id);
  const logs = await Promise.all(
    (['stdout', 'stderr'] as const).map(async stream => {
      const path = join(directory, stream + '.log');
      return { stream, path, filename: `check-${id}-${stream}.log`, ...(await fingerprintPrivateFile(path)) };
    }),
  );
  const artifacts = await inspectArtifacts(directory, run);
  invariant(
    JSON.stringify(store.load().runs.find(item => item.id === id)) === JSON.stringify(run),
    'EVIDENCE_CHANGED',
    'The run changed during export. Its original output is retained; export its current observation again.',
  );
  const json =
    JSON.stringify(
      {
        schema: 1,
        kind: 'forge-local-check-evidence',
        run,
        logs: logs.map(({ stream, filename, size, sha256 }) => ({ stream, filename, size, sha256 })),
        ...(artifacts.length
          ? {
              artifacts: artifacts.map(({ sourcePath, exportFilename, size, sha256 }) => ({
                sourcePath,
                filename: exportFilename,
                size,
                sha256,
              })),
            }
          : {}),
        coverage: run.artifacts?.length
          ? 'Original local run and individually observed retained log hashes, with explicitly selected build outputs where recorded. Copy the local files alongside this manifest for portable evidence. No verified identity, complete external-input coverage, evidence reuse or atomic multi-file snapshot is claimed.'
          : 'Original local run and individually observed retained log hashes. Copy the local files alongside this manifest for portable evidence. No verified identity, external-input coverage, evidence reuse, build artifact or atomic multi-file snapshot is claimed.',
      },
      null,
      2,
    ) + '\n';
  return {
    revision: store.load().revision,
    result: { json, filename: `check-${id}.json`, sha256: digest(json), logs, artifacts },
  };
}
