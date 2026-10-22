// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finishChild, laneFinishes, type FinishAttempt } from './agent-finish-journal.js';
import {
  landingAttemptId,
  landingSubmission,
  queuedOutcome,
  reviewedOutcome,
  type Submission,
} from './landing-submission.js';
import type { LandEntry } from './land-journal.js';
import type { FinishAction } from './agent-workflow-schema.js';
import type { WorkStore } from './work-store.js';

export function landSubmissions(store: WorkStore, entry: LandEntry) {
  const queued = store.select('landingEntries', entry.command.operationId);
  const result = queued
    ? queuedOutcome(store, queued)
    : reviewedOutcome(
        store,
        entry.result ?? { status: 'queued' },
        entry.single?.viewId ??
          entry.viewId ??
          (typeof entry.result?.viewId === 'string' ? entry.result.viewId : undefined),
        entry.command.accept?.channel ?? 'main',
      );
  const attemptId = queued
    ? landingAttemptId(queued)
    : entry.single
      ? finishChild(entry.command.operationId, `single:${entry.single.attempt}:attempt`)
      : entry.viewId
        ? finishChild(entry.command.operationId, 'land-compose')
        : null;
  return entry.inputs.map(pin => ({
    ...landingSubmission(
      store,
      entry.submissionOperationId ?? entry.command.operationId,
      pin,
      result,
      attemptId,
    ),
    entryOperationId: entry.command.operationId,
  }));
}
/** Read-only local driver adapters. Work remains the authority for queued outcomes. */
export function readLaneSubmissions(store: WorkStore, laneId?: string, operationId?: string): Submission[] {
  const submissions = new Map<string, Submission>();
  const operationIds = new Set(operationId ? [operationId] : []);
  const add = (submission: Submission) => submissions.set(submission.submissionId, submission);
  const directory = join(store.directory, 'agent-land');
  if (existsSync(directory))
    for (const name of readdirSync(directory).filter(name =>
      operationId
        ? [operationId, finishChild(operationId, 'overlap-land')].some(id => name === `${id}.json`)
        : /^[0-9a-f-]+\.json$/.test(name),
    )) {
      const state = JSON.parse(readFileSync(join(directory, name), 'utf8')) as { entries: LandEntry[] };
      for (const entry of state.entries) {
        operationIds.add(entry.command.operationId);
        if (
          (!laneId || entry.inputs.some(pin => pin.laneId === laneId)) &&
          entry.inputs.every(pin => store.select('lanes', pin.laneId))
        )
          for (const submission of landSubmissions(store, entry))
            if (!laneId || submission.laneId === laneId) add(submission);
      }
    }
  for (const finish of laneFinishes(store, laneId, operationId)) {
    const attempt = finish.attempts.at(-1);
    if (!attempt || !finish.command.accept) continue;
    const command = finish.command as FinishAction;
    if (
      ![command.laneId, ...(command.withInputs ?? []).map(pin => pin.laneId)].every(id =>
        store.select('lanes', id),
      )
    )
      continue;
    const result = finish.result ?? {
      status:
        attempt.status ??
        (attempt.run?.status === 'passed' ? 'waiting to land' : (attempt.run?.status ?? 'queued')),
    };
    for (const submission of finishSubmissions(
      store,
      finish.command as FinishAction,
      finish.attempts,
      result,
    ))
      if (!laneId || submission.laneId === laneId) {
        const delegated = submissions.get(submission.submissionId);
        if (!finish.result && delegated && delegated.entryOperationId !== submission.entryOperationId) {
          add({ ...delegated, head: submission.head });
          continue;
        }
        for (const existing of submissions.values())
          if (
            existing.entryOperationId === submission.entryOperationId &&
            existing.laneId === submission.laneId &&
            existing.submissionId !== submission.submissionId
          )
            submissions.delete(existing.submissionId);
        add(submission);
      }
  }
  const tx = store.readRecords();
  const entries = operationId
    ? [...operationIds].flatMap(id => {
        const entry = store.select('landingEntries', id);
        return entry ? [entry] : [];
      })
    : tx
      ? Array.from({ length: tx.manifest.collections.landingEntries?.count ?? 0 }, (_, i) =>
          tx.at('landingEntries', i),
        )
      : (store.load().landingEntries ?? []);
  for (const entry of entries) {
    const view = store.select('views', entry.viewId);
    for (const pin of view?.inputs ?? [])
      if (!laneId || pin.laneId === laneId) {
        const previous = [...submissions.values()].find(
          item => item.entryOperationId === entry.id && item.laneId === pin.laneId,
        );
        const submission = landingSubmission(
          store,
          previous?.operationId ?? entry.id,
          previous ? { ...pin, head: previous.head } : pin,
          queuedOutcome(store, entry),
          landingAttemptId(entry),
          pin.head,
        );
        add({ ...submission, entryOperationId: entry.id });
      }
  }
  return [...submissions.values()];
}

export function finishSubmissions(
  store: WorkStore,
  command: FinishAction,
  attempts: FinishAttempt[],
  result: Record<string, unknown>,
) {
  if (Array.isArray(result.entries)) {
    const entries = result.entries as {
      operationId: string;
      inputs: LandEntry['inputs'];
      submissions?: Submission[];
    }[];
    return entries.flatMap(entry =>
      landSubmissions(store, {
        command: { operationId: entry.operationId, accept: command.accept } as FinishAction,
        submissionOperationId: command.operationId,
        inputs: entry.inputs,
        result: entry,
      }).map((submission, index) => ({
        ...submission,
        head:
          submission.laneId === command.laneId
            ? attempts[0]!.head
            : (command.withInputs?.find(pin => pin.laneId === submission.laneId)?.head ?? submission.head),
        attemptId: submission.attemptId ?? entry.submissions?.[index]?.attemptId ?? null,
      })),
    );
  }
  const attempt = attempts.at(-1)!;
  const queued = store.select('landingEntries', command.operationId);
  const pins = [{ laneId: command.laneId, head: attempts[0]!.head }, ...(command.withInputs ?? [])];
  return pins.map(pin =>
    landingSubmission(
      store,
      command.operationId,
      pin,
      queued
        ? queuedOutcome(store, queued)
        : reviewedOutcome(
            store,
            result,
            attempt.view?.viewId as string | undefined,
            command.accept?.channel ?? 'main',
          ),
      queued ? landingAttemptId(queued) : attempt.operationId,
      pin.laneId === command.laneId ? String(attempt.sync?.head ?? attempt.head) : pin.head,
    ),
  );
}
