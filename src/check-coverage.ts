import { postAcceptMoves } from './post-accept-coverage.js';
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coverageArtifact, type CoverageInput } from '../scripts/test-coverage.mjs';
import { selectionSourcePath } from '../scripts/test-impact.mjs';
import { NativeSource } from './native-source.js';
import { readSource } from './files.js';
import { digest } from './hash.js';
import type { CheckRun } from './work-types.js';
import type { WorkStore } from './work-store.js';

export const coverageSourcePath = 'coverage/test-impact.json';

/** Compact check artifact reconstructed from retained execution logs, with runner-owned source pins. */
export function retainCheckCoverage(
  store: WorkStore,
  run: CheckRun,
  directory: string,
  selection?: { scope: string; tests: string[] },
): NonNullable<CheckRun['artifacts']> {
  if (!store.native || selection?.scope !== 'full') return [];
  try {
    const source = new NativeSource(store.root);
    const state = source.state(run.head);
    const files = new Map(
      state.files
        .filter(file => selectionSourcePath(file.path))
        .map(file => [file.path, source.object(file.blob).toString('utf8')]),
    );
    const shards = join(directory, 'shards');
    const logs = existsSync(shards)
      ? readdirSync(shards)
          .filter(name => name.endsWith('.log'))
          .map(name => join(shards, name))
      : [join(directory, 'stdout.log')];
    function* lines() {
      for (const log of logs) yield* readFileSync(log, 'utf8').split('\n');
    }
    const artifact = coverageArtifact({ head: run.head, files, tests: selection.tests, lines: lines() });
    if (!artifact) return [];
    // Native blob identities hash exact bytes, including non-UTF-8 selector inputs.
    // Such input cannot match a lossy text inventory and therefore stays broad.
    artifact.digests = Object.fromEntries(
      state.files.filter(file => selectionSourcePath(file.path)).map(file => [file.path, file.blob]),
    );
    const bytes = JSON.stringify(artifact);
    mkdirSync(join(directory, 'artifacts'), { recursive: true, mode: 0o700 });
    const filename = `artifact-${run.check?.artifactPaths?.length ?? 0}.bin`;
    writeFileSync(join(directory, 'artifacts', filename), bytes, { mode: 0o600 });
    return [
      {
        status: 'retained',
        sourcePath: coverageSourcePath,
        filename,
        size: Buffer.byteLength(bytes),
        sha256: digest(bytes),
      },
    ];
  } catch {
    // Missing/truncated evidence cannot narrow selection or fail the command itself.
    return [];
  }
}

/** Only accepted main heads and passed full runs establish trace provenance/age. */
export function latestCheckCoverage(store: WorkStore, main: string): CoverageInput | undefined {
  if (!store.native) return undefined;
  try {
    const tx = store.readRecords(),
      data = tx ? tx.data() : store.load();
    const moves = postAcceptMoves(tx ? tx.all('channelMoves', 'main', 'channel') : data.channelMoves).filter(
      move => move.channel === 'main' && move.status === 'accepted',
    );
    const reverseIndex = moves
      .slice()
      .reverse()
      .findIndex(move => move.head === main);
    const index = reverseIndex < 0 ? -1 : moves.length - 1 - reverseIndex;
    if (index < 0) return undefined;
    for (let age = 0; age <= 10 && index - age >= 0; age++) {
      const head = moves[index - age]!.head;
      const move = moves[index - age]!;
      const runs = tx
        ? tx.all('runs', move.viewId, 'viewId')
        : data.runs.filter(run => run.viewId === move.viewId);
      if (move.postAcceptRunId) {
        const audit = tx
          ? tx.find('runs', move.postAcceptRunId)?.record
          : data.runs.find(run => run.id === move.postAcceptRunId);
        if (audit) runs.push(audit);
      }
      for (const run of runs
        .filter(run => run.head === head && run.status === 'passed' && run.checkSelection?.scope === 'full')
        .reverse()) {
        const entry = run.artifacts?.find(
          item => item.sourcePath === coverageSourcePath && item.status === 'retained',
        );
        if (!entry || entry.status !== 'retained') continue;
        const bytes = readSource(
          join(store.directory, `check-${run.id}`, 'artifacts'),
          entry.filename,
          entry.size,
        );
        if (!bytes || bytes.length !== entry.size || digest(bytes) !== entry.sha256) continue;
        const artifact = JSON.parse(bytes.toString('utf8'));
        if (artifact.head === head) return { artifact, head, age };
      }
    }
  } catch {
    /* Missing artifacts/history are conservative fallback, never reused verdicts. */
  }
  return undefined;
}
