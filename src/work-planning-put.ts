// SPDX-License-Identifier: Apache-2.0
// Pure: also runs in the Convex non-Node runtime.
import { ForgeError, invariant } from './errors.js';
import {
  isShelved,
  planningModelPutKeys,
  type PlanningItem,
  type PlanningWrite,
} from './work-planning-types.js';
import { AGENT_CLIENT, isAgentSlug } from './agent-slug.js';
import { digest } from './state/hash.js';

/** Stable within and across projects: a source key names one imported Item, independently of the batch. */
export function planningImportId(key: string) {
  const hex = digest(JSON.stringify(['forge-planning-import', key]));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The one refusal for anything that would change, restore or read the text of a purged Item, including a retry of
 * an operation whose row was purged. `recovery` names the Item and, when known, the purge operation. */
export function planningPurged(itemId: string, purgeOperationId?: string) {
  return new ForgeError(
    'PLANNING_ITEM_PURGED',
    `The Item ${itemId} was deleted permanently: its text, versions and comments are gone, and it cannot be changed, restored or commented on.`,
    undefined,
    { itemId, ...(purgeOperationId ? { purgeOperationId } : {}) },
  );
}

/** A retry or version read of one comment the operator purged (Item b6588425 line 2b): the comment is gone, its Item
 * stays. Names the comment, its Item and the purge. */
export function commentPurged(itemId: string, commentId: string, purgeOperationId: string) {
  return new ForgeError(
    'PLANNING_COMMENT_PURGED',
    `The comment ${commentId} on Item ${itemId} was removed permanently by the Forge operator: its text is gone, and it cannot be sent again. The Item is unchanged.`,
    undefined,
    { itemId, commentId, purgeOperationId },
  );
}

/** Refuse a planning write whose latest version is a tombstone. */
export function refusePurged(item: Pick<PlanningItem, 'id' | 'purged'> | undefined) {
  if (item?.purged) throw planningPurged(item.id, item.purged.operationId);
}

/** A put may not newly name a purged Item as its Initiative, parent, linked Intent or relation (purge Lane 2,
 * follow-up f): links to a tombstone would point at nothing. An id the current version already names, as written,
 * stays, so a purged Initiative's child or a purged Issue's linker can still be edited. `historyId` maps a named id to
 * the Item that holds its versions; `latest` returns an Item's latest version. The hosted command path loads exactly
 * these Items (convex/projectWorkCommandRows.ts), so a live write and a full replay decide the same way. */
export function refuseTombstoneLinks(
  current: Partial<Pick<PlanningItem, 'intentIds' | 'initiativeId' | 'parentId' | 'relations'>> | undefined,
  command: {
    intentIds?: readonly string[] | undefined;
    initiativeId?: string | null | undefined;
    parentId?: string | null | undefined;
    relations?: readonly { id: string }[] | undefined;
  },
  latest: (itemId: string) => Pick<PlanningItem, 'id' | 'purged'> | undefined,
  historyId: (id: string) => string,
) {
  const ids = (item: typeof command | undefined) => [
    ...(item?.intentIds ?? []),
    ...(item?.initiativeId ? [item.initiativeId] : []),
    ...(item?.parentId ? [item.parentId] : []),
    ...(item?.relations ?? []).map(relation => relation.id),
  ];
  const before = new Set(ids(current));
  for (const id of new Set(ids(command))) if (!before.has(id)) refusePurged(latest(historyId(id)));
}

/** An Item's latest version in retained history (newest last), scanning from the end. */
export function latestVersion<T extends { id: string }>(items: readonly T[], itemId: string) {
  for (let index = items.length - 1; index >= 0; index--)
    if (items[index]!.id === itemId) return items[index];
  return undefined;
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
    Partial<Pick<PlanningItem, (typeof planningModelPutKeys)[number] | 'was'>>,
) {
  invariant(
    current || (command.kind && command.title),
    'BAD_ARGUMENT',
    'Creating a planning item needs `kind` and `title`.',
  );
  const status = command.status ?? current?.status ?? 'open';
  invariant(current || !isShelved(status), 'BAD_ARGUMENT', 'Create an Item before archiving or deleting it.');
  return {
    kind: (command.kind ?? current?.kind)!,
    title: (command.title ?? current?.title)!,
    body: command.body ?? current?.body ?? '',
    status,
    intentIds: [...new Set(command.intentIds ?? current?.intentIds ?? [])].sort(),
    initiativeId: command.initiativeId === null ? undefined : (command.initiativeId ?? current?.initiativeId),
    reason: command.reason,
    model: { ...resolveModelFields(command, current), ...shelfFrom(status, current) },
    agent: putAgentFields(command),
  };
}

/** Archive and Delete remember the status they left (Item 4c9e961e); moving between the two shelves keeps it, and
 * any other status clears it, so Unarchive and Restore are an ordinary put of `was` that adds a version. */
function shelfFrom(status: string, current?: Partial<Pick<PlanningItem, 'status' | 'was'>>) {
  if (!isShelved(status)) return {};
  const was = current?.status && !isShelved(current.status) ? current.status : current?.was;
  return was ? { was: was as NonNullable<PlanningItem['was']> } : {};
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
    waitingOn: keep(command.waitingOn, current?.waitingOn),
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
  agentClient?: string | undefined;
};

/** Valid agent session slug and declared client/model on a planning write (shared by puts and comments). */
export function putAgentFields(command: { agent?: string | undefined; agentClient?: string | undefined }) {
  return {
    ...(isAgentSlug(command.agent) ? { agent: command.agent } : {}),
    // The declared model belongs to an agent session only; a person's write never carries one.
    ...(isAgentSlug(command.agent) && command.agentClient && AGENT_CLIENT.test(command.agentClient)
      ? { agentClient: command.agentClient }
      : {}),
  };
}

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
    ...putAgentFields(command),
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

export type BodyDecision = { date: string; label?: string; text: string; comment?: string };
const DECISION_LINE =
  /^-\s+(\d{4}-\d{2}-\d{2})(?:\s+(\S+))?:\s*(.*?)\s*(?:\(comment ([0-9a-fA-F]{8})\))?\s*$/;
const DAY_MS = 86_400_000;
/** The `## Decisions` lines of a body whose UTC day overlaps [fromMs, untilMs], oldest first, as `bodyWithDecision`
 * wrote them (the date is the only time a line keeps). Fenced code and other sections are skipped, and a date that is
 * not a real calendar day is ignored. At most `max` are returned (the newest by date); `omitted` counts the older
 * ones. The author is `label` (not a person field), so reads add no account lookup. Pure: reads only the body. */
export function decisionsInWindow(body: string, fromMs: number, untilMs: number, max = 10) {
  const found: BodyDecision[] = [];
  let fenced = false;
  let inSection = false;
  for (const line of body.split('\n')) {
    if (/^ {0,3}(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    if (/^ {0,3}#{1,2}\s/.test(line) || /^##\s+Decisions\s*$/i.test(line)) {
      inSection = /^##\s+Decisions\s*$/i.test(line);
      continue;
    }
    const match = inSection ? DECISION_LINE.exec(line) : null;
    if (!match) continue;
    const day = Date.parse(`${match[1]}T00:00:00.000Z`);
    if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== match[1]) continue;
    if (day + DAY_MS <= fromMs || day > untilMs) continue;
    found.push({
      date: match[1]!,
      ...(match[2] ? { label: match[2] } : {}),
      text: match[3]!,
      ...(match[4] ? { comment: match[4].toLowerCase() } : {}),
    });
  }
  const ordered = found
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) =>
      a.entry.date === b.entry.date ? a.index - b.index : a.entry.date < b.entry.date ? -1 : 1,
    )
    .map(({ entry }) => entry);
  return { decisions: ordered.slice(-max), omitted: Math.max(0, ordered.length - max) };
}
