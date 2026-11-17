// SPDX-License-Identifier: Apache-2.0
// Pure: also runs in the Convex non-Node runtime.
import { invariant } from './errors.js';
import { planningModelPutKeys, type PlanningItem, type PlanningWrite } from './work-planning-types.js';
import { isAgentSlug } from './agent-slug.js';
import { digest } from './state/hash.js';

/** Stable within and across projects: a source key names one imported Item, independently of the batch. */
export function planningImportId(key: string) {
  const hex = digest(JSON.stringify(['forge-planning-import', key]));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

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
  const imported = keep(command.imported, current?.imported);
  invariant(
    !imported || command.itemId === planningImportId(imported.key),
    'BAD_ARGUMENT',
    'An imported Item id must be derived from its source key; use planning with transfer to prepare it.',
  );
  const hidden = command.hidden === undefined ? current?.hidden : command.hidden || undefined;
  const fields = {
    order: keep(command.order, current?.order),
    type: keep(command.type, current?.type),
    parentId,
    owner: keep(command.owner, current?.owner),
    relations: relations.length ? relations : undefined,
    hidden: hidden ? (true as const) : undefined,
    imported,
  };
  return Object.fromEntries(
    planningModelPutKeys.flatMap(key => (fields[key] === undefined ? [] : [[key, fields[key]]])),
  ) as Partial<Pick<PlanningItem, (typeof planningModelPutKeys)[number]>>;
}

// Discussion rules shared by the local Work and hosted journal reducers (Item 9a3d6f5f): a reply joins its thread's
// root, the agent slug is kept only from the fixed lists, and a decision comment also appends one dated line to the
// Item body's Decisions section in the same write, so the body and the comment never disagree.
type Comment = { id: string; itemId: string; replyTo?: string | undefined };
type Discussed = {
  operationId: string;
  replyTo?: string | undefined;
  decision?: boolean | undefined;
  agent?: string | undefined;
};

/** The optional fields a new comment stores. A reply must name a comment on the same Item. */
export function discussionFields(comments: readonly Comment[], itemId: string, command: Discussed) {
  let replyTo: string | undefined;
  if (command.replyTo) {
    const parent = comments.find(comment => comment.id === command.replyTo);
    invariant(parent && parent.itemId === itemId, 'NOT_FOUND', 'Reply to a comment on the same Item.');
    replyTo = parent.replyTo ?? parent.id;
  }
  return {
    ...(replyTo ? { replyTo } : {}),
    ...(isAgentSlug(command.agent) ? { agent: command.agent } : {}),
    ...(command.decision ? { decision: true as const } : {}),
  };
}

/** The decision's own body version gets a stable operation id derived from the comment's, so a retry of the comment
 * finds its earlier write and the version and comment never share one id. */
export function decisionOperationId(commentId: string) {
  const hex = digest(`planning-decision:${commentId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A public label is a Forge handle (`@handle` or `handle`) or `handle/agent-slug`; anything else (a display name,
 * a machine name) is never written into the body. */
const publicLabel = /^@?[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?(?:\/[a-z]{2,10}-[a-z]{2,10})?$/;
export function decisionActor(label: string) {
  const value = label.trim().toLowerCase();
  if (!publicLabel.test(value)) return '';
  return value.includes('/') || value.startsWith('@') ? value : `@${value}`;
}

const MAX_DECISION = 500;
/** The body with one more line in its `## Decisions` section (made at the end when there is none). The line keeps the
 * date, the author label when it is a public identity, the first paragraph of the text, and the comment's short id. */
export function bodyWithDecision(
  body: string,
  input: { at: string; label: string; text: string; commentId: string },
) {
  const first = input.text
    .trim()
    .split(/\n\s*\n/)[0]!
    .replace(/\s+/g, ' ');
  const said = first.length > MAX_DECISION ? `${first.slice(0, MAX_DECISION - 1)}…` : first;
  const actor = decisionActor(input.label);
  const line = `- ${input.at.slice(0, 10)}${actor ? ` ${actor}` : ''}: ${said} (comment ${input.commentId.slice(0, 8)})`;
  const lines = body.replace(/\s+$/, '').split('\n');
  const heading = lines.findIndex(text => /^##\s+Decisions\s*$/i.test(text));
  if (heading < 0) return `${lines.join('\n')}${body.trim() ? '\n\n' : ''}## Decisions\n${line}\n`;
  let end = lines.length;
  for (let index = heading + 1; index < lines.length; index++)
    if (/^#{1,2}\s/.test(lines[index]!)) {
      end = index;
      break;
    }
  while (end > heading + 1 && !lines[end - 1]!.trim()) end--;
  lines.splice(end, 0, line);
  return `${lines.join('\n')}\n`;
}
