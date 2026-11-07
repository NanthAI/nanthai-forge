// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { makeFunctionReference } from 'convex/server';
import { agentActor, splitAgentActor } from '../src/agent-slug';

/** Public identity rule: a person is shown as a Forge handle, never as an auth
 * subject (account id), provider display name or email. Every public function
 * passes its result through `publicPeople`: members with write access see the
 * handle; anyone else (public and invited readers, signed-out viewers) sees no
 * person at all. The mapping reads at most two index rows per distinct value
 * inside the call that is already running; actions, which cannot read the
 * database, make one internal query only when their result names a person. */
export const personKeys = new Set([
  'actor',
  'owner',
  'reader',
  'contributor',
  'member',
  'subject',
  'by',
  'recipient',
  'recipientActor',
  'to',
  'maintainer',
  'participant',
  'author',
  'person',
  'principal',
  'requester',
  'accountId',
  'creatorAccountId',
  'displayName',
  'autoActors',
  'assigneeAccountIds',
]);
/** Provider display names (first and last name) are never returned. */
export const nameKeys = new Set(['actorDisplayName']);
/** Email addresses are returned only to the project owner who entered them, or on account reads. */
export const emailKeys = new Set(['email', 'emails']);
const keyPattern = new RegExp(`\\\\?"(?:${[...personKeys, ...nameKeys, ...emailKeys].join('|')})\\\\?"\\s*:`);
/** Clerk account ids. Any other provider's subjects are recognised by their account row, which
 * every web sign-in and CLI device approval creates (urlAccounts.ensure). */
const subjectShape = /^user_[A-Za-z0-9]{8,}$/;
const handleShape = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])$/;
/** Account ids and handles never contain whitespace or ':'; such values are system actors. */
const systemActor = /[\s:]/;
const REMOVE = Symbol('remove');

type Lookup = (value: string) => Promise<{ handle?: string; person: boolean }>;
export type { Shape };
type Role = { writer: boolean; owner: boolean };
/** `viewer` always sees their own handle; `role` is read only when another person or an
 * email address is named, so self-describing reads add no project read. */
type View = { viewer: string | null; role: () => Promise<Role>; lookup: Lookup };
const emailPattern = /\\?"emails?\\?"\s*:/;
function once<T>(run: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => (pending ??= run());
}

export function mentionsPeople(value: unknown): boolean {
  if (typeof value === 'string') return keyPattern.test(value);
  if (!value || typeof value !== 'object') return false;
  // Shallow-cheap check: serialise only when an object is returned.
  return keyPattern.test(JSON.stringify(value));
}

/** A Convex validator in its exported JSON form; absent when the shape is unknown (parsed JSON). */
type Shape = { type: string; value?: unknown; values?: unknown } | undefined;
type Field = { fieldType: Shape; optional: boolean } | undefined;
function fieldOf(shape: Shape, key: string): Field {
  if (shape?.type === 'object') return (shape.value as Record<string, Field>)[key];
  if (shape?.type === 'record') return shape.values as Field;
  if (shape?.type === 'union')
    for (const branch of shape.value as Shape[]) {
      const field = fieldOf(branch, key);
      if (field) return field;
    }
  return undefined;
}
function elementOf(shape: Shape): Shape {
  if (shape?.type === 'array') return shape.value as Shape;
  if (shape?.type === 'union')
    for (const branch of shape.value as Shape[]) if (branch?.type === 'array') return branch.value as Shape;
  return undefined;
}
/** A required field keeps its type but names nobody: '' for a person, [] for a list. */
function blank(value: unknown): unknown {
  if (typeof value === 'string') return '';
  if (Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const inner = typeof record.id === 'string' ? 'id' : 'name';
  return { ...record, [inner]: '' };
}

async function mapNode(view: View, node: unknown, person: boolean, shape?: Shape): Promise<unknown> {
  if (typeof node === 'string') {
    if (person) {
      // An agent session (c29d0780) reads `ACCOUNT/slug`: the account follows the same rule and
      // the word-list slug is kept, so readers who may not see the person see neither.
      const agent = splitAgentActor(node);
      if (agent) {
        const mapped = await mapNode(view, agent.actor, true);
        return typeof mapped === 'string' && mapped ? `${mapped}/${agent.agent}` : mapped;
      }
      const found = await view.lookup(node);
      if (!found.person) return node;
      if (node === view.viewer) return found.handle ?? REMOVE;
      return (await view.role()).writer && found.handle ? found.handle : REMOVE;
    }
    if (node.length > 2 && (node[0] === '{' || node[0] === '[') && keyPattern.test(node)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(node);
      } catch {
        return node;
      }
      // Unchanged JSON keeps its exact bytes: a payload may be signed or digested as sent.
      const mapped = JSON.stringify(await mapNode(view, parsed, false));
      return mapped === JSON.stringify(parsed) ? node : mapped;
    }
    return node;
  }
  if (Array.isArray(node)) {
    const out: unknown[] = [];
    const element = elementOf(shape);
    for (const item of node) {
      const mapped = await mapNode(view, item, person, element);
      if (mapped !== REMOVE) out.push(mapped);
    }
    return out;
  }
  if (!node || typeof node !== 'object' || Object.getPrototypeOf(node) !== Object.prototype) return node;
  const record = node as Record<string, unknown>;
  if (person) {
    // Structured actors: { id | name, kind }. Agents acting for an account carry its id, so
    // every kind is looked up; an agent's own name is not an account and stays.
    const inner = typeof record.id === 'string' ? 'id' : typeof record.name === 'string' ? 'name' : null;
    if (inner) {
      const mapped = await mapNode(view, record[inner], true);
      return mapped === REMOVE ? REMOVE : { ...record, [inner]: mapped };
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const field = fieldOf(shape, key);
    const mapped =
      nameKeys.has(key) || (emailKeys.has(key) && !(await view.role()).owner)
        ? REMOVE
        : await mapNode(view, value, personKeys.has(key), field?.fieldType);
    if (mapped !== REMOVE) out[key] = mapped;
    else if (field && !field.optional) out[key] = blank(value);
  }
  return out;
}

function projectOf(args: unknown): Id<'hostedProjects'> | null {
  const id = (args as { projectId?: unknown } | null)?.projectId;
  return typeof id === 'string' ? (id as Id<'hostedProjects'>) : null;
}

async function viewerOf(ctx: QueryCtx | MutationCtx) {
  return (await ctx.auth.getUserIdentity())?.subject ?? null;
}
async function viewerRole(
  ctx: QueryCtx | MutationCtx,
  viewer: string | null,
  projectId: Id<'hostedProjects'> | null,
): Promise<Role> {
  if (!viewer) return { writer: false, owner: false };
  // Account reads return the viewer's own records and the people they chose to work with.
  if (!projectId) return { writer: true, owner: true };
  // A malformed or foreign id names no project the viewer may write: nobody is shown.
  const id = ctx.db.normalizeId('hostedProjects', projectId);
  const project = id ? await ctx.db.get(id) : null;
  if (!project) return { writer: false, owner: false };
  if (project.owner === viewer) return { writer: true, owner: true };
  const contributor = await ctx.db
    .query('projectContributors')
    .withIndex('by_project_and_contributor', q => q.eq('projectId', projectId).eq('contributor', viewer))
    .unique();
  return { writer: !!contributor, owner: false };
}

function databaseLookup(ctx: QueryCtx | MutationCtx, viewer: string | null): Lookup {
  const memo = new Map<string, Promise<{ handle?: string; person: boolean }>>();
  return value => {
    let pending = memo.get(value);
    if (!pending) {
      pending = (async () => {
        // System actors ('forge:expiry', 'landing controller') are never accounts: no read.
        if (!value || systemActor.test(value)) return { person: false };
        const account = await ctx.db
          .query('forgeAccounts')
          .withIndex('by_owner', q => q.eq('owner', value))
          .unique();
        if (account) return { handle: account.handle, person: true };
        // The viewer's own value is an account id, never an earlier handle.
        if (value !== viewer && handleShape.test(value)) {
          const alias = await ctx.db
            .query('accountHandles')
            .withIndex('by_handle', q => q.eq('handle', value))
            .unique();
          if (alias) {
            const current = await ctx.db
              .query('forgeAccounts')
              .withIndex('by_owner', q => q.eq('owner', alias.owner))
              .unique();
            return { ...(current ? { handle: current.handle } : {}), person: true };
          }
        }
        return { person: subjectShape.test(value) };
      })();
      memo.set(value, pending);
    }
    return pending;
  };
}

/** The public label of a stored actor (`ACCOUNT` or `ACCOUNT/slug`) for text a mutation stores or
 * builds: the Forge handle, '' when the account has none. System actors keep their text. One indexed
 * account read; the same lookup `publicPeople` makes for a person-keyed field. */
export async function publicActorLabel(
  ctx: QueryCtx | MutationCtx,
  actor: string,
  agent?: string | null,
): Promise<string> {
  const found = await databaseLookup(ctx, null)(actor);
  const label = found.person ? (found.handle ?? '') : actor;
  return label ? agentActor(label, agent) : '';
}

/** Map a query or mutation result to the public identity rule. */
export async function publicPeople(
  ctx: QueryCtx | MutationCtx,
  args: unknown,
  result: unknown,
  shape?: Shape,
) {
  if (!mentionsPeople(result)) return result;
  const viewer = await viewerOf(ctx);
  const view = {
    viewer,
    role: once(() => viewerRole(ctx, viewer, projectOf(args))),
    lookup: databaseLookup(ctx, viewer),
  };
  return mapNode(view, result, false, shape);
}

/** Person-valued arguments may name a person by handle; handlers keep receiving the account id. */
export async function subjectArgs(ctx: QueryCtx | MutationCtx, args: unknown): Promise<unknown> {
  if (!args || typeof args !== 'object') return args;
  const resolve = async (value: unknown, person: boolean): Promise<unknown> => {
    if (typeof value === 'string')
      return person && handleShape.test(value) ? ((await ownerOf(ctx, value)) ?? value) : value;
    if (Array.isArray(value)) return Promise.all(value.map(item => resolve(item, person)));
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
      return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      out[key] = await resolve(item, person || personArgKeys.has(key));
    return out;
  };
  return hasHandleArg(args) ? resolve(args, false) : args;
}
const personArgKeys = new Set([...personKeys, 'actors'].filter(key => key !== 'to' && key !== 'by'));
function hasHandleArg(value: unknown, person = false): boolean {
  if (typeof value === 'string') return person && handleShape.test(value);
  if (Array.isArray(value)) return value.some(item => hasHandleArg(item, person));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => hasHandleArg(item, person || personArgKeys.has(key)));
}
async function ownerOf(ctx: QueryCtx | MutationCtx, handle: string) {
  return (
    await ctx.db
      .query('accountHandles')
      .withIndex('by_handle', q => q.eq('handle', handle))
      .unique()
  )?.owner;
}

const resolved = v.object({
  writer: v.boolean(),
  owner: v.boolean(),
  values: v.array(
    v.object({
      value: v.string(),
      handle: v.optional(v.string()),
      person: v.boolean(),
      self: v.optional(v.boolean()),
    }),
  ),
});
/** Actions only: one batched lookup of the people their result names. */
export const resolve = internalQuery({
  args: {
    projectId: v.union(v.id('hostedProjects'), v.null()),
    values: v.array(v.string()),
    handles: v.array(v.string()),
    emails: v.optional(v.boolean()),
  },
  returns: v.object({
    view: resolved,
    subjects: v.array(v.object({ handle: v.string(), owner: v.string() })),
  }),
  handler: async (ctx, { projectId, values, handles, emails }) => {
    const viewer = await viewerOf(ctx);
    const lookup = databaseLookup(ctx, viewer);
    const subjects = [];
    for (const handle of new Set(handles)) {
      const owner = await ownerOf(ctx, handle);
      if (owner) subjects.push({ handle, owner });
    }
    const rows = await Promise.all(
      [...new Set(values)].map(async value => ({
        value,
        ...(await lookup(value)),
        ...(value === viewer ? { self: true } : {}),
      })),
    );
    // The role is read only when another person or an email address is named.
    const role =
      emails || rows.some(row => row.person && !row.self)
        ? await viewerRole(ctx, viewer, projectId)
        : { writer: false, owner: false };
    return { view: { ...role, values: rows }, subjects };
  },
});
const resolveRef = makeFunctionReference<
  'query',
  { projectId: Id<'hostedProjects'> | null; values: string[]; handles: string[]; emails?: boolean },
  {
    view: {
      writer: boolean;
      owner: boolean;
      values: { value: string; handle?: string; person: boolean; self?: boolean }[];
    };
    subjects: { handle: string; owner: string }[];
  }
>('publicPeople:resolve');

function personStrings(node: unknown, person: boolean, into: Set<string>, keys: Set<string>) {
  if (typeof node === 'string') {
    if (person) into.add(splitAgentActor(node)?.actor ?? node);
    else if (node.length > 2 && (node[0] === '{' || node[0] === '[') && keyPattern.test(node))
      try {
        personStrings(JSON.parse(node), false, into, keys);
      } catch {
        /* Not JSON: an ordinary string. */
      }
    return;
  }
  if (Array.isArray(node)) return node.forEach(item => personStrings(item, person, into, keys));
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) personStrings(value, person || keys.has(key), into, keys);
}

/** Actions: map handle arguments to account ids before the handler runs. */
export async function actionSubjectArgs(ctx: ActionCtx, args: unknown) {
  if (!args || typeof args !== 'object' || !hasHandleArg(args)) return args;
  const handles = new Set<string>();
  personStrings(args, false, handles, personArgKeys);
  const wanted = [...handles].filter(value => handleShape.test(value));
  const { subjects } = await ctx.runQuery(resolveRef, { projectId: null, values: [], handles: wanted });
  const owners = new Map(subjects.map(row => [row.handle, row.owner]));
  const swap = (value: unknown, person: boolean): unknown => {
    if (typeof value === 'string') return person ? (owners.get(value) ?? value) : value;
    if (Array.isArray(value)) return value.map(item => swap(item, person));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, swap(item, person || personArgKeys.has(key))]),
    );
  };
  return swap(args, false);
}

/** Actions: the same mapping as `publicPeople`, resolved by one internal query. */
export async function actionPublicPeople(ctx: ActionCtx, args: unknown, result: unknown, shape?: Shape) {
  if (!mentionsPeople(result)) return result;
  const values = new Set<string>();
  personStrings(result, false, values, personKeys);
  const { view } = await ctx.runQuery(resolveRef, {
    projectId: projectOf(args),
    values: [...values],
    handles: [],
    emails: emailPattern.test(typeof result === 'string' ? result : JSON.stringify(result)),
  });
  const found = new Map(view.values.map(row => [row.value, row]));
  const role = { writer: view.writer, owner: view.owner };
  return mapNode(
    {
      viewer: view.values.find(row => row.self)?.value ?? null,
      role: async () => role,
      lookup: async value => found.get(value) ?? { person: false },
    },
    result,
    false,
    shape,
  );
}

/** Actions: a handle label for each id in one internal query. Ids that are not
 * accounts (agent principals) label themselves; an account without a handle is ''. */
export async function handleLabels(
  ctx: ActionCtx,
  ids: string[],
  projectId: Id<'hostedProjects'> | null = null,
): Promise<Map<string, string>> {
  const { view } = await ctx.runQuery(resolveRef, { projectId, values: [...new Set(ids)], handles: [] });
  return new Map(
    view.values.map(row => [
      row.value,
      row.person ? (row.self || view.writer ? (row.handle ?? '') : '') : row.value,
    ]),
  );
}
