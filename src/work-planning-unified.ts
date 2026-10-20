// SPDX-License-Identifier: Apache-2.0
import { planningIntentStatus } from './work-planning-lifecycle.js';
import { invariant } from './errors.js';
import { resolveIntentId, type IntentAlias } from './work-intent-local.js';
import type { PlanningItem, PlanningWrite } from './work-planning-types.js';
import type { WorkData } from './work-types.js';
import type { UnifiedIntent, UnifiedWorkData } from './work-unified-types.js';

type Initiative = UnifiedWorkData['initiatives'][number] & { nextMembershipOrder?: number };
/** The subset a schema-16 planning write reads; selected-record callers load only these records. */
export type UnifiedPlanningData = Pick<WorkData, 'planningItems' | 'planningComments'> & {
  intents: UnifiedIntent[];
  initiatives: Initiative[];
  intentAliases: IntentAlias[];
};
const provenance = 'user-declared-local' as const;

/**
 * Planning history for an Intent continues under its first retained Issue ID, so writes via
 * the folded Issue alias or the Intent ID extend one version chain.
 */
export function planningTarget(
  data: Pick<UnifiedPlanningData, 'intents' | 'initiatives' | 'intentAliases'>,
  itemId: string,
) {
  const initiative = data.initiatives.find(item => item.id === itemId);
  if (initiative) return { initiative, historyId: itemId };
  const intentId = resolveIntentId(data.intentAliases, itemId),
    intent = data.intents.find(item => item.id === intentId);
  return { intentId, intent, historyId: intent?.historyRefs[0]?.itemId ?? intentId };
}

function placeMemberships(
  data: UnifiedPlanningData,
  sourceId: string,
  initiativeId: string | undefined,
  intentIds: string[],
) {
  const group = initiativeId ? data.initiatives.find(item => item.id === initiativeId) : undefined;
  for (const intent of data.intents) {
    intent.memberships = intent.memberships.filter(
      item =>
        item.sourceId !== sourceId || (item.initiativeId === initiativeId && intentIds.includes(intent.id)),
    );
    if (!group || !intentIds.includes(intent.id)) continue;
    if (intent.memberships.some(item => item.sourceId === sourceId && item.initiativeId === group.id))
      continue;
    const order = group.nextMembershipOrder ?? 0;
    group.nextMembershipOrder = order + 1;
    intent.memberships.push({ initiativeId: group.id, sourceId, order });
  }
}

/**
 * Schema-16 reducer for the legacy planning command names. Issues are unified Intents;
 * Initiatives stay grouping records. Every write still appends its original planning version
 * or comment, which keeps retries, exports and the rollout hosted push exact.
 */
export function applyUnifiedPlanning(
  data: UnifiedPlanningData,
  command: PlanningWrite,
  at: string,
  request: string,
) {
  const target = planningTarget(data, command.itemId);
  if (command.action === 'comment-planning-item') {
    invariant(target.initiative || target.intent, 'NOT_FOUND', 'Select an existing Intent or Initiative.');
    const comment = {
      id: command.operationId,
      itemId: target.historyId,
      request,
      authorLabel: command.authorLabel,
      text: command.text,
      at,
      provenance,
    };
    data.planningComments.push(comment);
    target.intent?.conversation.push({ id: comment.id, kind: 'planning-comment', itemId: comment.itemId });
    return comment;
  }
  const current = data.planningItems.filter(item => item.id === target.historyId).at(-1);
  invariant(
    (current?.version ?? 0) === command.expectedVersion,
    'PLANNING_CHANGED',
    'This item has a newer version. Load it before saving; your existing work remains available.',
  );
  invariant(
    command.kind === 'initiative' ? !target.intent : !target.initiative,
    'BAD_ARGUMENT',
    'Retain the item’s original Issue or Initiative identity.',
  );
  const linked = [...new Set(command.intentIds.map(id => resolveIntentId(data.intentAliases, id)))].sort();
  invariant(
    linked.every(id => data.intents.some(item => item.id === id)),
    'NOT_FOUND',
    'Select existing local Intents.',
  );
  invariant(
    !command.initiativeId ||
      (command.kind === 'issue' && data.initiatives.some(item => item.id === command.initiativeId)),
    'NOT_FOUND',
    'Select an existing Initiative for the Issue.',
  );
  const item: PlanningItem = {
    id: target.historyId,
    operationId: command.operationId,
    request,
    version: command.expectedVersion + 1,
    previousVersion: command.expectedVersion,
    kind: command.kind,
    title: command.title,
    body: command.body,
    status: command.status,
    ...(command.reason !== undefined ? { reason: command.reason } : {}),
    intentIds: [...new Set(command.intentIds)].sort(),
    ...(command.initiativeId ? { initiativeId: command.initiativeId } : {}),
    at,
    provenance,
  };
  data.planningItems.push(item);
  if (command.kind === 'initiative') {
    // Update in place: selected-record callers track loaded records by identity.
    if (target.initiative) Object.assign(target.initiative, item, { kind: 'initiative' });
    else data.initiatives.push({ ...item, kind: 'initiative' });
    placeMemberships(data, item.id, item.id, linked);
    return item;
  }
  let intent = target.intent;
  if (!intent) {
    intent = {
      id: target.intentId!,
      title: item.title,
      outcome: item.title,
      description: item.body,
      constraints: '',
      status: 'active',
      notes: [],
      createdAt: at,
      memberships: [],
      relatedIntentIds: [],
      historyRefs: [],
      conversation: [],
    };
    data.intents.push(intent);
  }
  Object.assign(intent, {
    title: item.title,
    outcome: item.title,
    description: item.body,
    version: item.version,
    previousVersion: item.previousVersion,
    operationId: item.operationId,
    request,
    updatedAt: at,
  });
  // Once a Lane captured an execution pin, execution lifecycle owns status; the planning word stays history.
  if (!intent.base) {
    const status = planningIntentStatus(item.status);
    if (intent.status !== status) {
      (intent.lifecycle ??= []).push({
        from: intent.status,
        to: status,
        at,
        ...(item.reason !== undefined ? { reason: item.reason } : {}),
        operation: { id: item.operationId, request },
      });
      intent.status = status;
    }
  }
  intent.historyRefs.push({ itemId: item.id, version: item.version });
  // Current links replace current relations; original links remain in planning history.
  const nextRelated = linked.filter(id => id !== intent.id);
  for (const id of intent.relatedIntentIds)
    if (!nextRelated.includes(id)) {
      const other = data.intents.find(candidate => candidate.id === id);
      if (other) other.relatedIntentIds = other.relatedIntentIds.filter(id => id !== intent!.id);
    }
  intent.relatedIntentIds = nextRelated;
  for (const id of linked.filter(id => id !== intent.id)) {
    const other = data.intents.find(candidate => candidate.id === id)!;
    if (!other.relatedIntentIds.includes(intent.id)) other.relatedIntentIds.push(intent.id);
  }
  placeMemberships(data, item.id, command.initiativeId, [...new Set([intent.id, ...linked])]);
  return item;
}
