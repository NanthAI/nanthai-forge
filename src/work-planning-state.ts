// SPDX-License-Identifier: Apache-2.0
import { digest } from './portable-hash.js';
import { invariant } from './errors.js';
import type { PlanningWrite } from './work-planning-types.js';
import type { WorkData } from './work-types.js';
import { isUnifiedWork } from './work-unified-types.js';
import { applyUnifiedPlanning, type UnifiedPlanningData } from './work-planning-unified.js';

// ponytail: derive current versions from retained planning history; index here if measured reads warrant it.
export const currentPlanning = (data: Pick<WorkData, 'planningItems'>) => [
  ...new Map(data.planningItems.map(item => [item.id, item])).values(),
];
export const normalizedPlanning = (command: PlanningWrite): PlanningWrite =>
  command.action === 'put-planning-item'
    ? { ...command, intentIds: [...new Set(command.intentIds)].sort() }
    : command;
export const planningRequest = (command: PlanningWrite) =>
  digest(JSON.stringify(normalizedPlanning(command)));
export function retainedPlanning(data: WorkData, command: PlanningWrite) {
  const retained =
    data.planningItems.find(item => item.operationId === command.operationId) ??
    data.planningComments.find(item => item.id === command.operationId);
  if (retained)
    invariant(
      retained.request === planningRequest(command),
      'WORK_OPERATION_CHANGED',
      'This planning operation has different inputs. Reconcile its original request.',
    );
  return retained;
}
/** Data-only reducer shared by local Work and the original hosted journal replay. */
export function applyPlanningMetadata(data: WorkData, command: PlanningWrite, at: string) {
  const retained = retainedPlanning(data, command);
  if (retained) return retained;
  if (isUnifiedWork(data))
    return applyUnifiedPlanning(
      data as unknown as UnifiedPlanningData,
      command,
      at,
      planningRequest(command),
    );
  const current = currentPlanning(data).find(item => item.id === command.itemId),
    request = planningRequest(command),
    provenance = 'user-declared-local' as const;
  if (command.action === 'comment-planning-item') {
    invariant(current, 'NOT_FOUND', 'Select an existing Issue or Initiative.');
    const comment = {
      id: command.operationId,
      itemId: current.id,
      request,
      authorLabel: command.authorLabel,
      text: command.text,
      at,
      provenance,
    };
    data.planningComments.push(comment);
    return comment;
  }
  invariant(
    (current?.version ?? 0) === command.expectedVersion,
    'PLANNING_CHANGED',
    'This item has a newer version. Load it before saving; your existing work remains available.',
  );
  invariant(
    !current || current.kind === command.kind,
    'BAD_ARGUMENT',
    'Retain the item’s original Issue or Initiative identity.',
  );
  invariant(
    command.intentIds.every(id => data.intents.some(item => item.id === id)),
    'NOT_FOUND',
    'Select existing local Intents.',
  );
  invariant(
    !command.initiativeId ||
      (command.kind === 'issue' &&
        currentPlanning(data).some(item => item.id === command.initiativeId && item.kind === 'initiative')),
    'NOT_FOUND',
    'Select an existing Initiative for the Issue.',
  );
  const item = {
    id: command.itemId,
    operationId: command.operationId,
    request,
    version: command.expectedVersion + 1,
    previousVersion: command.expectedVersion,
    kind: command.kind,
    title: command.title,
    body: command.body,
    status: command.status,
    intentIds: [...new Set(command.intentIds)].sort(),
    ...(command.initiativeId ? { initiativeId: command.initiativeId } : {}),
    at,
    provenance,
  };
  data.planningItems.push(item);
  return item;
}
export function exportPlanning(data: WorkData, project?: { key: string; name: string }) {
  const linked = new Set(data.planningItems.flatMap(item => item.intentIds));
  const manifest = {
    schema: 1,
    kind: project ? 'forge-hosted-planning' : 'forge-local-planning',
    workRevision: data.revision,
    items: data.planningItems,
    comments: data.planningComments,
    linkedIntents: data.intents.filter(item => linked.has(item.id)),
    ...(project
      ? {
          projectKey: project.key,
          name: project.name,
          events: data.hostedEvents.filter(
            item =>
              item.command.action === 'put-planning-item' || item.command.action === 'comment-planning-item',
          ),
        }
      : {}),
    coverage: project
      ? 'Private owner project planning versions, user-declared discussion and original server-recorded actor observations; not offline authenticated authorship, source objects, provider grants or acceptance decisions.'
      : 'Private local planning versions and user-declared discussion with original Intent metadata; no source objects, provider grants, verified identity or acceptance decision.',
  };
  const json = JSON.stringify(manifest, null, 2) + '\n';
  return { json, sha256: digest(json), filename: 'forge-planning.json' };
}
