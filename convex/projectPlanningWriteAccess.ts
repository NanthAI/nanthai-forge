// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { isShelved, type PlanningItem, type PlanningWrite } from '../src/work-planning-types';
import { candidateLineNote } from '../src/candidate-line-note';
import { invariant } from '../src/errors';
import { hostedRecordSchema } from '../src/hosted-records';
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { readHostedIntentLabel, readHostedRecord } from './projectHostedRecords';

const bodyPut = new Set([
  'action',
  'operationId',
  'itemId',
  'expectedVersion',
  'body',
  'agent',
  'agentClient',
]);
const newInitiative = new Set([...bodyPut, 'kind', 'title', 'status']);
const capture = new Set([...newInitiative, 'initiativeId', 'type', 'parentId']);
const itemLinks = new Set([...bodyPut, 'parentId', 'relations', 'order', 'initiativeId']);
const creationUndo = new Set([...bodyPut, 'status', 'reason']);
const planProposed = new Set([
  'action',
  'operationId',
  'itemId',
  'expectedVersion',
  'status',
  'statusPin',
  'agent',
  'agentClient',
]);

export const memberCreationUndo = (command: Extract<PlanningWrite, { action: 'put-planning-item' }>) =>
  command.expectedVersion === 1 &&
  command.status === 'abandoned' &&
  command.reason === 'Undone' &&
  command.body === undefined &&
  Object.keys(command).every(key => creationUndo.has(key));

export const memberPlanProposed = (command: Extract<PlanningWrite, { action: 'put-planning-item' }>) =>
  command.expectedVersion > 0 &&
  command.status === 'open' &&
  command.statusPin === null &&
  Object.keys(command).every(key => planProposed.has(key));

/** The enclosing Work mutation has already checked the current write role and device scope. Keep every other
 * planning operation owner-only, including versions restore (title + body), close, shelf moves and purge. */
export function memberPlanningWrite(command: PlanningWrite, tick: boolean, projected?: true) {
  if (command.action === 'comment-planning-item')
    return Boolean((tick && command.decision && command.line) || (!tick && candidateLineNote(command)));
  // Only the internal append's already-authorized projection can carry a server-derived Undo pin.
  if (projected && command.statusPinBy !== undefined) {
    const requested = { ...command };
    delete requested.statusPinBy;
    return !tick && memberCreationUndo(requested);
  }
  if (command.expectedVersion === 0)
    return (
      command.status === 'open' &&
      Boolean(command.title) &&
      typeof command.body === 'string' &&
      (command.kind === 'issue'
        ? Object.keys(command).every(key => capture.has(key))
        : command.kind === 'initiative' && Object.keys(command).every(key => newInitiative.has(key)))
    );
  if (Object.keys(command).every(key => bodyPut.has(key))) return typeof command.body === 'string';
  if (!tick && (memberCreationUndo(command) || memberPlanProposed(command))) return true;
  return (
    !tick &&
    command.body === undefined &&
    (command.initiativeId === undefined || command.parentId !== undefined) &&
    Object.keys(command).every(key => itemLinks.has(key))
  );
}

/** The Candidate and Lane must belong to this exact Item. The reported line/claim is advisory, not proof. */
export async function requireCandidateLineNote(
  ctx: MutationCtx,
  auth: { projectId: Id<'hostedProjects'>; actor: string },
  command: Extract<PlanningWrite, { action: 'comment-planning-item' }>,
) {
  const note = candidateLineNote(command);
  invariant(note, 'PROJECT_UNAVAILABLE', 'Select one line on an exact Candidate to add a note.');
  const [view, lane] = await Promise.all([
    readHostedRecord(ctx, { ...auth, kind: 'candidate', key: note.candidateId }),
    readHostedRecord(ctx, { ...auth, kind: 'lane', key: note.laneId }),
  ]);
  invariant(
    view && lane && view.parent && view.parent === lane.parent,
    'PROJECT_UNAVAILABLE',
    'Select a Candidate for this Lane.',
  );
  const candidate = hostedRecordSchema.options[3].parse(JSON.parse(view.value));
  invariant(
    candidate.result.status === 'clean' &&
      candidate.result.head === note.head &&
      candidate.base.head === note.base,
    'PROJECT_UNAVAILABLE',
    'Select the Candidate’s exact version pair.',
  );
  const item = await readHostedIntentLabel(ctx, { ...auth, intentId: view.parent });
  invariant(
    item.itemId === command.itemId,
    'PROJECT_UNAVAILABLE',
    'This Candidate does not belong to that Item.',
  );
}

/** A member edits an exact existing Item, never an Initiative, alias or shelved Item. No extra record read. */
export function memberPlanningTarget(item: Pick<PlanningItem, 'kind' | 'status' | 'purged'> | undefined) {
  return item?.kind === 'issue' && !isShelved(item.status) && !item.purged;
}
