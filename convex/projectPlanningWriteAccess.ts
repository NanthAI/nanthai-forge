// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { isShelved, type PlanningItem, type PlanningWrite } from '../src/work-planning-types';

const bodyPut = new Set([
  'action',
  'operationId',
  'itemId',
  'expectedVersion',
  'body',
  'agent',
  'agentClient',
]);
const capture = new Set([...bodyPut, 'kind', 'title', 'status', 'initiativeId', 'type']);

/** The enclosing Work mutation has already checked the current write role and device scope. Keep every other
 * planning operation owner-only, including versions restore (title + body), close, shelf moves and purge. */
export function memberPlanningWrite(command: PlanningWrite, tick: boolean) {
  if (command.action === 'comment-planning-item') return Boolean(tick && command.decision && command.line);
  if (typeof command.body !== 'string') return false;
  return command.expectedVersion === 0
    ? command.kind === 'issue' &&
        command.status === 'open' &&
        Boolean(command.title) &&
        Object.keys(command).every(key => capture.has(key))
    : Object.keys(command).every(key => bodyPut.has(key));
}

/** A member edits an exact existing Item, never an Initiative, alias or shelved Item. No extra record read. */
export function memberPlanningTarget(item: Pick<PlanningItem, 'kind' | 'status' | 'purged'> | undefined) {
  return item?.kind === 'issue' && !isShelved(item.status) && !item.purged;
}
