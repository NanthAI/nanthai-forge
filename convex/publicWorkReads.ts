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

type ObjectValue = Record<string, unknown>;
const REMOVE = Symbol('hidden');
const planning = (collection: string) =>
  collection.startsWith('planning') || ['issues', 'comments'].includes(collection);
const lanes = (collection: string) => ['lanes', 'intents', 'notes', 'lifecycle'].includes(collection);
const parse = (value: unknown): unknown => {
  if (typeof value !== 'string' || !/^[\[{]/.test(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};

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
  const command = { ...input, ...object(parse(input.request)) };
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
  const laneTitles = (await publicRow(ctx, project._id))?.laneTitles === true;
  const plan = publicWorkPlan(ctx, project, scope.roots ?? new Map());
  const allowed = plan.allowed;
  const roots = plan.visibleLoaded;
  // A selection of a hidden Item has exactly the same empty result as an absent Item.
  const selected =
    command.itemId ??
    (planning(collection)
      ? (command.parentId ??
        (collection === 'comments' || collection === 'planningComments' ? undefined : command.id))
      : undefined);
  const selectedHidden = selected !== undefined && !(await allowed(selected));
  const visit = async (node: unknown, hint = collection, key = ''): Promise<unknown> => {
    // A member's prose or source content is literal, even if it happens to be valid JSON.
    const parsed = ['', 'value', 'rows', 'command', 'approvals'].includes(key) ? parse(node) : node;
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
    const lane = scope.lanes && (lanes(ownHint) || typeof row.laneId === 'string');
    const out: ObjectValue = {};
    for (const [name, entry] of Object.entries(row)) {
      if (
        lane &&
        !laneTitles &&
        ['title', 'name', 'goal', 'outcome', 'description', 'note', 'reason'].includes(name)
      ) {
        out[name] = entry === null ? null : '';
        continue;
      }
      if (
        selectedHidden &&
        ['page', 'items', 'comments', 'counts', 'ids', 'rows', 'versions'].includes(name)
      ) {
        out[name] =
          typeof entry === 'string'
            ? '[]'
            : entry && typeof entry === 'object' && !Array.isArray(entry)
              ? {}
              : [];
        continue;
      }
      if (selectedHidden && ['value', 'record', 'item'].includes(name)) {
        out[name] = null;
        continue;
      }
      if (name === 'ids' && Array.isArray(entry)) {
        out[name] = [];
        for (const id of entry) if (await allowed(id)) (out[name] as unknown[]).push(id);
        continue;
      }
      const nestedHint = lane || ['lane', 'lanes', 'intent', 'intents'].includes(name) ? 'lanes' : ownHint;
      const mapped = await visit(entry, nestedHint, name);
      out[name] = mapped === REMOVE ? null : mapped;
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
      for (const row of Array.isArray(out.page) ? out.page : []) {
        const item = object(parse(object(row).value));
        if (typeof item.status === 'string') counts[item.status] = (counts[item.status] ?? 0) + 1;
      }
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

/** Every public query tracks the canonical rows it read and applies the projection before return validation. */
export function withPublicWork<B>(builder: B): B {
  return ((definition: unknown) => {
    const handler =
      typeof definition === 'function'
        ? (definition as (ctx: QueryCtx, args: unknown) => unknown)
        : (definition as { handler: (ctx: QueryCtx, args: unknown) => unknown }).handler;
    const wrapped = async (ctx: QueryCtx, args: unknown) => {
      const tracked = publicWorkReadContext(ctx);
      const result = await handler(tracked.ctx, args);
      return publicWorkResult(tracked.ctx, args, result, tracked.scope());
    };
    return (builder as (definition: unknown) => unknown)(
      typeof definition === 'function' ? wrapped : { ...(definition as object), handler: wrapped },
    );
  }) as B;
}
