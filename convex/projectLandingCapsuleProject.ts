// SPDX-License-Identifier: Apache-2.0
import { validateComposePage, composeLaneSchema } from '../src/hosted-compose';
import { sourceSubmission } from '../src/landing-submission-state';
import { supersededOutcome } from '../src/landing-state';
import type { LandingCapsule } from '../src/landing-capsule';
import {
  readLandingTransition,
  hostedLandingStateSchema,
  hostedLandingAttemptSchema,
  type HostedLandingState,
} from '../src/hosted-landing';
import { finishPendingForReader } from '../src/hosted-finish';
import { landingStateForReader } from './projectHostedLandingOrder';
import { landingAttemptProgress } from './projectHostedLandingStore';
import { readCapsuleAttemptCursor, capsuleAttemptCursor } from './projectLandingCapsuleContext';
import type { Doc } from './_generated/dataModel';
import { invariant } from '../src/errors';

type Context = Record<string, unknown>;
const attempts = (capsule: LandingCapsule) =>
  (capsule.tables.projectHostedLandingAttempts ?? [])
    .map(text => JSON.parse(text) as Doc<'projectHostedLandingAttempts'>)
    .sort((a, b) => a.number - b.number);

export function capsuleObserveReply(capsule: LandingCapsule, context: Context, command: Context) {
  const submission = context.submission as HostedLandingState;
  const archived = new Map(
    (capsule.tables.projectHostedLandingObservations ?? []).map(text => {
      const row = JSON.parse(text);
      return [row.version as number, row] as const;
    }),
  );
  const live = new Map(
    (context.events as Array<{ submission: { version: number } }>).map(event => [
      event.submission.version,
      event,
    ]),
  );
  const events = [];
  let nextVersion = Number(command.nextVersion),
    resnapshot = false;
  for (let n = 0; n < 20 && nextVersion <= submission.version; n++) {
    const row = archived.get(nextVersion),
      current = live.get(nextVersion);
    if (!row && !current) {
      events.push({
        submission,
        pendingAttempt: context.pendingAttempt,
        ...(context.wouldConflict ? { wouldConflict: context.wouldConflict } : {}),
      });
      nextVersion = submission.version + 1;
      resnapshot = true;
      break;
    }
    if (row) {
      const event = readLandingTransition(row.value, capsule.anchor);
      events.push({
        ...event,
        pendingAttempt: finishPendingForReader(event.pendingAttempt),
        submission: landingStateForReader(
          hostedLandingStateSchema.parse(event.submission),
          command.priorityInfo as 1 | undefined,
        ),
      });
    } else events.push(current!);
    nextVersion++;
  }
  return { ...context, events, nextVersion, resnapshot, isDone: nextVersion > submission.version };
}

export function capsuleStatusReply(capsule: LandingCapsule, context: Context) {
  const state = context.request as HostedLandingState;
  const row = attempts(capsule).find(row => row.attemptId === state.attemptId);
  invariant(row, 'SOURCE_UNAVAILABLE', 'The original landing attempt is unavailable.');
  return { ...context, attempt: hostedLandingAttemptSchema.parse(JSON.parse(row.value)) };
}

/** The capable-client ordinal cursor is stable on both sides of relocation. */
export function capsuleAttemptsReply(capsule: LandingCapsule, context: Context, command: Context) {
  const after = readCapsuleAttemptCursor(command.cursor as string | null, capsule.submissionId);
  const state = context.capsuleState as HostedLandingState;
  const remaining = new Map(
    attempts(capsule)
      .filter(row => row.number > after)
      .map(row => [
        row.number,
        {
          bytes: new TextEncoder().encode(JSON.stringify(row)).length,
          value: {
            ...JSON.parse(row.value),
            progress: landingAttemptProgress(row, state),
            observation: landingAttemptProgress(row, state)?.observation ?? null,
            superseded: row.attemptId !== state.attemptId,
          },
        },
      ]),
  );
  const liveBytes = new Map(context.capsuleLiveBytes as Array<[number, number]>);
  for (const value of context.page as Array<{ number: number }>)
    remaining.set(value.number, { bytes: liveBytes.get(value.number)!, value });
  const ordered = [...remaining.entries()].sort(([a], [b]) => a - b);
  const selected = [];
  let bytes = 0;
  for (const [number, row] of ordered) {
    if (selected.length && (selected.length === 100 || bytes + row.bytes > 128 * 1024)) break;
    selected.push({ number, value: row.value });
    bytes += row.bytes;
  }
  const result = { ...context };
  delete result.capsuleState;
  delete result.capsuleLiveBytes;
  return {
    ...result,
    isDone: context.isDone === true && selected.length === ordered.length,
    continueCursor: capsuleAttemptCursor(capsule.submissionId, selected.at(-1)?.number ?? after),
    page: selected.map(row => row.value),
  };
}

export function capsuleInputSelection(capsule: LandingCapsule, context: Context, command: Context) {
  const row = attempts(capsule).find(row => row.attemptId === command.attemptId);
  invariant(row, 'SOURCE_UNAVAILABLE', 'The original landing attempt is unavailable.');
  const attempt = hostedLandingAttemptSchema.parse(JSON.parse(row.value));
  invariant(
    attempt.submissionId === capsule.submissionId,
    'NOT_FOUND',
    'Attempt belongs to a different submission.',
  );
  const receiptId = attempt.operations.accept;
  const plan = (capsule.tables.projectHostedAcceptancePlans ?? [])
    .map(text => JSON.parse(text))
    .find(row => row.receiptId === receiptId);
  const stored = (capsule.tables.projectHostedAcceptancePages ?? [])
    .map(text => JSON.parse(text))
    .find(row => row.receiptId === receiptId && row.kind === 'inputs' && row.index === command.index);
  const page = stored ? validateComposePage(JSON.parse(stored.value)) : null;
  return {
    attempt,
    progress: landingAttemptProgress(row, context.capsuleState as HostedLandingState),
    page,
    pins: page ? page.entries.map(entry => composeLaneSchema.parse(entry)) : [],
    preparedPages: plan?.inputPages ?? 0,
  };
}

export function capsuleInputsReply(
  selection: ReturnType<typeof capsuleInputSelection>,
  context: Context,
  command: Context,
  sources: Array<{ laneId: string; source?: { head: string; intentId: string } }>,
) {
  const current = new Map(sources.map(lane => [lane.laneId, lane.source]));
  const state = context.capsuleState as HostedLandingState;
  const entries = selection.pins.map(pin => {
    const lane = current.get(pin.laneId);
    invariant(lane, 'SOURCE_UNAVAILABLE', 'Included Lane is unavailable.');
    const progress = selection.progress,
      observation = progress?.observation;
    invariant(observation, 'SOURCE_UNAVAILABLE', 'Historical attempt evidence is unavailable.');
    return {
      submissionId: state.id,
      operationId: state.operationId,
      laneId: pin.laneId,
      intentId: lane.intentId,
      head: pin.head,
      attemptHead: pin.head,
      ...(lane.head !== pin.head ? { supersededBy: lane.head } : {}),
      attemptId: selection.attempt.id,
      error: progress?.error ?? null,
      acceptance: progress?.acceptance ?? null,
      ...(observation.state === 'superseded'
        ? {
            ...sourceSubmission(supersededOutcome, lane.head, pin.head),
            state: 'superseded',
            terminal: true,
            complete: false,
          }
        : sourceSubmission({ ...observation, state: observation.state }, lane.head, pin.head)),
    };
  });
  return {
    entries,
    version: state.version,
    staged: selection.page !== null,
    nextIndex: selection.page ? (selection.page.next ? Number(command.index) + 1 : null) : command.index,
    preparedPages: selection.preparedPages,
  };
}
