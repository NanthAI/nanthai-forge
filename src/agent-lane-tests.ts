// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { latestCheckCoverage } from './check-coverage.js';
import { readTimingHistory } from '../scripts/test-timings-file.mjs';
import { NativeSource } from './native-source.js';
import { workGit } from './work-git.js';
import { checkChangedPaths } from './work-check-scope.js';
import { checkEnvironment } from './check-environment.js';
import { invariant } from './errors.js';
import { digest } from './hash.js';
import { candidateTimings } from './agent-contract-timings.js';
import {
  contractProposal,
  confirmTestContract,
  latestTestContract,
  type ContractTestsInput,
} from './intent-test-contract.js';
import type { WorkStore } from './work-store.js';
const quote = (value: string) =>
  /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
type Command = ContractTestsInput & { action?: 'tests' | 'confirm-tests' };

/** Proposals only read saved source; confirmations store metadata, never alter the gate. */
export async function agentLaneTests(store: WorkStore, input: Command | string) {
  const command: Command = typeof input === 'string' ? { laneId: input } : input;
  if (command.action !== 'confirm-tests') return store.observing(() => readLaneTests(store, command));
  const proposal = await readLaneTests(store, { ...command, runId: undefined }),
    { candidateId, head, intentId, contractVersion } = proposal.result;
  invariant(
    candidateId && command.runId,
    'BAD_ARGUMENT',
    'Confirm a clean Candidate with candidateId and timing runId.',
  );
  const request = digest(JSON.stringify(command));
  // Replayed confirmations survive later edits to the contract and the timing cache.
  const replay = store
    .select('intents', intentId)
    ?.testContracts?.find(contract => contract.operationId === command.operationId);
  if (replay) {
    invariant(
      replay.request === request,
      'WORK_OPERATION_CHANGED',
      'Replay the original contract confirmation.',
    );
    return { revision: store.revision(), result: { intentId, contract: replay, gate: 'unchanged' } };
  }
  const timings = await candidateTimings(store, command.runId, candidateId, head);
  const contract = confirmTestContract({
    command,
    candidateId,
    head,
    required: proposal.result.tests,
    available: proposal.result.available,
    timings,
    version: contractVersion,
    request,
    at: new Date().toISOString(),
  });
  return store.locked(
    () => {
      const tx = store.records(),
        found = tx.find('intents', intentId);
      invariant(found, 'NOT_FOUND', 'Intent not found.');
      const old = found.record.testContracts?.find(item => item.operationId === command.operationId);
      if (old) {
        invariant(
          old.request === request,
          'WORK_OPERATION_CHANGED',
          'Replay the original contract confirmation.',
        );
        return { revision: tx.revision, result: { intentId, contract: old, gate: 'unchanged' } };
      }
      invariant(
        (latestTestContract(found.record)?.version ?? 0) === contractVersion,
        'WORK_STALE',
        'The Intent contract changed. Read its proposal again.',
      );
      tx.replace('intents', found.position, {
        ...found.record,
        testContracts: [...(found.record.testContracts ?? []), contract],
      });
      return { revision: store.commitRecords(tx), result: { intentId, contract, gate: 'unchanged' } };
    },
    { operation: 'confirm Intent test contract' },
  );
}
async function readLaneTests(store: WorkStore, command: Command) {
  const tx = store.readRecords(),
    data = tx ? tx.data() : store.load();
  const lane = command.laneId ? store.select('lanes', command.laneId, 'id', true) : undefined;
  invariant(!command.laneId || lane, 'NOT_FOUND', 'Lane not found.');
  const candidate = command.candidateId ? store.select('views', command.candidateId) : undefined;
  invariant(
    !command.candidateId || (candidate?.status === 'clean' && candidate.head),
    'VIEW_STALE',
    'Select a clean Candidate.',
  );
  invariant(lane || candidate, 'BAD_ARGUMENT', 'Select laneId or candidateId.');
  invariant(
    !lane || !candidate || candidate.intentId === lane.intentId,
    'BAD_ARGUMENT',
    'Select this Lane’s Intent Candidate.',
  );
  const intentId = (candidate ?? lane)!.intentId,
    intent = store.select('intents', intentId);
  invariant(intent, 'NOT_FOUND', 'Intent not found.');
  const moves = tx ? tx.all('channelMoves', 'main', 'channel') : data.channelMoves;
  const main = candidate
    ? (candidate.composedMain ?? candidate.base)
    : store.native
      ? (moves
          .slice()
          .reverse()
          .find(move => move.channel === 'main' && move.status === 'accepted')?.head ?? data.nativeHead)
      : workGit(
          store.root,
          ['rev-parse', '--verify', '--quiet', 'refs/forge/channels/main'],
          undefined,
          true,
        ).trim() || lane!.base;
  invariant(main, 'NOT_FOUND', 'Main source not found.');
  const head = (candidate ?? lane)!.head!;
  invariant(
    !command.expectedHead || command.expectedHead === head,
    'VIEW_STALE',
    'Select the original Candidate head.',
  );
  const { standardSelection, selectionSourcePath } = await import('../scripts/test-impact.mjs');
  const files = new Map<string, string>();
  if (store.native) {
    const source = new NativeSource(store.root);
    for (const file of source.state(head).files)
      if (selectionSourcePath(file.path)) files.set(file.path, source.object(file.blob).toString('utf8'));
  } else {
    const tree = workGit(store.root, ['ls-tree', '-r', '-z', head]);
    for (const row of tree.split('\0').filter(Boolean)) {
      const split = row.indexOf('\t'),
        [, kind, blob] = row.slice(0, split).split(' '),
        path = row.slice(split + 1);
      if (kind === 'blob' && selectionSourcePath(path))
        files.set(
          path,
          workGit(store.root, ['cat-file', 'blob', blob!], undefined, false, true).toString('utf8'),
        );
    }
  }
  const paths = checkChangedPaths(store, main, head);
  const {
    scope,
    reason,
    tests: selected,
    coverage,
  } = standardSelection({
    coverage: latestCheckCoverage(store, main),
    files,
    paths,
    env: { ...checkEnvironment().env, FORGE_CHECK_SCOPED: '1' },
  });
  const available = [...files.keys()].filter(path => /^tests\/.+\.test\.mjs$/.test(path));
  const tests = [...new Set([...selected, ...paths.filter(path => available.includes(path))])].sort();
  const history = readTimingHistory(join(store.directory, 'test-timings.json'));
  const exact =
    command.runId && candidate ? await candidateTimings(store, command.runId, candidate.id, head) : undefined;
  const timings =
    exact ??
    Object.fromEntries(Object.entries(history.files).map(([path, value]) => [path, value.durationMs]));
  return {
    revision: data.revision,
    result: {
      scope,
      reason,
      tests,
      coverage,
      available,
      command: tests.length
        ? `node --import ./tests/check-runtime.mjs --test ${tests.map(quote).join(' ')}`
        : null,
      ...(lane ? { laneId: lane.id } : {}),
      head,
      main,
      intentId,
      candidateId: candidate?.id ?? null,
      contractVersion: latestTestContract(intent)?.version ?? 0,
      contract: latestTestContract(intent),
      contractProposal: {
        ...contractProposal(command.tests ?? tests, timings, tests),
        timingBasis: exact ? 'exact-candidate-run' : 'historical-estimate',
        measuredOn: exact ? head : null,
        runId: exact ? command.runId : null,
      },
    },
  };
}
