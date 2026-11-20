// SPDX-License-Identifier: Apache-2.0
import { memberDataNotice, systemCommentNotice } from './member-data-notice.js';
import { planningSummary, planningSearchTerms } from './planning-search.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { laneRegistryDirectory } from './lane-registry.js';
import { makeFunctionReference } from 'convex/server';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { hostedActionError } from './hosted-action-error.js';
import { readIndexedWorkDetail } from './hosted-work-client.js';
import { ForgeError, invariant, itemChanged } from './errors.js';
import { isPlanningPrefix, planningIdMaxCandidates } from './planning-id.js';
import { planningIssueArguments } from './planning-issue-arguments.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
import {
  isShelved,
  planningCommentCommandSchema,
  planningPutAgentFields,
  planningPutSchema,
  type PlanningItem,
  type PlanningWrite,
} from './work-planning-types.js';
import { issuePaths, SCHEDULE_RULE, suggestSchedule } from './work-schedule.js';
import { markdownDoc } from './docs-resolution.js';

/** Planning is the hosted Work journal's Issues and Initiatives. This file only drives the existing
 * indexed reads and the owner Work command `projectWorkActionsV8:command`; it adds no storage. */
export type PlanningPort = Pick<
  HostedAgentSession,
  'query' | 'mutation' | 'address' | 'exchange' | 'root'
> & {
  retainOperation?: (id: string) => void;
  /** Contract features the server advertised (a83b6fd5); unknown means none. */
  serverFeatures?: readonly string[];
  /** This agent session's slug, recorded on its comments so they read `handle/slug` (Item 9a3d6f5f), with the client
   * and model its launcher declared (`tool:model`, as on landing receipts), so the byline names it (Item 2fb69177). */
  commentAgent?: () => { agent: string; agentClient?: string } | undefined;
};
type Workspace = {
  generationId: string;
  /** Present on servers before flip 5 S4; the revision-free writes need none. */
  revision?: number;
  sourceRevision?: number;
  likelyDuplicates?: unknown;
  planningFilteredReads?: boolean;
};
type Page = {
  generationId: string | null;
  page: { id: string; value: string }[];
  isDone: boolean;
  continueCursor: string;
};
const open = ['proposed', 'open', 'in-progress'];
/** Every planning read carries this one line (S-17); board and overlap receipts reuse it. */
export const planningDataNotice = memberDataNotice;
const marked = <T extends object>(result: T): T & { notice: string } => ({
  ...result,
  notice: planningDataNotice,
});
const cursorPrefix = 'forge-planning-v1:';
const maxPages = 5;
// Ten times the live 397-Issue count's two pages; <=20 MB of bounded DB pages per invocation.
const maxCountPages = 20;
const maxReconcile = 10;
const stale = 'Hosted Work changed. Start again from a fresh planning read.';

const uuidFrom = (seed: string) => {
  const h = createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
async function workspace(port: PlanningPort, planningDuplicateText?: string): Promise<Workspace> {
  let ws: Workspace | null;
  try {
    ws = await port.query<Workspace | null>(
      'projectWorkIndex:workspace',
      planningDuplicateText === undefined ? {} : { planningDuplicateText },
    );
  } catch (error) {
    if (
      planningDuplicateText === undefined ||
      !(error instanceof Error) ||
      !/ArgumentValidationError/.test(error.message) ||
      !/extra field[^\n]*planningDuplicateText/.test(error.message)
    )
      throw error;
    ws = await port.query<Workspace | null>('projectWorkIndex:workspace', {});
    if (ws)
      ws.likelyDuplicates = {
        items: [],
        coverage: 'unavailable-server-upgrade-required',
      };
  }
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
/** The link every planning read shows for an Issue (30a4d75d). Starting an Issue opens the Intent that has the
 * Issue's own id and never fills the legacy `intentIds` array, so an empty array is not "no link". This is the
 * Intent a start opens or opened: static text from the item, no call. `intent` is its state, present once started. */
const withPlannedLink = <T extends { id: string; kind?: string; author?: string | undefined }>(raw: T) => {
  const item = shownAuthor(raw);
  return item.kind === 'issue' ? { ...item, plannedIntentId: item.id } : item;
};
/** The body's author reaches an agent only as a public Forge handle (public-identities rule, S-17). The server
 * maps the stored account to its handle before the row leaves it (convex/publicPeople.ts); anything that is
 * not handle-shaped (an unmapped account id, a name, an email) is dropped here, so no raw id can pass. */
const handleShape = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])$/;
function shownAuthor<T extends { author?: string | undefined }>(item: T): T {
  if (item.author === undefined || handleShape.test(item.author)) return item;
  const rest: T = { ...item };
  delete rest.author;
  return rest;
}
const compact = (item: PlanningItem, intent?: string) =>
  withPlannedLink({
    ...planningSummary(item),
    ...(intent ? { intent } : {}),
  });
function decode(cursor: string | null, ws: Workspace): string | null {
  if (cursor === null) return null;
  return decodeBound(cursor, ws).cursor;
}
function decodeBound(cursor: string, ws?: Workspace): { generationId: string; cursor: string | null } {
  invariant(cursor.startsWith(cursorPrefix), 'BAD_ARGUMENT', 'Use the returned planning cursor.');
  try {
    const bound = JSON.parse(Buffer.from(cursor.slice(cursorPrefix.length), 'base64url').toString());
    invariant(
      typeof bound.generationId === 'string' && (bound.cursor === null || typeof bound.cursor === 'string'),
      'BAD_ARGUMENT',
      'Use the returned planning cursor.',
    );
    invariant(!ws || bound.generationId === ws.generationId, 'WORK_STALE', stale);
    return bound;
  } catch (error) {
    if (error instanceof ForgeError) throw error;
    throw new ForgeError('BAD_ARGUMENT', 'Use the returned planning cursor.');
  }
}
const encode = (ws: Workspace, cursor: string) =>
  cursorPrefix + Buffer.from(JSON.stringify({ generationId: ws.generationId, cursor })).toString('base64url');

/** A planning detail lists the newest 50 comments; older ones continue with `commentsCursor`, which
 * names its Item, so a list cursor or another Item's cursor is refused (f0d0fdd6). */
const commentsContinue = (ws: Workspace, id: string, cursor: string) => ({
  commentsMore: true as const,
  commentsCursor:
    cursorPrefix +
    Buffer.from(JSON.stringify({ generationId: ws.generationId, cursor, comments: id })).toString(
      'base64url',
    ),
});
async function olderComments(port: PlanningPort, ws: Workspace, id: string, cursor: string) {
  const bound = decodeBound(cursor, ws) as { cursor: string | null; comments?: unknown };
  invariant(
    bound.comments === id,
    'BAD_ARGUMENT',
    'cursor: with planningItemId, pass the commentsCursor that planning returned for this Item.',
  );
  const comments = await page(port, ws, 'planningComments', bound.cursor, 50, {
    parentId: id,
    newestFirst: true,
  });
  const shown = comments.page.map(row => JSON.parse(row.value) as { system?: boolean }).reverse();
  return {
    workRevision: ws.revision,
    planningItemId: id,
    comments: shown,
    ...(comments.isDone ? {} : commentsContinue(ws, id, comments.continueCursor)),
    ...(shown.some(comment => comment.system === true) ? { systemComments: systemCommentNotice } : {}),
  };
}

/** The put a server can apply safely (a83b6fd5). A server that does not advertise
 * planning-put-keeps-omitted (deployed before c0255160) needs kind and title and turns an omitted
 * body into "", status into open, links into [] and group into none; it gets the stored values for
 * every field the put omits (an explicit null group becomes an omitted one). One detail read on
 * that path only, none when the caller already holds the stored item; the result is retained so a
 * replay sends the same command. */
async function compatiblePut(
  port: PlanningPort,
  command: PlanningWrite,
  journal?: HostedAgentJournal,
  stored?: PlanningItem,
): Promise<PlanningWrite> {
  if (command.action !== 'put-planning-item' || port.serverFeatures?.includes('planning-put-keeps-omitted'))
    return command;
  const fill = async (): Promise<PlanningWrite> => {
    const { initiativeId, ...rest } = command;
    if (command.expectedVersion === 0) return { ...rest, ...(initiativeId ? { initiativeId } : {}) };
    const item = stored ?? (await fullItem(port, await workspace(port), command.itemId));
    invariant(item, 'NOT_FOUND', 'Planning item not found.');
    if (item.version !== command.expectedVersion)
      throw itemChanged({
        kind: 'issue',
        id: command.itemId,
        expectedVersion: command.expectedVersion,
        currentVersion: item.version,
      });
    const group = initiativeId === null ? undefined : (initiativeId ?? item.initiativeId);
    return {
      ...rest,
      kind: command.kind ?? item.kind,
      title: command.title ?? item.title,
      body: command.body ?? item.body,
      status: command.status ?? item.status,
      intentIds: command.intentIds ?? item.intentIds,
      ...(group ? { initiativeId: group } : {}),
    };
  };
  return journal ? journal.retain('planning-compatible-put', fill) : fill();
}

/** Writes carry the original operation, so a lost reply replays instead of repeating. Comments (flip 5 S0)
 * and, on a server with planning-put-mutation, puts (S5) take the revision-free mutation the web uses: one
 * call, and an unrelated Work write never refuses them; a put's only check is its item version
 * (ITEM_CHANGED). A creation still reads the likely duplicates first (one query, creations only). An older
 * server gets the revision-checked action, retried when an unrelated write moved the revision. */
async function writePlanning(
  port: PlanningPort,
  request: PlanningWrite,
  journal?: HostedAgentJournal,
  hints?: { likelyDuplicates?: unknown },
  stored?: PlanningItem,
) {
  const command = await compatiblePut(port, request, journal, stored);
  const creation =
    command.action === 'put-planning-item' && command.kind === 'issue' && command.expectedVersion === 0;
  const observe = async () => {
    const ws = await workspace(port, creation ? `${command.title ?? ''} ${command.body ?? ''}` : undefined);
    return {
      ...(ws.revision === undefined ? {} : { revision: ws.revision }),
      ...(ws.likelyDuplicates === undefined ? {} : { likelyDuplicates: ws.likelyDuplicates }),
    };
  };
  const mutation =
    command.action === 'comment-planning-item' || port.serverFeatures?.includes('planning-put-mutation');
  if (mutation) {
    if (creation && hints) {
      const observed = journal ? await journal.retain('planning-duplicates', observe) : await observe();
      if ('likelyDuplicates' in observed) hints.likelyDuplicates = observed.likelyDuplicates;
    }
    return (
      await port
        .mutation<{ revision: number }>('projectWorkCommand:command', {
          operationId: command.operationId,
          command: JSON.stringify(command),
        })
        .catch(error => {
          throw hostedActionError(error, 'planning write');
        })
    ).revision;
  }
  for (let attempt = 0; ; attempt++) {
    const retained = journal
      ? await journal.retain(`planning-revision-${attempt}`, observe)
      : await observe();
    // Existing retry journals retain just the revision number.
    const observed = typeof retained === 'number' ? { revision: retained } : retained;
    if (hints && 'likelyDuplicates' in observed) hints.likelyDuplicates = observed.likelyDuplicates;
    try {
      const args = {
        projectId: port.address.projectId,
        operationId: command.operationId,
        revision: observed.revision ?? 0,
        command: JSON.stringify(command),
      };
      const call = (name: string) =>
        port.exchange.client.action(makeFunctionReference<'action'>(name), args) as Promise<{
          revision: number;
        }>;
      // The 64 MiB V8 command (Issue 85801d6f); a server deployed before it has the Node one only.
      const event = await call('projectWorkActionsV8:command').catch(error => {
        if (!/Could not find public function/.test(error instanceof Error ? error.message : '')) throw error;
        return call('projectWorkActions:command');
      });
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
  // Status only: the server keeps the stored title, body, links and group (older servers get the
  // stored fields from compatiblePut).
  status,
  ...(reason === undefined ? {} : { reason }),
});

/** A unique hex prefix of a planning id (8+ characters) becomes the full id in the same call. One
 * bounded index range read on the existing key index (`projectHostedPlanning:resolveId`, at most
 * six keys, no scan, no search). A complete UUID is returned untouched with no call. An ambiguous
 * prefix lists at most five full candidates; an unknown one is NOT_FOUND. The result is retained in
 * the journal when there is one, so a replay writes to the same item. */
export async function resolvePlanningId(
  port: Pick<PlanningPort, 'query'>,
  id: string,
  journal?: HostedAgentJournal,
  /** Journal key: the default for the item itself (replay-stable); one per other id field. */
  key = 'planning-id-prefix',
): Promise<string> {
  if (!isPlanningPrefix(id)) return id;
  const prefix = id.toLowerCase();
  const find = async () => {
    let found: { ids: string[]; more?: boolean };
    try {
      found = await port.query<{ ids: string[]; more?: boolean }>('projectHostedPlanning:resolveId', {
        prefix,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /(?:Could not find (?:public )?function|No (?:public )?function found|Function .* not found)/i.test(
          error.message,
        )
      )
        throw new ForgeError(
          'HOSTED_ACTION_UNSUPPORTED',
          `This server cannot resolve a short planning id yet. Pass the full id (planning '{"search":"${prefix}"}' lists it).`,
        );
      throw error;
    }
    return found;
  };
  const { ids, more } = journal ? await journal.retain(key, find) : await find();
  invariant(ids.length > 0, 'NOT_FOUND', `No planning item starts with "${prefix}".`);
  if (ids.length > 1 || more)
    throw new ForgeError(
      'AMBIGUOUS_ID',
      `"${prefix}" starts ${ids.length > planningIdMaxCandidates || more ? 'more than ' + planningIdMaxCandidates : ids.length} planning items: ${ids.slice(0, planningIdMaxCandidates).join(', ')}${more ? ', …' : ''}. Pass more characters or the full id.`,
      undefined,
      { candidates: ids.slice(0, planningIdMaxCandidates) },
    );
  return ids[0]!;
}

/** Friction records take no comments (6d815aa9). When a comment fails and the id is a friction record,
 * say so and name the Issue to comment on. One indexed read, only on this failure; any lookup problem
 * leaves the original error. */
async function frictionCommentPointer(port: PlanningPort, itemId: string, error: unknown) {
  if (!(error instanceof ForgeError) || ['WORK_STALE', 'WORK_OPERATION_CHANGED'].includes(error.code)) return;
  try {
    const found = await port.query<{ found: boolean; status?: string; planningItemId?: string }>(
      'projectHostedFriction:lookup',
      { id: itemId },
    );
    if (!found.found) return;
    return new ForgeError(
      'BAD_ARGUMENT',
      `${itemId} is a friction record, not an Issue; friction records take no comments. ` +
        (found.planningItemId
          ? `It is triaged to Issue ${found.planningItemId}: comment-planning-item with itemId ${found.planningItemId}.`
          : `It has no Issue yet: search planning for the matching Issue and comment there, or file one and link this record with friction-triage {frictionIds:["${itemId}"],status:"planned",planningItemId}.`),
    );
  } catch {
    return;
  }
}

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
const holdMarker = (openLines: number) => `Intent completed; ${openLines} Done-when line(s) still open`;
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
  const held: unknown[] = [];
  for (const entry of due.slice(0, maxReconcile)) {
    const status = states[entry.id] === 'completed' ? 'closed' : 'abandoned';
    try {
      const item = await fullItem(port, ws, entry.id);
      if (!item || !open.includes(item.status)) continue;
      // A finished Intent closes its Issue only when every Done-when line is ticked (GitHub's Closes
      // semantics): otherwise the Issue stays open and the read says how many lines are left.
      const openLines = status === 'closed' ? openDoneWhenLines(item.body) : [];
      const unmet = openLines.length;
      if (unmet) {
        const marker = holdMarker(unmet);
        // The hold's own reason write bumps the version once; a read that finds the marker already there
        // names the current version.
        const advice = holdAdvice(
          item.id,
          item.reason === marker ? item.version : item.version + 1,
          openLines,
        );
        held.push({
          id: item.id,
          openLines: unmet,
          version: item.reason === marker ? item.version : item.version + 1,
          lines: advice.lines,
          close: advice.close,
          reason: `${marker.replace('still open', 'are not ticked')}. ${advice.text}`,
        });
        // The Issue keeps its status. One comment and one reason write say so, then reads stay silent:
        // the reason is the marker, and both writes carry operation ids derived from the Issue version.
        if (item.reason !== marker) {
          await writePlanning(
            port,
            {
              action: 'comment-planning-item',
              operationId: uuidFrom(`${item.id}:${item.version}:held-comment`),
              itemId: item.id,
              authorLabel: '',
              text: `${marker}, so this Issue stays open. ${advice.text}`,
            },
            undefined,
            undefined,
            item,
          );
          await writePlanning(
            port,
            putFrom(item, uuidFrom(`${item.id}:${item.version}:held`), item.status, marker),
            undefined,
            undefined,
            item,
          );
        }
        continue;
      }
      const reason = `Intent ${states[entry.id]}`;
      await writePlanning(
        port,
        putFrom(item, uuidFrom(`${item.id}:${item.version}:${status}`), status, reason),
        undefined,
        undefined,
        item,
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
    ...(held.length ? { held } : {}),
    ...(failed.length ? { failed } : {}),
    ...(due.length > maxReconcile ? { remaining: due.length - maxReconcile } : {}),
  };
}

/** Done-when lines not yet ticked: acceptance not yet met. Unticked checkboxes (`- [ ]`, `* [ ]`,
 * `1. [ ]`) count. A Done-when section written without any checkbox (plain bullets or prose, friction
 * 8b4bfd78: Issues c329d191 and 47558a99 closed with agreed work pending) cannot be ticked, so each of
 * its bullet lines (or the paragraph, as one line) counts as open: a person closes such an Issue. A body
 * with no Done-when section keeps closing as before. Returns the line texts (CAS-free, body only). */
export const openDoneWhenLines = (body: string): string[] => {
  const lineText = (line: string) =>
    line
      .replace(/^[ \t>]*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s*)?/, '')
      .replace(/\s+/g, ' ')
      .trim();
  const boxes = body.match(/^[ \t>]*(?:(?:[-*+]|\d+[.)])\s+)?\[([ xX])\].*$/gm) ?? [];
  if (boxes.length)
    return boxes.filter(line => /^[ \t>]*(?:(?:[-*+]|\d+[.)])\s+)?\[ \]/.test(line)).map(lineText);
  const heading = /^[ \t>#*_]*done[- ]when\b/im.exec(body);
  if (!heading) return [];
  const lines = body
    .slice(heading.index + heading[0].length)
    .split('\n')
    .map(line => line.trim());
  const bullets: string[] = [];
  let first = lines[0]?.replace(/^[:*_\s]+/, '') ?? '';
  let text = /\w/.test(first);
  for (const line of lines.slice(1)) {
    if (/^#{1,6}\s/.test(line) || /^\*\*[^*]+\*\*:?$/.test(line)) break;
    if (/^(?:[-*+]|\d+[.)])\s+\S/.test(line)) bullets.push(lineText(line));
    else if (/\w/.test(line)) {
      text = true;
      if (!/\w/.test(first)) first = line;
    }
  }
  return bullets.length ? bullets : text ? [first || 'Done-when text'] : [];
};

/** What a builder needs after a landing that left Done-when lines open: which lines (at most five, 100
 * characters each) and the one command that closes the Issue with evidence. Pure text from the item
 * already read: no call. `version` is the Issue version the close must name. */
const holdAdvice = (id: string, version: number, lines: string[]) => {
  const shown = lines.slice(0, 5).map(line => (line.length > 100 ? `${line.slice(0, 99)}…` : line));
  const more = lines.length - shown.length;
  return {
    lines: shown,
    close: `nforge agent . put-planning-item '{"itemId":"${id}","expectedVersion":${version},"status":"closed","reason":"Done-when met, evidence in comments"}'`,
    text: `Open: ${shown.map(line => `"${line}"`).join('; ')}${more > 0 ? `; and ${more} more` : ''}. Comment the evidence for each line, then close with: nforge agent . put-planning-item '{"itemId":"${id}","expectedVersion":${version},"status":"closed","reason":"Done-when met, evidence in comments"}'. Or tick the boxes (re-send the body with [x]) and the next planning read closes it.`,
  };
};

/** The type, owner and relation filters (src/planning-filter.ts), loaded only when a read names one. */
async function rowFilter(input: {
  type?: string | undefined;
  owner?: string | undefined;
  relation?: string | undefined;
}): Promise<(row: object) => boolean> {
  if (!input.type && !input.owner && !input.relation) return () => true;
  const { planFilterMatch } = await import('./planning-filter.js');
  const filter = { type: input.type, owner: input.owner, relation: input.relation } as Parameters<
    typeof planFilterMatch
  >[1];
  return row => planFilterMatch(row as Parameters<typeof planFilterMatch>[0], filter);
}

async function readPlanning(
  port: PlanningPort,
  input: ReturnType<typeof hostedAgentCommandSchemas.planning.parse>,
) {
  if (input.initiativeId)
    input = { ...input, initiativeId: await resolvePlanningId(port, input.initiativeId) };
  if (input.search !== undefined) {
    const terms = planningSearchTerms(input.search);
    try {
      const found = await port.query<{ items?: { id: string; kind?: string }[] }>(
        'projectHostedPlanningSearch:search',
        {
          ...terms,
          status: input.status ?? 'active',
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.initiativeId ? { initiativeId: input.initiativeId } : {}),
          cursor: input.cursor,
          limit: input.limit,
        },
      );
      const keep = await rowFilter(input);
      return Array.isArray(found?.items)
        ? { ...found, items: found.items.filter(keep).map(withPlannedLink) }
        : found;
    } catch (error) {
      if (
        error instanceof Error &&
        /(?:Could not find (?:public )?function|No (?:public )?function found|Function .* not found)/i.test(
          error.message,
        )
      )
        throw new ForgeError(
          'HOSTED_ACTION_UNSUPPORTED',
          'This server does not implement planning search. Deploy the planning search API before retrying.',
        );
      throw error;
    }
  }
  const filtered = port.serverFeatures?.includes('planning-filtered-reads');
  const planningFilter = {
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.status && input.status !== 'all' && input.status !== 'active' ? { status: input.status } : {}),
    ...(input.initiativeId ? { initiativeId: input.initiativeId } : {}),
  };
  if (input.counts) {
    invariant(
      filtered,
      'HOSTED_ACTION_UNSUPPORTED',
      'This server needs indexed planning counts. Upgrade the deployment before retrying.',
    );
    let bound = input.cursor === null ? null : decodeBound(input.cursor);
    const counts: Record<string, number> = {};
    let done = false;
    let needsPreparation = false;
    for (let pages = 0; pages < maxCountPages && !done; pages++) {
      const result = await port.query<Page & { counts: Record<string, number>; coverage?: string }>(
        'projectWorkIndex:records',
        {
          ...(bound ? { generationId: bound.generationId } : {}),
          collection: 'planningItems',
          planningFilter,
          counts: true,
          paginationOpts: { cursor: bound?.cursor ?? null, numItems: 1000 },
        },
      );
      invariant(
        result.generationId && (!bound || result.generationId === bound.generationId),
        'WORK_STALE',
        stale,
      );
      for (const [status, count] of Object.entries(result.counts))
        counts[status] = (counts[status] ?? 0) + count;
      needsPreparation ||= result.coverage === 'partial-needs-preparation';
      done = result.isDone;
      bound = { generationId: result.generationId, cursor: result.continueCursor };
    }
    return {
      counts,
      coverage: needsPreparation ? 'partial-needs-preparation' : done ? 'complete' : 'partial',
      nextCursor: done ? null : encode(bound!, bound!.cursor!),
      ...(!done
        ? {
            next: `These counts are incomplete after ${maxCountPages} pages. Run planning with counts:true, the same filters and nextCursor as cursor, then add the returned counts to these totals.`,
          }
        : {}),
    };
  }
  const ws = await workspace(port);
  if (input.id) {
    const id = await resolvePlanningId(port, input.id);
    // Older comments (f0d0fdd6): the detail's commentsCursor as cursor, one bounded page per call.
    if (input.cursor !== null) return await olderComments(port, ws, id, input.cursor);
    const item = await fullItem(port, ws, id);
    invariant(item, 'NOT_FOUND', 'Planning item not found.');
    const comments = await page(port, ws, 'planningComments', null, 50, {
      parentId: id,
      newestFirst: true,
    });
    // One call for the Item's Intent state and its Lanes in any state (1c2ab97a); a server without the Item work
    // read keeps the `intentStates` call and the reply has no `work`.
    // Loaded only for a single-Item read, so the planning and status paths load no extra module (7b2ae8d8).
    const { readItemWork, workSection } = await import('./item-work.js');
    const work = item.kind === 'issue' ? await readItemWork(port, item.id) : null;
    const states =
      item.kind !== 'issue'
        ? {}
        : work?.role
          ? work.intent
            ? { [item.id]: work.intent }
            : {}
          : await intentStates(port, [item.id]);
    const sync = input.reconcile ? await reconcile(port, ws, [item], states) : undefined;
    // The item shows what the reconcile just wrote (the list read does the same): a closed Issue reads closed at its
    // new version, and a held one carries the version the printed close command names.
    const closed = (sync?.changed as { id: string; to: PlanningItem['status'] }[] | undefined)?.find(
      change => change.id === item.id,
    );
    const held = (sync?.held as { id: string; version: number; openLines: number }[] | undefined)?.find(
      entry => entry.id === item.id,
    );
    const settled = closed
      ? { ...item, status: closed.to, version: item.version + 1, reason: `Intent ${states[item.id]}` }
      : held
        ? { ...item, version: held.version, reason: holdMarker(held.openLines) }
        : item;
    const shown = comments.page.map(row => JSON.parse(row.value) as { system?: boolean }).reverse();
    return {
      workRevision: ws.revision,
      item: withPlannedLink({
        ...settled,
        ...(states[item.id] ? { intent: states[item.id] } : {}),
      }),
      ...(work?.role ? { work: workSection(item.id, work) } : {}),
      comments: shown,
      ...(comments.isDone ? {} : commentsContinue(ws, id, comments.continueCursor)),
      ...(shown.some(comment => comment.system === true) ? { systemComments: systemCommentNotice } : {}),
      ...(sync?.changed.length || sync?.failed || sync?.held?.length ? { reconciled: sync } : {}),
    };
  }
  const keep = await rowFilter(input);
  let cursor = decode(input.cursor, ws);
  let scanned = 0;
  let done = false;
  let matches: PlanningItem[] = [];
  // A schedule covers every open Issue it can reach in the bounded pages, not just the first match.
  for (let pages = 0; pages < maxPages && !done && (input.schedule || !matches.length); pages++) {
    const result = await page(
      port,
      ws,
      'planningItems',
      cursor,
      input.limit,
      filtered && ws.planningFilteredReads && Object.keys(planningFilter).length ? { planningFilter } : {},
    );
    scanned += result.page.length;
    done = result.isDone;
    cursor = result.continueCursor;
    matches = [
      ...(input.schedule ? matches : []),
      ...result.page.map(parseRow).filter(
        item =>
          (!input.kind || item.kind === input.kind) &&
          // No status: everything but Archived and Deleted, which are listed only when asked (Item 4c9e961e).
          (input.status === 'all' ||
            (input.status === undefined
              ? !isShelved(item.status)
              : input.status === 'active'
                ? open.includes(item.status)
                : item.status === input.status)) &&
          (!input.initiativeId || item.initiativeId === input.initiativeId) &&
          keep(item),
      ),
    ];
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
        {
          ...item,
          status: (closed.get(item.id) as PlanningItem['status']) ?? item.status,
        },
        states[item.id],
      ),
    ),
    scanned,
    ...(input.schedule
      ? {
          schedule: {
            ...suggestSchedule(
              matches
                .filter(item => item.kind === 'issue')
                .map(item => ({
                  id: item.id,
                  title: item.title,
                  status: (closed.get(item.id) as string | undefined) ?? item.status,
                  at: item.at,
                  paths: issuePaths(item),
                })),
              markdownDoc,
            ),
            coverage: done ? 'complete' : 'partial',
            rule: SCHEDULE_RULE,
          },
        }
      : {}),
    nextCursor: done ? null : encode(ws, cursor!),
    ...(sync?.changed.length || sync?.failed || sync?.held?.length ? { reconciled: sync } : {}),
  };
}

/** The agent's `fields` object becomes flat command fields. A server without `planning-model` would drop them
 * silently: refuse before any call. */
function flattenModelFields(port: PlanningPort, input: Record<string, unknown>) {
  const { fields, ...rest } = input as { fields?: Record<string, unknown> };
  invariant(
    fields?.imported === undefined || port.serverFeatures?.includes('planning-import-pages'),
    'HOSTED_ACTION_UNSUPPORTED',
    'This server does not store planning import attribution yet.',
  );
  const named = Object.keys(fields ?? {}).filter(key => fields![key] !== undefined);
  invariant(
    !named.length || port.serverFeatures?.includes('planning-model'),
    'BAD_ARGUMENT',
    `This Forge server does not store ${named.join(', ')} yet; it would drop them. Send the write without them, or again after the server deploys.`,
  );
  return { ...rest, ...fields };
}

/** A comment write in flight, kept on this machine until the server answers (593fc2d7: a reviewer's
 * run ended while its GO/NO-GO comment command ran, and the verdict was lost). The entry is the first
 * durable step, written before any call; a live process removes it however its write ends. One a
 * killed process left is posted by the next planning read or comment for the same project on this
 * machine, under its original operationId, so the server records it once, and under the author and
 * agent of the run that wrote it, never the run that posts it. Local files only. */
type CommentAuthor = { authorLabel: string; agent?: string; agentClient?: string };
type OutboxEntry = {
  url: string;
  projectId: string;
  operationId: string;
  input: Record<string, unknown>;
  author: CommentAuthor;
  pid: number;
  at: number;
};
const OUTBOX_MAX_AGE_MS = 24 * 3_600_000;
const OUTBOX_PASSING =
  /^(WORK_BUSY|WORK_CHANGED_DURING_PUSH|HOSTED_CONFLICT|HOSTED_ACTION_FAILED|HOSTED_REQUEST_FAILED|LEGACY_STORAGE_WRITES_PAUSED)$/;
const outboxDirectory = () =>
  Boolean(process.env.NODE_TEST_CONTEXT) && !process.env.XDG_STATE_HOME
    ? null
    : join(dirname(laneRegistryDirectory()), 'comment-outbox');
function keepComment(entry: OutboxEntry) {
  const directory = outboxDirectory();
  if (!directory) return () => {};
  const path = join(directory, `${entry.operationId}.json`);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(entry), { mode: 0o600 });
    renameSync(`${path}.${process.pid}.tmp`, path);
  } catch {
    return () => {}; // Best effort: the write itself still runs.
  }
  return () => rmSync(path, { force: true });
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
let flushing = false;
/** Post the comments ended runs left unsent for this project (at most 5 per call), oldest first. */
async function flushComments(port: PlanningPort, actor: string) {
  const directory = outboxDirectory();
  if (!directory || flushing) return [];
  let names: string[];
  try {
    names = readdirSync(directory);
    // A write cut between its temp file and the rename leaves the temp file: drop it with the old entries.
    for (const name of names.filter(name => name.endsWith('.tmp')))
      try {
        if (Date.now() - statSync(join(directory, name)).mtimeMs > OUTBOX_MAX_AGE_MS)
          rmSync(join(directory, name), { force: true });
      } catch {}
    names = names.filter(name => /^[0-9a-f-]{36}\.json$/i.test(name)); // uuidgen prints uppercase
  } catch {
    return [];
  }
  const entries = names.flatMap(name => {
    try {
      const entry = JSON.parse(readFileSync(join(directory, name), 'utf8')) as OutboxEntry;
      if (Date.now() - entry.at > OUTBOX_MAX_AGE_MS || !entry.author)
        rmSync(join(directory, name), { force: true });
      else if (
        entry.url === port.address.url &&
        entry.projectId === port.address.projectId &&
        !alive(entry.pid)
      )
        return [{ entry, path: join(directory, name) }];
    } catch {}
    return [];
  });
  const posted: { itemId: string; commentId: string }[] = [];
  flushing = true;
  try {
    for (const { entry, path } of entries.sort((a, b) => a.entry.at - b.entry.at).slice(0, 5)) {
      try {
        const sent = await executeHostedPlanning(
          port,
          actor,
          'comment-planning-item',
          entry.input,
          entry.operationId,
          entry.author,
        );
        const { itemId, commentId } = sent.result as { itemId: string; commentId: string };
        posted.push({ itemId, commentId });
      } catch (error) {
        // The network, the sign-in or the service is out: keep this and the rest for the next read.
        if (
          !(error instanceof ForgeError) ||
          /^(AUTH_|EXCHANGE_|RATE_LIMITED$)|NETWORK|TIMEOUT|UNAVAILABLE/.test(error.code)
        )
          break;
        // This write is refused for now (busy, conflicting, paused): keep it and try the next one. A
        // refusal (no access, a changed or spent operation) will not change on a retry, so it goes.
        if (error.recovery?.retryable === true || OUTBOX_PASSING.test(error.code)) continue;
      }
      rmSync(path, { force: true });
    }
  } finally {
    flushing = false;
  }
  if (posted.length)
    process.stderr.write(
      `Posted ${posted.length} comment(s) an ended run left unsent: ${posted.map(item => `${item.commentId} on Item ${item.itemId.slice(0, 8)}`).join(', ')}.\n`,
    );
  return posted;
}

export async function executeHostedPlanning(
  port: PlanningPort,
  actor: string,
  action: 'planning' | 'put-planning-item' | 'comment-planning-item',
  input: Record<string, unknown>,
  operationId: string | undefined,
  /** A comment the outbox posts again: the author it was written under. */
  replayAuthor?: CommentAuthor,
) {
  input = planningIssueArguments(action, input);
  const recovered = action === 'put-planning-item' ? [] : await flushComments(port, actor);
  if (action === 'planning' && input.transfer !== undefined) {
    const { importPlanning } = await import('./hosted-agent-planning-import.js');
    const imported = await importPlanning(port, actor, input, operationId);
    return { ...imported, result: marked(imported.result) };
  }
  if (action === 'planning') {
    const read = hostedAgentCommandSchemas.planning.parse(input);
    const result = marked(await readPlanning(port, read));
    return {
      operationId: null,
      result: recovered.length ? { ...result, recoveredComments: recovered } : result,
    };
  }
  const journal = new HostedAgentJournal(port.root, port.address, actor, action, input, operationId);
  port.retainOperation?.(journal.operationId);
  if (action === 'comment-planning-item') {
    const comment = hostedAgentCommandSchemas['comment-planning-item'].parse(input);
    const author: CommentAuthor = replayAuthor ?? {
      authorLabel: comment.authorLabel || process.env.FORGE_AGENT_NAME || process.env.FORGE_ACTOR || '',
      ...port.commentAgent?.(),
    };
    // A replayed comment already has its entry; the flush removes it once the server answers.
    const done = replayAuthor
      ? () => {}
      : keepComment({
          url: port.address.url,
          projectId: port.address.projectId,
          operationId: journal.operationId,
          input,
          author,
          pid: process.pid,
          at: Date.now(),
        });
    try {
      const itemId = await resolvePlanningId(port, comment.itemId!, journal);
      const revision = await writePlanning(
        port,
        {
          action,
          operationId: journal.operationId,
          ...comment,
          itemId,
          ...author,
        },
        journal,
      ).catch(async error => {
        throw (await frictionCommentPointer(port, itemId, error)) ?? error;
      });
      return {
        operationId: journal.operationId,
        result: {
          itemId,
          commentId: journal.operationId,
          workRevision: revision,
          ...(recovered.length ? { recoveredComments: recovered } : {}),
        },
      };
    } finally {
      done();
    }
  }
  if (input.batch !== undefined) {
    const { batch } = hostedAgentCommandSchemas['put-planning-item'].parse(input);
    const { hostedPlanningBatch } = await import('./hosted-agent-planning-batch.js');
    return {
      operationId: journal.operationId,
      result: await hostedPlanningBatch(port, batch!, journal, {
        planningCommentCommandSchema,
        planningPutAgentFields,
        planningPutSchema,
      }),
    };
  }
  const put = flattenModelFields(port, hostedAgentCommandSchemas['put-planning-item'].parse(input)) as Omit<
    Extract<PlanningWrite, { action: 'put-planning-item' }>,
    'action' | 'operationId' | 'itemId'
  > & { itemId?: string };
  invariant(
    put.expectedVersion > 0 || (put.kind && put.title),
    'BAD_ARGUMENT',
    'Creating a planning item (expectedVersion 0) needs `kind` and `title`.',
  );
  invariant(
    put.expectedVersion > 0 || !put.itemId || !isPlanningPrefix(put.itemId),
    'BAD_ARGUMENT',
    'Creating a planning item (expectedVersion 0) needs a complete itemId UUID, or none.',
  );
  const itemId = put.itemId ? await resolvePlanningId(port, put.itemId, journal) : await journal.id('item');
  // Other Item id fields take the same short ids; full ids make no call.
  const ref = (value: string, field: string) =>
    resolvePlanningId(port, value, journal, `planning-id-prefix:${field}:${value.toLowerCase()}`);
  if (typeof put.initiativeId === 'string') put.initiativeId = await ref(put.initiativeId, 'initiativeId');
  if (typeof put.parentId === 'string') put.parentId = await ref(put.parentId, 'parentId');
  if (put.relations)
    put.relations = await Promise.all(
      put.relations.map(async relation => ({ ...relation, id: await ref(relation.id, 'relations') })),
    );
  const hints: { likelyDuplicates?: unknown } = {};
  const revision = await writePlanning(
    port,
    { action, operationId: journal.operationId, ...put, itemId },
    journal,
    hints,
  );
  return {
    operationId: journal.operationId,
    result: {
      itemId,
      version: put.expectedVersion + 1,
      ...(put.status === undefined ? {} : { status: put.status }),
      workRevision: revision,
      ...hints,
    },
  };
}

/** The Intent a planned Issue starts: it shares the Issue's id, so repeated starts add Lanes to it. */
export async function plannedIntent(port: PlanningPort, itemId: string) {
  const ws = await workspace(port);
  const item = await fullItem(port, ws, await resolvePlanningId(port, itemId));
  invariant(item, 'NOT_FOUND', 'Planning item not found.');
  invariant(
    item.kind === 'issue',
    'BAD_ARGUMENT',
    'Start from an Issue. An Initiative groups Issues; start one of them.',
  );
  if (!open.includes(item.status))
    throw new ForgeError(
      'INTENT_CLOSED',
      `This Issue is ${item.status}. The project owner reopens it with: nforge agent . put-planning-item '{"itemId":"${item.id}","expectedVersion":${item.version},"status":"open"}', then starts it again. Anyone else starts a plain outcome instead: nforge agent . start '{"outcome":"..."}'.`,
      undefined,
      {
        reopen: {
          action: 'put-planning-item',
          input: {
            itemId: item.id,
            expectedVersion: item.version,
            status: 'open',
          },
          needs: 'project owner',
        },
        plainStart: {
          action: 'start',
          input: { outcome: item.title.slice(0, 500) },
        },
      },
    );
  return {
    kind: 'planned' as const,
    intentId: item.id,
    outcome: item.title.slice(0, 500),
    ...(item.body ? { constraints: item.body.slice(0, 4000) } : {}),
  };
}
/** A public identity a start may claim an Item for: a Forge handle, or `handle/agent` (the session's word-pair slug). */
const claimShape = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])(?:\/[a-z]+-[a-z]+)?$/;
/** The server's refusal of a planning write by anyone but the project owner (convex/projectWorkCommand.ts and
 * convex/projectWork.ts): the one refusal after which the server itself moves a member's started Issue. */
const ownerOnlyPlanning = 'Project planning is available to its current owner.';
/** After a start, the Issue shows the work as in progress, and an Issue nobody owns is claimed for the starter
 * (owner 2026-11-19, Item d3357f40): `claimAs` is the session's public identity (`handle/agent`, or a handle), stored
 * as the owner `@handle/agent`. Both ride the one write the start already makes; an Issue already in progress and
 * unowned takes one write once, then never again. An owner set by anyone is never replaced. A failure here never
 * fails the start, which already holds the Lane: it is reported, and running the same start again retries it. */
export async function markPlanningStarted(
  port: PlanningPort,
  itemId: string,
  startOperationId: string,
  claimAs?: string,
) {
  try {
    const ws = await workspace(port);
    const item = await fullItem(port, ws, itemId);
    if (!item)
      return {
        updated: false,
        error: { code: 'NOT_FOUND', message: 'Planning item not found.' },
      };
    // A start never brings an Archived or Deleted Item back (Item 4c9e961e): it writes no status and claims nothing.
    // The start itself already holds its Lane; bringing the Item back is the owner's explicit Unarchive or Restore.
    if (isShelved(item.status))
      return {
        updated: false,
        status: item.status,
        note: `Still ${item.status}: a start does not bring it back. To show it again, put status "${item.was ?? 'open'}" on it (Unarchive or Restore).`,
      };
    const claim =
      !item.owner &&
      claimAs &&
      claimShape.test(claimAs) &&
      // A server without the planning model would drop the field (docs/planning.md, Fields).
      port.serverFeatures?.includes('planning-model')
        ? `@${claimAs}`
        : undefined;
    if (item.status === 'in-progress' && !claim) return { updated: false, status: item.status };
    // A member who cannot edit the plan (planning writes are the project owner's) gets no error to act on: with only the
    // claim left to write (the Issue is already in progress) the start stays as it was (review 3f84a176), an open
    // Issue is moved to in progress by the server itself after the start (convex/projectPlanningStart.ts), and a
    // proposed Issue waits for the owner to accept it.
    const claimOnly = item.status === 'in-progress';
    try {
      await writePlanning(
        port,
        {
          ...putFrom(item, uuidFrom(`${startOperationId}:planning-start`), 'in-progress'),
          ...(claim ? { owner: claim } : {}),
        },
        undefined,
        undefined,
        item,
      );
    } catch (error) {
      if (claimOnly) return { updated: false, status: item.status, claimed: false };
      // Only the owner-only planning refusal, and only on a server that moves the Issue itself (planning-start-move):
      // any other refusal (for example an owner's write refused for another reason) is reported as before. The server
      // moves an open Issue only (convex/projectPlanningStart.ts), so nothing else is reported as moved.
      const safe = hostedActionError(error, 'planning start');
      const memberRefused =
        safe.code === 'PROJECT_UNAVAILABLE' &&
        safe.message === ownerOnlyPlanning &&
        port.serverFeatures?.includes('planning-start-move') &&
        item.kind === 'issue';
      // A proposed Issue stays proposed for a member: approving a proposal is the owner's call (lead 2026-11-19).
      if (memberRefused && item.status === 'proposed')
        return {
          updated: false,
          status: 'proposed',
          claimed: false,
          waitsFor: 'owner',
          note: 'Still proposed: it shows as in progress once the project owner approves it.',
        };
      // An open Issue: the server moves it after the start.
      if (memberRefused && (item.status ?? 'open') === 'open')
        return { updated: false, status: 'in-progress', movedBy: 'server', claimed: false };
      throw error;
    }
    return {
      updated: true,
      status: 'in-progress',
      version: item.version + 1,
      ...(claim ? { owner: claim } : {}),
    };
  } catch (error) {
    const safe = hostedActionError(error, 'planning start');
    return {
      updated: false,
      error: { code: safe.code, message: safe.message },
      retry: 'Run the same start again, or set the Issue to in-progress with put-planning-item.',
    };
  }
}
