// SPDX-License-Identifier: Apache-2.0
import { digest } from './portable-hash.js';
import { invariant, itemChanged } from './errors.js';
import type { PlanningWrite } from './work-planning-types.js';
import type { WorkData } from './work-types.js';
import { isUnifiedWork } from './work-unified-types.js';
import { plannedLinkIds } from './work-planning-lifecycle.js';
import { resolvePlanningPut } from './work-planning-put.js';
import { applyUnifiedPlanning, type UnifiedPlanningData } from './work-planning-unified.js';

// ponytail: derive current versions from retained planning history; index here if measured reads warrant it.
export const currentPlanning = (data: Pick<WorkData, 'planningItems'>) => [
  ...new Map(data.planningItems.map(item => [item.id, item])).values(),
];
export const normalizedPlanning = (command: PlanningWrite): PlanningWrite =>
  command.action === 'put-planning-item'
    ? command.intentIds
      ? { ...command, intentIds: [...new Set(command.intentIds)].sort() }
      : command
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
  if ((current?.version ?? 0) !== command.expectedVersion)
    throw itemChanged({
      kind: 'issue',
      id: command.itemId,
      expectedVersion: command.expectedVersion,
      currentVersion: current?.version ?? 0,
    });
  const put = resolvePlanningPut(command, current);
  invariant(
    !current || current.kind === put.kind,
    'BAD_ARGUMENT',
    'Retain the item’s original Issue or Initiative identity.',
  );
  invariant(
    put.intentIds.every(id => data.intents.some(item => item.id === id)),
    'NOT_FOUND',
    'Select existing local Intents.',
  );
  invariant(
    !put.initiativeId ||
      (put.kind === 'issue' &&
        currentPlanning(data).some(item => item.id === put.initiativeId && item.kind === 'initiative')),
    'NOT_FOUND',
    'Select an existing Initiative for the Issue.',
  );
  const item = {
    id: command.itemId,
    operationId: command.operationId,
    request,
    version: command.expectedVersion + 1,
    previousVersion: command.expectedVersion,
    kind: put.kind,
    title: put.title,
    body: put.body,
    status: put.status,
    ...(put.reason !== undefined ? { reason: put.reason } : {}),
    intentIds: put.intentIds,
    ...(put.initiativeId ? { initiativeId: put.initiativeId } : {}),
    at,
    provenance,
  };
  data.planningItems.push(item);
  return item;
}
/** Hosted replay only: the put that appended a version (`count` = planningItems.length before it) records the
 * server-observed `actor` as the body's author when it wrote the body (or created the item); a put that
 * keeps the body (status move, reason, reopen) carries the earlier author. */
export function stampPlanningAuthor(data: WorkData, count: number, command: PlanningWrite, actor: string) {
  if (command.action !== 'put-planning-item' || data.planningItems.length !== count + 1) return;
  const item = data.planningItems[count]!;
  let author: string | undefined = actor;
  if (command.body === undefined && item.version > 1) {
    author = undefined;
    for (let index = count - 1; index >= 0; index--)
      if (data.planningItems[index]!.id === item.id) {
        author = data.planningItems[index]!.author;
        break;
      }
  }
  if (author) item.author = author;
}
export function exportPlanning(data: WorkData, project?: { key: string; name: string }) {
  // Issues link their planned Intent (id = Issue id) even with empty legacy intentIds; linkedIntents lists the ones that exist.
  const linked = new Set(data.planningItems.flatMap(plannedLinkIds));
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
