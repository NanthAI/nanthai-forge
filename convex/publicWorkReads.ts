// SPDX-License-Identifier: Apache-2.0
/** Registration-boundary projection for every role-less viewer, including signed-in visitors.
 * Current planning roots decide visibility even for historical versions and comment descriptors.
 * Reuses current roots read by the handler and resolves selected parents inside the same query; no board scan.
 * Members keep exact replies. This runs only on reads, never on the landing/mutation path. */
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { ForgeError } from '../src/errors';
import { report } from './errors';
import { publicWorkReadContext } from './publicWorkReadContext';
import { authorizedReadProject, readProjectRole } from './projectAuthority';
import { publicWorkPlan, type PublicPlanRoot } from './publicWorkPlan';
import { publicRow } from './publicListing';
import { finishReadSourceDb } from './projectFinishReadReader';
import { digest } from '../src/state/hash';

type ObjectValue = Record<string, unknown>;
const REMOVE = Symbol('hidden');
const planning = (collection: string) =>
  collection.startsWith('planning') || ['issues', 'comments'].includes(collection);
const lanes = (collection: string) => ['lanes', 'intents', 'notes', 'lifecycle'].includes(collection);
const parse = (value: unknown): unknown => {
  if (typeof value !== 'string' || !/^\s*[\[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
/** A read's `request` argument decoded exactly as its reader decodes it (JSON.parse): an object, `{}` when there is
 * none, or null when the reader would see something other than an object. */
export const decodeRequest = (value: unknown): ObjectValue | null => {
  if (value === undefined) return {};
  let decoded = value;
  if (typeof value === 'string')
    try {
      decoded = JSON.parse(value);
    } catch {
      return null;
    }
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? (decoded as ObjectValue) : null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A UUID v4-shaped id no record has: it stands in for plan work a viewer may not see. */
const absentId = (seed: string) => {
  const h = digest(`forge-public-absent:${seed}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
type Path = readonly string[];
const at = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (node, key) => (node && typeof node === 'object' ? (node as ObjectValue)[key] : undefined),
    value,
  );
const withAt = <T>(value: T, [key, ...rest]: Path, next: string): T => {
  const out = (Array.isArray(value) ? [...value] : { ...object(value) }) as ObjectValue;
  out[key!] = rest.length ? withAt(out[key!], rest, next) : next;
  return out as T;
};
/** Arguments that select plan work by Item, Initiative or Intent: an Item's work, Lanes by Item or Intent (one or a
 * list), History by Item, a Plan page by Initiative, a planning record or comment page by its Item, and a Work record
 * page or record of Lanes by their Intent or of an Intent itself. */
const selectionPaths = (command: ObjectValue, collection: string): Path[] => {
  const list = (key: string) =>
    Array.isArray(command[key]) ? (command[key] as unknown[]).map((_, index) => [key, String(index)]) : [];
  return [
    ['itemId'],
    ['planningItemId'],
    ['item'],
    ['intentId'],
    ...list('intentIds'),
    ['initiativeId'],
    ['planningFilter', 'initiativeId'],
    ...(planning(collection)
      ? [['parentId'], ...(collection === 'comments' || collection === 'planningComments' ? [] : [['id']])]
      : []),
    ...(collection === 'lanes' ? [['parentId']] : []),
    ...(collection === 'intents' ? [['id'], ['parentId']] : []),
  ].filter(path => {
    const id = at(command, path);
    return typeof id === 'string' && UUID.test(id);
  });
};
/** Put the stand-in ids back into a reply (values, keys, JSON strings) so it names the id that was asked for. */
const restore = (value: unknown, swaps: Map<string, string>): unknown => {
  if (typeof value === 'string') {
    let out = value;
    for (const [stand, id] of swaps) out = out.split(stand).join(id);
    return out;
  }
  if (Array.isArray(value)) return value.map(entry => restore(entry, swaps));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [restore(key, swaps), restore(entry, swaps)]),
  );
};

/** All output encodings pass here, including JSON strings nested in record pages. */
export async function publicWorkResult(
  ctx: QueryCtx,
  args: unknown,
  result: unknown,
  scope: {
    planning: boolean;
    lanes: boolean;
    roots?: Map<string, PublicPlanRoot>;
    internalPlan?: boolean;
  } = {
    planning: true,
    lanes: true,
  },
): Promise<unknown> {
  if (!scope.planning && !scope.lanes) return result;
  const input = object(args);
  if (typeof input.projectId !== 'string') return result;
  const command = { ...input, ...(decodeRequest(input.request) ?? {}) };
  const collection = typeof command.collection === 'string' ? command.collection : '';
  const body = object(parse(result));
  const states =
    Array.isArray(command.ids) &&
    Object.entries(body).every(
      ([id, value]) =>
        (command.ids as unknown[]).includes(id) &&
        typeof value === 'string' &&
        ['active', 'ready', 'completed', 'abandoned'].includes(value),
    );
  let project =
    authorizedReadProject(ctx, input.projectId) ??
    (await ctx.db.get(input.projectId as Doc<'hostedProjects'>['_id']));
  if (!project || project.removal) return result; // The handler owns the not-found answer.
  const viewer = (await ctx.auth.getUserIdentity())?.subject;
  if (viewer && (await readProjectRole(ctx, project, viewer))) return result;
  // Compact authority headers intentionally omit planning policy. Resolve that policy from
  // its current source once for role-less planning reads, including old untouched headers.
  const source = finishReadSourceDb(ctx);
  if (scope.planning && source !== ctx.db) {
    const current = await source.get(project._id);
    if (!current || current.removal)
      return report(new ForgeError('PROJECT_UNAVAILABLE', 'This project is unavailable.'));
    project = current;
  }
  if (scope.internalPlan)
    return report(
      new ForgeError(
        'PROJECT_UNAVAILABLE',
        'Read the public Plan view instead of its internal member projection.',
      ),
    );
  // The roots the handler itself read, before visibility lookups add parents to the same map.
  const handlerRoots = [...(scope.roots ?? new Map()).values()];
  const laneTitles = (await publicRow(ctx, project._id))?.laneTitles === true;
  const plan = publicWorkPlan(ctx, project, scope.roots ?? new Map());
  const allowed = plan.allowed;
  /** A Lane-shaped row names hidden plan work when its Intent does; a row whose Intent cannot be found is treated
   * as hidden. Runs only with the Lane-title opt-in on: one indexed head read per Lane id given without its Intent. */
  const laneHidden = async (row: ObjectValue, hint: string) => {
    if (typeof row.intentId === 'string') return plan.intentHidden(row.intentId);
    if (row.kind === 'intent' || hint === 'intents') return plan.intentHidden(row.id);
    if (typeof row.laneId === 'string') {
      const laneId = row.laneId;
      const head = await ctx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_key', q =>
          q.eq('projectId', project._id).eq('kind', 'lane').eq('key', laneId),
        )
        .unique();
      return plan.intentHidden(head?.parent);
    }
    return true;
  };
  const roots = plan.visibleLoaded;
  // A selection of plan work this viewer may not see already ran as an absent Item (publicWorkSelection).
  const membersOnly = project.planVisibility === 'members';
  const visit = async (node: unknown, hint = collection, key = ''): Promise<unknown> => {
    // A member's prose or source content is literal, even if it happens to be valid JSON.
    let parsed = ['', 'value', 'rows', 'command', 'approvals'].includes(key) ? parse(node) : node;
    // A settled Plan page returns each plan row as a JSON string (projectPlanSettled:page).
    if (key === 'page' && typeof node === 'string') {
      const row = object(parse(node));
      if (row.kind === 'issue' || row.kind === 'initiative') parsed = row;
    }
    if (parsed !== node) {
      const mapped = await visit(parsed, hint, key);
      return mapped === REMOVE ? REMOVE : JSON.stringify(mapped);
    }
    if (Array.isArray(node)) {
      const out = [];
      for (const entry of node) {
        const mapped = await visit(entry, hint, key);
        if (mapped !== REMOVE) out.push(mapped);
      }
      return out;
    }
    if (!node || typeof node !== 'object') return node;
    const row = node as ObjectValue;
    // An Item link on a Lane-shaped row (History's `item: {id, title}`): present only when the Item is visible.
    if (key === 'item' && typeof row.id === 'string' && typeof row.title === 'string' && !('kind' in row))
      return (await allowed(row.id)) ? row : REMOVE;
    const ownHint = typeof row.collection === 'string' ? row.collection : hint;
    const value = object(parse(row.value));
    const item = object(value.item);
    const isItem =
      row.kind === 'issue' ||
      row.kind === 'initiative' ||
      (typeof row.id === 'string' && (value.kind === 'issue' || value.kind === 'initiative'));
    if (
      (scope.planning && isItem) ||
      (planning(ownHint) &&
        ((typeof row.id === 'string' && 'value' in row) || key === 'record' || key === 'items'))
    ) {
      const id = item.id ?? value.itemId ?? value.id ?? row.itemId ?? row.id;
      const parent = row.parentId ?? value.itemId;
      if (!(await allowed(ownHint === 'planningComments' || ownHint === 'comments' ? parent : id)))
        return REMOVE;
    }
    if (scope.planning && typeof row.itemId === 'string' && !(await allowed(row.itemId))) return REMOVE;
    if (typeof row.initiativeId === 'string' && key === 'settled' && !(await allowed(row.initiativeId)))
      return REMOVE;
    const lane =
      scope.lanes &&
      (lanes(ownHint) ||
        typeof row.laneId === 'string' ||
        typeof row.intentId === 'string' ||
        'goal' in row ||
        row.kind === 'intent' ||
        row.kind === 'lane');
    // A planned Intent shares its Item's id: an Intent record of a hidden Item is that Item, absent like it.
    if (
      typeof row.id === 'string' &&
      (row.kind === 'intent' || (collection === 'intents' && (key === 'value' || 'value' in row))) &&
      (await plan.workHidden(row.id))
    )
      return REMOVE;
    const laneBlank = lane && (!laneTitles || (await laneHidden(row, ownHint)));
    const out: ObjectValue = {};
    let removed = false;
    for (const [name, entry] of Object.entries(row)) {
      // A search's read statistics count matches before rows are hidden: they would tell a hidden Item's words.
      if (['matchedRecordsRead', 'matchedRecordBytes'].includes(name) && typeof entry === 'number') {
        out[name] = 0;
        continue;
      }
      // A Lane-shaped row of a hidden Item names it by its Intent id (a planned Intent is its Item), and a Lane record
      // by its parent: an id no record has stands in, seeded by the row itself so it neither names nor groups the hidden Item.
      if (
        lane &&
        ['intentId', 'planningItemId', 'parentId'].includes(name) &&
        typeof entry === 'string' &&
        (await plan.workHidden(entry))
      ) {
        out[name] = absentId(JSON.stringify([row.laneId ?? row.id ?? '', name]));
        continue;
      }
      // An Intent's constraints (the Item body a planned start copies) and its verbatim journal are never a title.
      if (lane && ['constraints', 'journal'].includes(name)) {
        out[name] = typeof entry === 'string' ? '' : entry && typeof entry === 'object' ? {} : entry;
        continue;
      }
      // Lane-shaped rows name their Intent under several fields: the Lane list's `intent` text, the queue's
      // `intentTitle`, a conflict's `peerGoal`.
      if (
        laneBlank &&
        ([
          'title',
          'name',
          'goal',
          'outcome',
          'description',
          'note',
          'reason',
          'intentTitle',
          'peerGoal',
        ].includes(name) ||
          (name === 'intent' && typeof entry === 'string'))
      ) {
        out[name] = entry === null ? null : '';
        continue;
      }
      if (name === 'ids' && Array.isArray(entry)) {
        out[name] = [];
        for (const id of entry) if (await allowed(id)) (out[name] as unknown[]).push(id);
        continue;
      }
      const nestedHint =
        lane || ['lane', 'lanes', 'intent', 'intents', 'conflicts'].includes(name) ? 'lanes' : ownHint;
      const mapped = await visit(entry, nestedHint, name);
      if (Array.isArray(entry) && Array.isArray(mapped) && mapped.length < entry.length) removed = true;
      out[name] = mapped === REMOVE ? null : mapped;
    }
    // A members-only plan shows no plan row: a plan page that held any, or none, is an empty, finished page. On a public
    // plan, a page left empty by hidden rows is finished too. Either way walking its cursor cannot count hidden rows.
    const pageKey = ['page', 'items', 'rows'].find(name => Array.isArray(out[name]));
    if (pageKey && (removed || planning(collection) || pageKey === 'items')) {
      if (membersOnly && removed) out[pageKey] = [];
      if ((out[pageKey] as unknown[]).length === 0 && (removed || membersOnly))
        for (const name of Object.keys(out)) {
          if (name === 'isDone') out[name] = true;
          else if (name === 'continueCursor') out[name] = typeof out[name] === 'string' ? '' : null;
          else if (['nextCursor', 'next'].includes(name)) out[name] = null;
        }
    }
    if (key === 'settled') {
      const visible = [...(await roots()).values()].filter(
        item => item.kind === 'issue' && item.initiativeId === row.initiativeId,
      );
      out.done = visible.filter(item => item.status === 'closed').length;
      out.dropped = visible.filter(item => item.status === 'abandoned').length;
    }
    if (
      out.counts &&
      typeof out.counts === 'object' &&
      !Array.isArray(out.counts) &&
      Object.keys(out.counts).some(key => key.startsWith('planning'))
    ) {
      const counts = { ...(out.counts as Record<string, number>) };
      for (const key of Object.keys(counts)) if (key.startsWith('planning')) delete counts[key];
      out.counts = counts;
    }
    if (planning(ownHint) && out.counts && typeof out.counts === 'object' && !Array.isArray(out.counts)) {
      const counts: Record<string, number> = {};
      // A counts page reads plan roots and returns no rows: count the visible roots it read.
      const counted: ObjectValue[] = [];
      if (command.counts === true) {
        // The selection guard can also load the Initiative itself before the count page runs.
        const { initiativeId } = object(command.planningFilter);
        for (const root of handlerRoots)
          if ((initiativeId === undefined || root.initiativeId === initiativeId) && (await allowed(root.id)))
            counted.push(root);
      } else
        for (const row of Array.isArray(out.page) ? out.page : [])
          counted.push(object(parse(object(row).value)));
      for (const item of counted)
        if (typeof item.status === 'string') counts[item.status] = (counts[item.status] ?? 0) + 1;
      out.counts = counts;
    }
    return out;
  };
  // intentStates is an id-keyed map rather than an array of Item rows.
  if (states) {
    const filtered: ObjectValue = {};
    for (const [id, value] of Object.entries(body)) if (await allowed(id)) filtered[id] = value;
    return typeof result === 'string' ? JSON.stringify(filtered) : filtered;
  }
  const out = await visit(result);
  return out === REMOVE ? null : out;
}

/** Before the handler runs: a role-less viewer's selection of plan work it may not see (a hidden Item or Initiative, any
 * Item of a members-only plan, an Intent this read cannot tie to a visible Item) is replaced by an id no record has, so
 * the reply is the handler's own answer for an absent Item, cursors and errors included (Convex allows one paginated
 * read per query, so the answer cannot be rebuilt after the handler). Only reads given a selection pay for this. In a
 * registered query a member's project and role reads here are the handler's own: the query reuses a document it already
 * read by id and a role it already checked. A journal history read with a selection pays one project read more. A visitor adds one indexed root read per selected id. */
export async function publicWorkSelection(
  ctx: QueryCtx,
  args: unknown,
): Promise<{ args: unknown; swaps: Map<string, string> } | null> {
  const input = object(args);
  if (typeof input.projectId !== 'string') return null;
  const request = decodeRequest(input.request);
  // A flat reader reads the top-level arguments and a nested one its `request`: each is checked on its own, under
  // either collection name, so neither can carry a selection the other hides.
  const collections = [
    ...new Set([input.collection, request?.collection].filter(c => typeof c === 'string')),
  ];
  const pathsOf = (source: ObjectValue) => {
    const seen = new Map<string, Path>();
    for (const collection of collections.length ? (collections as string[]) : [''])
      for (const path of selectionPaths(source, collection)) seen.set(JSON.stringify(path), path);
    return [...seen.values()];
  };
  const inputPaths = pathsOf(input);
  const requestPaths = request ? pathsOf(request) : [];
  if (!inputPaths.length && !requestPaths.length && request) return null;
  const known =
    authorizedReadProject(ctx, input.projectId) ??
    (await ctx.db.get(input.projectId as Doc<'hostedProjects'>['_id']));
  // A private project answers a role-less viewer as unavailable whatever it selects: the handler owns that.
  if (!known || known.removal || known.visibility !== 'public') return null;
  const viewer = (await ctx.auth.getUserIdentity())?.subject;
  if (viewer && (await readProjectRole(ctx, known, viewer))) return null;
  // A request this boundary cannot read as its reader would is refused, never passed on unchecked.
  if (!request) report(new ForgeError('BAD_ARGUMENT', 'The request must be a JSON object.'));
  const source = finishReadSourceDb(ctx);
  const project = source === ctx.db ? known : await source.get(known._id);
  if (!project || project.removal) return null;
  const plan = publicWorkPlan(ctx, project, new Map());
  const swaps = new Map<string, string>();
  const swap = async (from: ObjectValue, paths: Path[]) => {
    let out = from;
    for (const path of paths) {
      const id = at(from, path) as string;
      if (await plan.selectionVisible(id)) continue;
      const stand = absentId(id);
      swaps.set(stand, id);
      out = withAt(out, path, stand);
    }
    return out;
  };
  const swappedInput = await swap(input, inputPaths);
  const swappedRequest = await swap(request, requestPaths);
  if (!swaps.size) return null;
  const replaced =
    requestPaths.length && swappedRequest !== request
      ? {
          ...swappedInput,
          request: typeof input.request === 'string' ? JSON.stringify(swappedRequest) : swappedRequest,
        }
      : swappedInput;
  return { args: replaced, swaps };
}

/** Run a read with its selection swapped (publicWorkSelection) and the asked-for ids put back into its reply and
 * errors. The handler gets the arguments exactly as given when nothing is swapped. */
export async function publicWorkSelected<R>(
  ctx: QueryCtx,
  args: unknown,
  run: (args: unknown) => Promise<R> | R,
): Promise<R> {
  const selection = await publicWorkSelection(ctx, args);
  if (!selection) return run(args);
  try {
    return restore(await run(selection.args), selection.swaps) as R;
  } catch (error) {
    // An absent Item's error names the id that was asked for.
    if (error instanceof Error) error.message = restore(error.message, selection.swaps) as string;
    const data = (error as { data?: unknown }).data;
    if (data !== undefined) (error as { data?: unknown }).data = restore(data, selection.swaps);
    throw error;
  }
}

/** Every public query tracks the canonical rows it read and applies the projection before return validation. */
export function withPublicWork<B>(builder: B): B {
  return ((definition: unknown) => {
    const handler =
      typeof definition === 'function'
        ? (definition as (ctx: QueryCtx, args: unknown) => unknown)
        : (definition as { handler: (ctx: QueryCtx, args: unknown) => unknown }).handler;
    const wrapped = async (ctx: QueryCtx, args: unknown) => {
      const tracked = publicWorkReadContext(ctx);
      const result = await publicWorkSelected(tracked.ctx, args, selected => handler(tracked.ctx, selected));
      return publicWorkResult(tracked.ctx, args, result, tracked.scope());
    };
    return (builder as (definition: unknown) => unknown)(
      typeof definition === 'function' ? wrapped : { ...(definition as object), handler: wrapped },
    );
  }) as B;
}
