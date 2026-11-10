// SPDX-License-Identifier: Apache-2.0
import { memberDataNotice } from './member-data-notice.js';
import { planningSummary, planningSearchTerms } from './planning-search.js';
import { createHash } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { hostedActionError } from './hosted-action-error.js';
import { readIndexedWorkDetail } from './hosted-work-client.js';
import { ForgeError, invariant } from './errors.js';
import { isPlanningPrefix, planningIdMaxCandidates } from './planning-id.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
import type { PlanningItem, PlanningWrite } from './work-planning-types.js';
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
};
type Workspace = {
  generationId: string;
  revision: number;
  sourceRevision?: number;
  likelyDuplicates?: unknown;
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
    invariant(
      item.version === command.expectedVersion,
      'PLANNING_CHANGED',
      `The planning item is at version ${item.version}, not ${command.expectedVersion}. Read it again.`,
    );
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

/** Writes carry the original operation; a stale or moved Work revision is retried a few times with
 * the revision each attempt used retained, so a lost reply replays instead of repeating. */
async function writePlanning(
  port: PlanningPort,
  request: PlanningWrite,
  journal?: HostedAgentJournal,
  hints?: { likelyDuplicates?: unknown },
  stored?: PlanningItem,
) {
  // Comments are insert-only: they take the revision-free mutation the web uses (flip 5 S0), one call,
  // and an unrelated Work write never refuses them. The operation id reconciles a retry.
  if (request.action === 'comment-planning-item')
    return (
      await port
        .mutation<{ revision: number }>('projectWorkCommand:command', {
          operationId: request.operationId,
          command: JSON.stringify(request),
        })
        .catch(error => {
          throw hostedActionError(error, 'planning write');
        })
    ).revision;
  const command = await compatiblePut(port, request, journal, stored);
  for (let attempt = 0; ; attempt++) {
    const observe = async () => {
      const ws = await workspace(
        port,
        command.action === 'put-planning-item' && command.kind === 'issue' && command.expectedVersion === 0
          ? `${command.title ?? ''} ${command.body ?? ''}`
          : undefined,
      );
      return {
        revision: ws.revision,
        ...(ws.likelyDuplicates === undefined ? {} : { likelyDuplicates: ws.likelyDuplicates }),
      };
    };
    const retained = journal
      ? await journal.retain(`planning-revision-${attempt}`, observe)
      : await observe();
    // Existing retry journals retain just the revision number.
    const observed = typeof retained === 'number' ? { revision: retained } : retained;
    const revision = observed.revision;
    if (hints && 'likelyDuplicates' in observed) hints.likelyDuplicates = observed.likelyDuplicates;
    try {
      const args = {
        projectId: port.address.projectId,
        operationId: command.operationId,
        revision,
        command: JSON.stringify(command),
      };
      const call = (name: string) =>
        port.exchange.client.action(makeFunctionReference<'action'>(name), args) as Promise<{
          revision: number;
        }>;
      // The 64 MiB V8 command (Issue 85801d6f). A server deployed before it has no such function, and a
      // call that never found its function ran nothing: the same original operation goes to the Node one.
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
  const { ids, more } = journal ? await journal.retain('planning-id-prefix', find) : await find();
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
      .replace(/^[ \t>]*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/, '')
      .replace(/\s+/g, ' ')
      .trim();
  const boxes = body.match(/^[ \t>]*(?:[-*+]|\d+[.)])\s+\[([ xX])\].*$/gm) ?? [];
  if (boxes.length) return boxes.filter(line => /^[ \t>]*(?:[-*+]|\d+[.)])\s+\[ \]/.test(line)).map(lineText);
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

async function readPlanning(
  port: PlanningPort,
  input: ReturnType<typeof hostedAgentCommandSchemas.planning.parse>,
) {
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
      return Array.isArray(found?.items) ? { ...found, items: found.items.map(withPlannedLink) } : found;
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
  const ws = await workspace(port);
  if (input.id) {
    const id = await resolvePlanningId(port, input.id);
    const item = await fullItem(port, ws, id);
    invariant(item, 'NOT_FOUND', 'Planning item not found.');
    const comments = await page(port, ws, 'planningComments', null, 50, {
      parentId: id,
      newestFirst: true,
    });
    const states = item.kind === 'issue' ? await intentStates(port, [item.id]) : {};
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
    return {
      workRevision: ws.revision,
      item: withPlannedLink({
        ...settled,
        ...(states[item.id] ? { intent: states[item.id] } : {}),
      }),
      comments: comments.page.map(row => JSON.parse(row.value)).reverse(),
      ...(comments.isDone ? {} : { commentsMore: true }),
      ...(sync?.changed.length || sync?.failed || sync?.held?.length ? { reconciled: sync } : {}),
    };
  }
  let cursor = decode(input.cursor, ws);
  let scanned = 0;
  let done = false;
  let matches: PlanningItem[] = [];
  // A schedule covers every open Issue it can reach in the bounded pages, not just the first match.
  for (let pages = 0; pages < maxPages && !done && (input.schedule || !matches.length); pages++) {
    const result = await page(port, ws, 'planningItems', cursor, input.limit);
    scanned += result.page.length;
    done = result.isDone;
    cursor = result.continueCursor;
    matches = [
      ...(input.schedule ? matches : []),
      ...result.page
        .map(parseRow)
        .filter(
          item =>
            (!input.kind || item.kind === input.kind) &&
            (!input.status || input.status === 'all' || item.status === input.status) &&
            (!input.initiativeId || item.initiativeId === input.initiativeId),
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

export async function executeHostedPlanning(
  port: PlanningPort,
  actor: string,
  action: 'planning' | 'put-planning-item' | 'comment-planning-item',
  input: Record<string, unknown>,
  operationId: string | undefined,
) {
  if (action === 'planning') {
    const read = hostedAgentCommandSchemas.planning.parse(input);
    return { operationId: null, result: marked(await readPlanning(port, read)) };
  }
  const journal = new HostedAgentJournal(port.root, port.address, actor, action, input, operationId);
  port.retainOperation?.(journal.operationId);
  if (action === 'comment-planning-item') {
    const comment = hostedAgentCommandSchemas['comment-planning-item'].parse(input);
    const itemId = await resolvePlanningId(port, comment.itemId, journal);
    const revision = await writePlanning(
      port,
      {
        action,
        operationId: journal.operationId,
        ...comment,
        itemId,
        authorLabel: comment.authorLabel || process.env.FORGE_AGENT_NAME || process.env.FORGE_ACTOR || '',
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
      },
    };
  }
  const put = hostedAgentCommandSchemas['put-planning-item'].parse(input);
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
/** After a start, the Issue shows the work as in progress. A failure here never fails the start,
 * which already holds the Lane: it is reported, and running the same start again retries it. */
export async function markPlanningStarted(port: PlanningPort, itemId: string, startOperationId: string) {
  try {
    const ws = await workspace(port);
    const item = await fullItem(port, ws, itemId);
    if (!item)
      return {
        updated: false,
        error: { code: 'NOT_FOUND', message: 'Planning item not found.' },
      };
    if (item.status === 'in-progress') return { updated: false, status: item.status };
    await writePlanning(
      port,
      putFrom(item, uuidFrom(`${startOperationId}:planning-start`), 'in-progress'),
      undefined,
      undefined,
      item,
    );
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
