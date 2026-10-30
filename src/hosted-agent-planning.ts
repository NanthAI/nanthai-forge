// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { hostedActionError } from './hosted-action-error.js';
import { readIndexedWorkDetail } from './hosted-work-client.js';
import { ForgeError, invariant } from './errors.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
import type { PlanningItem, PlanningWrite } from './work-planning-types.js';

/** Planning is the hosted Work journal's Issues and Initiatives. This file only drives the existing
 * indexed reads and the existing owner `projectWorkActions:command`; it adds no storage. */
export type PlanningPort = Pick<HostedAgentSession, 'query' | 'address' | 'exchange' | 'root'>;
type Workspace = { generationId: string; revision: number; sourceRevision?: number };
type Page = {
  generationId: string | null;
  page: { id: string; value: string }[];
  isDone: boolean;
  continueCursor: string;
};
const open = ['proposed', 'open', 'in-progress'];
const cursorPrefix = 'forge-planning-v1:';
const maxPages = 5;
const maxReconcile = 10;
const stale = 'Hosted Work changed. Start again from a fresh planning read.';

const uuidFrom = (seed: string) => {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
async function workspace(port: PlanningPort): Promise<Workspace> {
  const ws = await port.query<Workspace | null>('projectWorkIndex:workspace', {});
  invariant(
    ws,
    'PROJECT_WORK_INDEX_MISSING',
    'The Work index is unavailable. The owner runs hosted-work with action rebuild-index.',
  );
  return ws;
}
async function page(
  port: PlanningPort,
  ws: Workspace,
  collection: string,
  cursor: string | null,
  numItems: number,
  extra: Record<string, unknown> = {},
) {
  const result = await port.query<Page>('projectWorkIndex:records', {
    generationId: ws.generationId,
    collection,
    paginationOpts: { cursor, numItems },
    ...extra,
  });
  invariant(result.generationId === ws.generationId, 'WORK_STALE', stale);
  return result;
}
const parseRow = (row: { value: string }) => JSON.parse(row.value) as PlanningItem;
async function fullItem(port: PlanningPort, ws: Workspace, id: string) {
  const detail = await readIndexedWorkDetail(
    { query: (reference, args) => port.exchange.client.query(reference, args) },
    {
      projectId: port.address.projectId,
      generationId: ws.generationId,
      ...(ws.sourceRevision === undefined ? {} : { sourceRevision: ws.sourceRevision }),
      collection: 'planningItems',
      id,
    },
  );
  return (detail.value as PlanningItem | null) ?? null;
}
const compact = (item: PlanningItem, intent?: string) => ({
  id: item.id,
  kind: item.kind,
  title: item.title,
  status: item.status,
  version: item.version,
  intentIds: item.intentIds,
  ...(item.initiativeId ? { initiativeId: item.initiativeId } : {}),
  at: item.at,
  ...(item.body.length > 400 ? { body: item.body.slice(0, 400), bodyTruncated: true } : { body: item.body }),
  ...(intent ? { intent } : {}),
});
function decode(cursor: string | null, ws: Workspace): string | null {
  if (cursor === null) return null;
  invariant(cursor.startsWith(cursorPrefix), 'BAD_ARGUMENT', 'Use the returned planning cursor.');
  try {
    const bound = JSON.parse(Buffer.from(cursor.slice(cursorPrefix.length), 'base64url').toString());
    invariant(bound.generationId === ws.generationId, 'WORK_STALE', stale);
    return bound.cursor as string | null;
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError('BAD_ARGUMENT', 'Use the returned planning cursor.');
  }
}
const encode = (ws: Workspace, cursor: string) =>
  cursorPrefix + Buffer.from(JSON.stringify({ generationId: ws.generationId, cursor })).toString('base64url');

/** Writes carry the original operation; a stale or moved Work revision is retried a few times with
 * the revision each attempt used retained, so a lost reply replays instead of repeating. */
async function writePlanning(port: PlanningPort, command: PlanningWrite, journal?: HostedAgentJournal) {
  for (let attempt = 0; ; attempt++) {
    const revision = journal
      ? await journal.retain(`planning-revision-${attempt}`, async () => (await workspace(port)).revision)
      : (await workspace(port)).revision;
    try {
      const event = (await port.exchange.client.action(
        makeFunctionReference<'action'>('projectWorkActions:command'),
        {
          projectId: port.address.projectId,
          operationId: command.operationId,
          revision,
          command: JSON.stringify(command),
        },
      )) as { revision: number };
      return event.revision;
    } catch (error) {
      const safe = hostedActionError(error, 'planning write');
      if (attempt >= 4 || !['WORK_STALE', 'WORK_OPERATION_CHANGED'].includes(safe.code)) throw safe;
    }
  }
}
const putFrom = (
  item: PlanningItem,
  operationId: string,
  status: PlanningItem['status'],
  reason?: string,
): PlanningWrite => ({
  action: 'put-planning-item',
  operationId,
  itemId: item.id,
  expectedVersion: item.version,
  kind: item.kind,
  title: item.title,
  body: item.body,
  status,
  ...(reason === undefined ? {} : { reason }),
  intentIds: item.intentIds,
  ...(item.initiativeId ? { initiativeId: item.initiativeId } : {}),
});

/** Issue states from started Intents, one indexed read per Issue in a single call. */
async function intentStates(port: PlanningPort, ids: string[]) {
  const states: Record<string, string> = {};
  if (ids.length)
    Object.assign(
      states,
      await port.query<Record<string, string>>('projectHostedPlanning:intentStates', { ids }),
    );
  return states;
}
/** An Issue whose Intent finished is closed (or abandoned) in planning, and the read says so. */
async function reconcile(
  port: PlanningPort,
  ws: Workspace,
  items: { id: string; status: string; version: number }[],
  states: Record<string, string>,
) {
  const due = items.filter(
    item => open.includes(item.status) && ['completed', 'abandoned'].includes(states[item.id] ?? ''),
  );
  const changed: unknown[] = [];
  const failed: unknown[] = [];
  for (const entry of due.slice(0, maxReconcile)) {
    const status = states[entry.id] === 'completed' ? 'closed' : 'abandoned';
    try {
      const item = await fullItem(port, ws, entry.id);
      if (!item || !open.includes(item.status)) continue;
      const reason = `Intent ${states[entry.id]}`;
      await writePlanning(
        port,
        putFrom(item, uuidFrom(`${item.id}:${item.version}:${status}`), status, reason),
      );
      changed.push({
        id: item.id,
        from: item.status,
        to: status,
        undo: `put-planning-item with itemId ${item.id}, expectedVersion ${item.version + 1} and the earlier status`,
      });
    } catch (error) {
      const safe = hostedActionError(error, 'planning reconcile');
      failed.push({ id: entry.id, code: safe.code, message: safe.message });
    }
  }
  return {
    changed,
    ...(failed.length ? { failed } : {}),
    ...(due.length > maxReconcile ? { remaining: due.length - maxReconcile } : {}),
  };
}

async function readPlanning(
  port: PlanningPort,
  input: ReturnType<typeof hostedAgentCommandSchemas.planning.parse>,
) {
  const ws = await workspace(port);
  if (input.id) {
    const item = await fullItem(port, ws, input.id);
    invariant(item, 'NOT_FOUND', 'Planning item not found.');
    const comments = await page(port, ws, 'planningComments', null, 50, {
      parentId: input.id,
      newestFirst: true,
    });
    const states = item.kind === 'issue' ? await intentStates(port, [item.id]) : {};
    const sync = input.reconcile ? await reconcile(port, ws, [item], states) : undefined;
    return {
      workRevision: ws.revision,
      item: { ...item, ...(states[item.id] ? { intent: states[item.id] } : {}) },
      comments: comments.page.map(row => JSON.parse(row.value)).reverse(),
      ...(comments.isDone ? {} : { commentsMore: true }),
      ...(sync?.changed.length || sync?.failed ? { reconciled: sync } : {}),
    };
  }
  let cursor = decode(input.cursor, ws);
  let scanned = 0;
  let done = false;
  let matches: PlanningItem[] = [];
  for (let pages = 0; pages < maxPages && !done && !matches.length; pages++) {
    const result = await page(port, ws, 'planningItems', cursor, input.limit);
    scanned += result.page.length;
    done = result.isDone;
    cursor = result.continueCursor;
    matches = result.page
      .map(parseRow)
      .filter(
        item =>
          (!input.kind || item.kind === input.kind) &&
          (!input.status || item.status === input.status) &&
          (!input.initiativeId || item.initiativeId === input.initiativeId),
      );
  }
  const issues = matches.filter(item => item.kind === 'issue' && open.includes(item.status));
  const states = await intentStates(
    port,
    issues.map(item => item.id),
  );
  const sync = input.reconcile ? await reconcile(port, ws, issues, states) : undefined;
  const closed = new Map(
    (sync?.changed as { id: string; to: string }[] | undefined)?.map(entry => [entry.id, entry.to]),
  );
  return {
    workRevision: ws.revision,
    items: matches.map(item =>
      compact(
        { ...item, status: (closed.get(item.id) as PlanningItem['status']) ?? item.status },
        states[item.id],
      ),
    ),
    scanned,
    nextCursor: done ? null : encode(ws, cursor!),
    ...(sync?.changed.length || sync?.failed ? { reconciled: sync } : {}),
  };
}

export async function executeHostedPlanning(
  port: PlanningPort,
  actor: string,
  action: 'planning' | 'put-planning-item' | 'comment-planning-item',
  input: Record<string, unknown>,
  operationId: string | undefined,
) {
  if (action === 'planning') {
    const read = hostedAgentCommandSchemas.planning.parse(input);
    return { operationId: null, result: await readPlanning(port, read) };
  }
  const journal = new HostedAgentJournal(port.root, port.address, actor, action, input, operationId);
  if (action === 'comment-planning-item') {
    const comment = hostedAgentCommandSchemas['comment-planning-item'].parse(input);
    const revision = await writePlanning(
      port,
      {
        action,
        operationId: journal.operationId,
        ...comment,
        authorLabel: comment.authorLabel || process.env.FORGE_AGENT_NAME || process.env.FORGE_ACTOR || '',
      },
      journal,
    );
    return {
      operationId: journal.operationId,
      result: { itemId: comment.itemId, commentId: journal.operationId, workRevision: revision },
    };
  }
  const put = hostedAgentCommandSchemas['put-planning-item'].parse(input);
  const itemId = put.itemId ?? (await journal.id('item'));
  const revision = await writePlanning(
    port,
    { action, operationId: journal.operationId, ...put, itemId },
    journal,
  );
  return {
    operationId: journal.operationId,
    result: {
      itemId,
      version: put.expectedVersion + 1,
      status: put.status,
      workRevision: revision,
    },
  };
}

/** The Intent a planned Issue starts: it shares the Issue's id, so repeated starts add Lanes to it. */
export async function plannedIntent(port: PlanningPort, itemId: string) {
  const ws = await workspace(port);
  const item = await fullItem(port, ws, itemId);
  invariant(item, 'NOT_FOUND', 'Planning item not found.');
  invariant(
    item.kind === 'issue',
    'BAD_ARGUMENT',
    'Start from an Issue. An Initiative groups Issues; start one of them.',
  );
  invariant(
    open.includes(item.status),
    'INTENT_CLOSED',
    `This Issue is ${item.status}. Reopen it with put-planning-item before starting work.`,
  );
  return {
    kind: 'planned' as const,
    intentId: item.id,
    outcome: item.title.slice(0, 500),
    ...(item.body ? { constraints: item.body.slice(0, 4000) } : {}),
  };
}
/** After a start, the Issue shows the work as in progress. A failure here never fails the start,
 * which already holds the Lane: it is reported, and running the same start again retries it. */
export async function markPlanningStarted(port: PlanningPort, itemId: string, startOperationId: string) {
  try {
    const ws = await workspace(port);
    const item = await fullItem(port, ws, itemId);
    if (!item) return { updated: false, error: { code: 'NOT_FOUND', message: 'Planning item not found.' } };
    if (item.status === 'in-progress') return { updated: false, status: item.status };
    await writePlanning(port, putFrom(item, uuidFrom(`${startOperationId}:planning-start`), 'in-progress'));
    return { updated: true, status: 'in-progress', version: item.version + 1 };
  } catch (error) {
    const safe = hostedActionError(error, 'planning start');
    return {
      updated: false,
      error: { code: safe.code, message: safe.message },
      retry: 'Run the same start again, or set the Issue to in-progress with put-planning-item.',
    };
  }
}
