// SPDX-License-Identifier: Apache-2.0
// Pure: also runs in the Convex non-Node runtime.
import { invariant } from './errors.js';
import { planningModelPutKeys, type PlanningItem, type PlanningWrite } from './work-planning-types.js';

export type PlanningPut = Extract<PlanningWrite, { action: 'put-planning-item' }>;

/**
 * The one place a put becomes a full item (local Work, hosted replay and the Convex projection
 * all reduce through it). A field the put omits keeps the stored value, so a status-only move
 * cannot clear a body; clearing a field needs an explicit empty value ("" / [] / null).
 * Creating needs kind and title; body, status and links default to empty/open.
 */
export function resolvePlanningPut(
  command: PlanningPut,
  current?: Pick<PlanningItem, 'kind' | 'title' | 'body' | 'status' | 'intentIds' | 'initiativeId'> &
    Partial<Pick<PlanningItem, (typeof planningModelPutKeys)[number]>>,
) {
  invariant(
    current || (command.kind && command.title),
    'BAD_ARGUMENT',
    'Creating a planning item needs `kind` and `title`.',
  );
  return {
    kind: (command.kind ?? current?.kind)!,
    title: (command.title ?? current?.title)!,
    body: command.body ?? current?.body ?? '',
    status: command.status ?? current?.status ?? 'open',
    intentIds: [...new Set(command.intentIds ?? current?.intentIds ?? [])].sort(),
    initiativeId: command.initiativeId === null ? undefined : (command.initiativeId ?? current?.initiativeId),
    reason: command.reason,
    model: resolveModelFields(command, current),
  };
}

const keep = <T>(next: T | null | undefined, stored: T | undefined) =>
  next === null ? undefined : (next ?? stored);
/** The model fields of the resolved item, absent ones left out so older items keep their exact bytes. */
function resolveModelFields(command: PlanningPut, current?: Partial<PlanningItem>) {
  const kind = command.kind ?? current?.kind;
  // Initiatives take no parent here: a retained legacy Initiative parentId stays on its record untouched.
  invariant(kind === 'issue' || !command.parentId, 'BAD_ARGUMENT', 'Only an Item can have a parent Item.');
  const parentId = kind === 'issue' ? keep(command.parentId, current?.parentId) : undefined;
  invariant(parentId !== command.itemId, 'BAD_ARGUMENT', 'An Item cannot be its own parent.');
  const relations = command.relations ?? current?.relations ?? [];
  invariant(
    relations.every(relation => relation.id !== command.itemId),
    'BAD_ARGUMENT',
    'An Item cannot relate to itself.',
  );
  const hidden = command.hidden === undefined ? current?.hidden : command.hidden || undefined;
  const fields = {
    order: keep(command.order, current?.order),
    type: keep(command.type, current?.type),
    parentId,
    owner: keep(command.owner, current?.owner),
    relations: relations.length ? relations : undefined,
    hidden: hidden ? (true as const) : undefined,
  };
  return Object.fromEntries(
    planningModelPutKeys.flatMap(key => (fields[key] === undefined ? [] : [[key, fields[key]]])),
  ) as Partial<Pick<PlanningItem, (typeof planningModelPutKeys)[number]>>;
}
