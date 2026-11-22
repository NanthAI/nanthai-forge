// SPDX-License-Identifier: Apache-2.0
import { digest } from './state/hash.js';
import { invariant } from './errors.js';
import { itemChanged, type PlanningWrite } from './work-planning-types.js';
import type { WorkData } from './work-types.js';
import { isUnifiedWork } from './work-unified-types.js';
import { plannedLinkIds } from './work-planning-lifecycle.js';
import type { landingNoteExport } from './intent-landing-note.js';
import {
  bodyWithDecision,
  decisionOperationId,
  discussionFields,
  refusePurged,
  resolvePlanningPut,
} from './work-planning-put.js';
import { applyUnifiedPlanning, type UnifiedPlanningData } from './work-planning-unified.js';

/** Only adjacent versions prove a change. Version one records the initial status. */
export function planningStatusTransition(
  version: { version: number; status: string },
  previous: typeof version | undefined,
) {
  if (version.version === 1) return true;
  if (previous?.version !== version.version - 1) return null;
  return previous.status !== version.status;
}

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
  if (retained) {
    invariant(
      retained.request === planningRequest(command),
      'WORK_OPERATION_CHANGED',
      'This planning operation has different inputs. Reconcile its original request.',
    );
    // A retry of a write on a since-purged Item answers purged, never its retained words.
    const itemId = 'itemId' in retained ? retained.itemId : retained.id;
    refusePurged(data.planningItems.filter(item => item.id === itemId).at(-1));
  }
  return retained;
}
/** A purged decision comment's derived body version (purge Lane 2, follow-up e). Its live request hashed the body
 * with the decision's words; a replay of the purged comment cannot rebuild that body, so the version's request is
 * derived from the comment's own (kept) request instead. The purge executor must write the same value into the live
 * version (and the Intent's request) when it redacts them, so the live and rebuilt indexes agree. */
export const purgedDecisionRequest = (commentRequest: string) =>
  digest(`planning-purged-decision:${commentRequest}`);
/** Data-only reducer shared by local Work and the original hosted journal replay. A decision comment also appends
 * its line to the Item body as the next version, in the same write (src/work-planning-put.ts). `request` is passed
 * only for a purged row (its original request hash, kept on the row). */
export function applyPlanningMetadata(data: WorkData, command: PlanningWrite, at: string, request?: string) {
  const retained = retainedPlanning(data, command);
  if (retained) return retained;
  const written = applyPlanningWrite(data, command, at, request ?? planningRequest(command));
  if (command.action !== 'comment-planning-item' || !command.decision) return written;
  const latest = data.planningItems
    .filter(item => item.id === (written as { itemId: string }).itemId)
    .at(-1)!;
  applyPlanningMetadata(
    data,
    {
      action: 'put-planning-item',
      operationId: decisionOperationId(command.operationId),
      itemId: command.itemId,
      expectedVersion: latest.version,
      body: bodyWithDecision(latest.body, {
        at,
        label: command.decidedBy ?? command.authorLabel,
        text: command.text,
        commentId: command.operationId,
      }),
    },
    at,
    request === undefined ? undefined : purgedDecisionRequest(request),
  );
  return written;
}
function applyPlanningWrite(data: WorkData, command: PlanningWrite, at: string, request: string) {
  if (isUnifiedWork(data))
    return applyUnifiedPlanning(data as unknown as UnifiedPlanningData, command, at, request);
  const current = currentPlanning(data).find(item => item.id === command.itemId),
    provenance = 'user-declared-local' as const;
  refusePurged(current);
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
      ...discussionFields(data.planningComments, current.id, command),
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
    ...put.model,
    ...put.agent,
    at,
    provenance,
  };
  data.planningItems.push(item);
  return item;
}
/** Hosted replay only: the put that appended a version (`count` = planningItems.length before it) records the
 * server-observed `actor` as the body's author when it wrote the body (or created the item); a put that
 * keeps the body (status move, reason, reopen) carries the earlier author. A new comment (`comments` =
 * planningComments.length before it) records the actor as its author, and so does a decision's body version. */
export function stampPlanningAuthor(
  data: WorkData,
  count: number,
  command: PlanningWrite,
  actor: string,
  comments = data.planningComments.length,
) {
  if (command.action === 'comment-planning-item') {
    if (data.planningComments.length === comments + 1) data.planningComments[comments]!.author = actor;
    if (data.planningItems.length === count + 1) data.planningItems[count]!.author = actor;
    return;
  }
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
export function exportPlanning(
  data: WorkData,
  project?: { key: string; name: string; landingNotes?: ReturnType<typeof landingNoteExport>[] },
) {
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
          landingNotes: project.landingNotes ?? [],
          events: data.hostedEvents.filter(
            item =>
              item.command.action === 'put-planning-item' || item.command.action === 'comment-planning-item',
          ),
        }
      : {}),
    coverage: project
      ? 'Private owner project planning versions, user-declared discussion, system landing notes and original server-recorded actor observations; not offline authenticated authorship, source objects, provider grants or full acceptance receipts.'
      : 'Private local planning versions and user-declared discussion with original Intent metadata; no source objects, provider grants, verified identity or acceptance decision.',
  };
  const json = JSON.stringify(manifest, null, 2) + '\n';
  return { json, sha256: digest(json), filename: 'forge-planning.json' };
}
