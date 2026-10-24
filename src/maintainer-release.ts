// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkStore } from './work-store.js';
import { workLocked } from './work-lock.js';
import { nativeChannels } from './native-work.js';
import { invariant } from './errors.js';
import {
  releaseJson,
  releaseSave,
  releaseWrite,
  releaseQuote,
  releaseSelection,
} from './maintainer-release-files.js';
import {
  releaseJournalSchema,
  releaseRequestSchema,
  releaseStages,
  releaseReconciliationSchema,
  type ReleaseJournal,
  type ReleaseRequest,
  type ReleaseReceipt,
  type ReleaseStage,
} from './maintainer-release-schema.js';
import { releaseChild } from './maintainer-release-child.js';

export type ReleaseExecutor = (
  journal: ReleaseJournal,
  name: ReleaseStage,
  directory: string,
) => ReleaseReceipt;
export function releaseDirectory(store: WorkStore, id: string) {
  invariant(/^[0-9a-f-]{36}$/i.test(id), 'BAD_ARGUMENT', 'Select a release UUID.');
  return join(store.directory, 'maintainer-releases', id);
}
export function readMaintainerRelease(store: WorkStore, id: string) {
  return releaseJournalSchema.parse(releaseJson(join(releaseDirectory(store, id), 'release.json')));
}
function createRelease(store: WorkStore, input: ReleaseRequest): ReleaseJournal {
  invariant(store.native, 'BAD_ARGUMENT', 'Select a native Forge owner.');
  const request = releaseRequestSchema.parse(input);
  for (const key of [
    'runtimeDirectory',
    'configurationDirectory',
    'cliPath',
    'npmCli',
    'reuseExport',
  ] as const)
    if (request[key] !== undefined) request[key] = resolve(request[key]!);
  const directory = releaseDirectory(store, request.operationId);
  if (existsSync(join(directory, 'release.json'))) {
    const previous = readMaintainerRelease(store, request.operationId);
    invariant(
      JSON.stringify(previous.request) === JSON.stringify(request),
      'WORK_OPERATION_CHANGED',
      'Use the original release request or resume its ID.',
    );
    return previous;
  }
  const main = store.observing(() => nativeChannels(store.load()).find(channel => channel.name === 'main'));
  invariant(main?.head && main.moveId, 'NOT_FOUND', 'No accepted main is available to release.');
  const destination = join(request.runtimeDirectory, 'releases', request.operationId);
  invariant(
    !existsSync(destination) && !existsSync(directory),
    'RELEASE_DIRECTORY_EXISTS',
    'Existing release directories are preserved. Select a new operation ID.',
  );
  const { bytes: previous, ...previousCli } = releaseSelection(request.cliPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  releaseWrite(join(directory, 'previous-cli'), previous, 0o600);
  const journal: ReleaseJournal = {
    schema: 1,
    request,
    owner: store.root,
    head: main.head,
    acceptanceId: main.moveId,
    directory: destination,
    node: process.execPath,
    createdAt: new Date().toISOString(),
    previousCli,
    stages: releaseStages.map(name => ({ name, id: randomUUID(), attempts: [] })),
  };
  releaseSave(join(directory, 'release.json'), journal);
  return journal;
}
export function releaseSummary(journal: ReleaseJournal) {
  const pending = journal.stages.find(stage => {
    const attempt = stage.attempts.at(-1);
    return (attempt?.reconciliation?.outcome ?? attempt?.receipt?.status) !== 'succeeded';
  });
  const attempt = pending?.attempts.at(-1);
  return {
    operationId: journal.request.operationId,
    head: journal.head,
    acceptanceId: journal.acceptanceId,
    status: pending ? (attempt?.receipt?.status ?? 'pending') : 'succeeded',
    complete: !pending,
    stage: pending?.name ?? null,
    stages: journal.stages,
    installedHead: pending ? null : journal.head,
    previousCli: {
      ...journal.previousCli,
      path: join(
        journal.owner,
        '.forge',
        'work',
        'maintainer-releases',
        journal.request.operationId,
        'previous-cli',
      ),
    },
    landing: 'unchanged',
    hostedRecovery: 'unchanged',
    resume: `nforge release ${releaseQuote(journal.owner)} --resume ${journal.request.operationId}`,
  };
}
/** Release serialization is separate from the Work lock: landing can continue. */
export function maintainerRelease(
  store: WorkStore,
  input: ReleaseRequest | string,
  options: {
    execute?: ReleaseExecutor;
    reconcile?: unknown;
  } = {},
) {
  return workLocked(
    join(store.directory, 'maintainer-release-lock'),
    () => {
      const journal =
        typeof input === 'string' ? readMaintainerRelease(store, input) : createRelease(store, input);
      const save = () =>
        releaseSave(join(releaseDirectory(store, journal.request.operationId), 'release.json'), journal);
      if (options.reconcile) {
        // Refresh a surviving child's own receipt before applying an external observation.
        for (const stage of journal.stages) {
          const attempt = stage.attempts.at(-1);
          if (
            attempt &&
            !attempt.reconciliation &&
            (!attempt.receipt || attempt.receipt.status === 'unknown')
          ) {
            attempt.receipt = (options.execute ?? releaseChild)(journal, stage.name, attempt.directory);
            invariant(
              attempt.receipt.attemptId === attempt.id,
              'INVALID_RELEASE_RECEIPT',
              'Child receipt belongs to another attempt.',
            );
            save();
          }
        }
        const observation = releaseReconciliationSchema.parse(options.reconcile);
        const stage = journal.stages.find(stage => stage.name === observation.stage)!;
        const attempt = stage.attempts.find(attempt => attempt.id === observation.attemptId);
        invariant(
          attempt?.id === observation.attemptId &&
            attempt.receipt?.status === 'unknown' &&
            attempt.receipt.code !== 'RELEASE_RUNNING',
          'BAD_ARGUMENT',
          'Reconcile the selected unknown terminal attempt.',
        );
        invariant(
          !attempt.reconciliation ||
            JSON.stringify(attempt.reconciliation) ===
              JSON.stringify({ outcome: observation.outcome, evidence: observation.evidence }),
          'WORK_OPERATION_CHANGED',
          'Retain the original reconciliation.',
        );
        // Local success needs its original result paths; failed local attempts use fresh outputs.
        invariant(
          observation.outcome === 'failed' || stage.name === 'backend' || stage.name === 'web',
          'BAD_ARGUMENT',
          'Local success requires its durable child receipt; an interrupted local stage can be retried as failed.',
        );
        attempt.reconciliation = { outcome: observation.outcome, evidence: observation.evidence };
        save();
      }
      for (const stage of journal.stages) {
        let attempt = stage.attempts.at(-1);
        if (
          attempt &&
          !attempt.reconciliation &&
          (!attempt.receipt || attempt.receipt.status === 'unknown')
        ) {
          attempt.receipt = (options.execute ?? releaseChild)(journal, stage.name, attempt.directory);
          invariant(
            attempt.receipt.attemptId === attempt.id,
            'INVALID_RELEASE_RECEIPT',
            'Child receipt belongs to another attempt.',
          );
          save();
        }
        const status = attempt?.reconciliation?.outcome ?? attempt?.receipt?.status;
        if (status === 'succeeded') continue;
        if (status === 'unknown') return releaseSummary(journal);
        const directory = join(journal.directory, `${stage.name}-${randomUUID()}`);
        mkdirSync(directory, { mode: 0o700 });
        attempt = { id: randomUUID(), directory };
        stage.attempts.push(attempt);
        save();
        attempt.receipt = (options.execute ?? releaseChild)(journal, stage.name, directory);
        invariant(
          attempt.receipt.attemptId === attempt.id,
          'INVALID_RELEASE_RECEIPT',
          'Child receipt belongs to another attempt.',
        );
        save();
        if (attempt.receipt.status !== 'succeeded') return releaseSummary(journal);
      }
      return releaseSummary(journal);
    },
    { operation: 'maintainer release' },
  );
}
