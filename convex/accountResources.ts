// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { report } from './errors';
import { v, getDocumentSize } from 'convex/values';
import { paginationOptsValidator, type GenericDocument } from 'convex/server';
import { internalQuery, type QueryCtx, type MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { resourceKind, sharedKind } from './accountTypes';
import { stream, type QueryStream } from 'convex-helpers/server/stream';
import schema from './schema';
import { invariant } from '../src/errors';
import { digest } from '../src/state/hash';
import { isDeviceIdentity } from './cliServer';
import { metadataBytes } from './accountMetadata';

export type ResourceKind = 'project' | 'import' | 'secret' | 'agent' | 'team' | 'view' | 'interest';
export type LeaveKind = 'readers' | 'zones' | 'teams' | 'projects' | 'projectReaders' | 'secrets';
export async function accountActor(ctx: QueryCtx | MutationCtx) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'ACCOUNT_UNAVAILABLE', 'Sign in to manage your Forge data.');
  // Person-only (review 8e86eb09): every inventory, export, cleanup and receipt read or write of Your data runs as the
  // person in their browser. Device, agent and legacy CLI credentials are refused here, before any account row is
  // read, whatever their project or source scope; the public wrappers refuse them too (accountAction('person')).
  invariant(
    !isDeviceIdentity(user) && !(ctx as { forgeDevice?: unknown }).forgeDevice,
    'AUTH_SCOPE_DENIED',
    'Manage your Forge data in your Forge browser: Account → Your data.',
  );
  return user.subject;
}
const OWNED_TABLE = {
  project: 'hostedProjects',
  import: 'imports',
  secret: 'secretObjects',
  agent: 'agentGrants',
  team: 'teams',
  view: 'savedViews',
  interest: 'projectInterests',
} as const;
type OwnedRow = Record<string, unknown> & { _id: string; owner?: string };
// Selected public metadata only. Immutable source, encrypted versions and bearer material stay with their resource owners.
/** The metadata of one row the actor owns, from the row itself (no further read); null when it is not theirs. */
export function ownedProjection(kind: ResourceKind, row: OwnedRow | null, actor: string) {
  // oxlint-disable-next-line typescript/no-explicit-any -- one projection per table, fields read by name
  const r = row as any;
  if (!r || r.owner !== actor) return null;
  if (kind === 'project')
    return {
      id: r._id,
      name: r.name,
      key: r.key,
      revision: r.revision,
      currentBackup: r.currentBackup,
      removal: r.removal ?? null,
    };
  if (kind === 'import')
    return r.visibility === 'private'
      ? {
          id: r._id,
          repository: r.repository,
          ref: r.ref,
          phase: r.phase,
          generation: r.generation,
          removal: r.removal ?? null,
        }
      : null;
  if (kind === 'secret')
    return !r.deleting
      ? {
          id: r._id,
          name: r.name,
          repository: r.repository,
          ref: r.ref,
          version: r.version,
          policyRevision: r.policyRevision,
          archiveRevision: r.archiveRevision ?? 0,
          archived: !!r.archived,
          disabled: r.disabled,
        }
      : null;
  if (kind === 'agent')
    return {
      id: r._id,
      name: r.name,
      importId: r.importId,
      sourceId: r.sourceId,
      gitHead: r.gitHead,
      files: r.files,
      tools: r.tools,
      expiresAt: r.expiresAt,
      revoked: r.revoked,
    };
  if (kind === 'team')
    return !r.removal
      ? { id: r._id, name: r.name, creation: r._creationTime, removal: r.removal ?? null }
      : null;
  if (kind === 'view') return { id: r._id, name: r.name, importId: r.importId, route: r.route };
  return {
    id: r._id,
    importId: r.importId,
    repository: r.repository,
    ref: r.ref,
    starred: r.starred,
    watching: r.watching,
    seenHead: r.seenHead,
    active: r.active,
    revision: r.revision,
  };
}
/** `read` sees each document read, for callers that cap their bytes. */
export type Reads = (doc: GenericDocument | null) => void;
export async function ownedMetadata(
  ctx: QueryCtx | MutationCtx,
  kind: ResourceKind,
  id: string,
  actor: string,
  read?: Reads,
) {
  const table = OWNED_TABLE[kind];
  if (!ctx.db.normalizeId(table, id)) return null;
  const doc = await ctx.db.get(id as Id<typeof table>);
  read?.(doc);
  return ownedProjection(kind, doc as OwnedRow | null, actor);
}
/** A mark of one owned resource as it is now (a digest of its row, or "gone"): a cleanup step returns it for each
 * removal still running, and accountData.watch returns the same marks, so the page advances exactly when one differs. */
export async function resourceMark(
  ctx: QueryCtx | MutationCtx,
  kind: ResourceKind,
  id: string,
  read?: (doc: GenericDocument | null) => void,
) {
  const table = OWNED_TABLE[kind];
  const doc = ctx.db.normalizeId(table, id) ? await ctx.db.get(id as Id<typeof table>) : null;
  read?.(doc);
  return doc ? digest(metadataBytes(doc)) : 'gone';
}
/** Byte caps (review ae15c5ca). Names have no length limit, so a row can be as large as a document (1 MiB): a row
 * count alone does not bound a read. Every page below stops at its row count or once it has read its byte cap,
 * whichever comes first, so a read is at most the cap plus one document; labels are clipped to LABEL_MAX characters, so
 * a reply is at most its row count of short rows. Pages use index-key cursors (convex-helpers stream), which are not
 * Convex paginated queries, so one query may read several kinds. */
export const PAGE_BYTES = 256 * 1024;
export const LABEL_MAX = 120;
/** A label as shown: at most LABEL_MAX characters, never a split character. */
export function clip(text: string) {
  if (text.length <= LABEL_MAX) return text;
  const cut = text.slice(0, LABEL_MAX - 1);
  return (/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut) + '…';
}
type Bounds = { cursor: string | null; numItems: number; maximumBytesRead: number };
/** Public cursors leave out the person's own auth subject, which every account index starts with (review s1-astra62
 * #6): the reply drops the cursor's first key, and the next request gets it back from the signed-in person. */
export function publicCursor(cursor: string) {
  const key = JSON.parse(cursor) as unknown[];
  return JSON.stringify(key.slice(1));
}
export function serverCursor(cursor: string | null, actor: string) {
  if (cursor === null) return null;
  let key: unknown;
  try {
    key = JSON.parse(cursor);
  } catch {
    key = null;
  }
  invariant(Array.isArray(key), 'BAD_ARGUMENT', 'Use a cursor this page returned.');
  if (!key.length) return cursor;
  // The stream cursor escapes a string ending in "undefined" with a leading "_"; the subject is written the same way.
  return JSON.stringify([actor.endsWith('undefined') ? '_' + actor : actor, ...key]);
}
/** One page of the actor's rows of a kind, by the kind's owner index, within `bounds`. */
export function ownedPage(ctx: QueryCtx | MutationCtx, kind: ResourceKind, actor: string, bounds: Bounds) {
  const s = stream(ctx.db, schema);
  const page =
    kind === 'project'
      ? s.query('hostedProjects').withIndex('by_owner_and_removal', q => q.eq('owner', actor))
      : kind === 'import'
        ? s
            .query('imports')
            .withIndex('by_owner_and_visibility', q => q.eq('owner', actor).eq('visibility', 'private'))
        : kind === 'secret'
          ? s.query('secretObjects').withIndex('by_owner_and_operationId', q => q.eq('owner', actor))
          : kind === 'agent'
            ? s.query('agentGrants').withIndex('by_owner', q => q.eq('owner', actor))
            : kind === 'team'
              ? s.query('teams').withIndex('by_owner_and_operationId', q => q.eq('owner', actor))
              : kind === 'view'
                ? s.query('savedViews').withIndex('by_owner', q => q.eq('owner', actor))
                : s.query('projectInterests').withIndex('by_owner_and_importId', q => q.eq('owner', actor));
  return (page as QueryStream<OwnedRow>).paginate(bounds);
}
/** The export reads full metadata, so its pages are byte-capped too (at most the cap plus one document). */
export const EXPORT_BYTES = 512 * 1024;
export const page = internalQuery({
  args: { kind: resourceKind, paginationOpts: paginationOptsValidator },
  returns: v.any(),
  handler: async (ctx, { kind, paginationOpts }) => {
    try {
      const actor = await accountActor(ctx);
      const result = await ownedPage(ctx, kind, actor, {
        cursor: serverCursor(paginationOpts.cursor, actor),
        numItems: Math.max(1, Math.min(100, paginationOpts.numItems)),
        maximumBytesRead: EXPORT_BYTES,
      });
      const page = result.page.flatMap(r => {
        const metadata = ownedProjection(kind, r, actor);
        return metadata ? [metadata] : [];
      });
      return { page, isDone: result.isDone, continueCursor: publicCursor(result.continueCursor) };
    } catch (e) {
      return report(e);
    }
  },
});
export type SharedKind = Exclude<LeaveKind, 'secrets'>;
/** The kinds a review lists, in the order its token is built. */
export const SHARED: readonly SharedKind[] = ['projects', 'projectReaders', 'readers', 'teams', 'zones'];
export const SHARED_PAGE = 100;
type Grant = GenericDocument & { _id: string; _creationTime: number };
type Parent = GenericDocument | null;
/** One page of grants with each grant's parent (one get each), stopping at `rows` or once grants and parents together
 * have read `bytes`. When parents fill the cap before the page ends, the page is cut after the last grant read: the
 * cut re-reads that many grants (index entries only up to there), so a call reads at most about twice the cap plus one
 * parent. */
export async function grantsWithParents<T extends Grant>(
  source: () => QueryStream<T>,
  cursor: string | null,
  parentOf: (row: T) => Promise<Parent>,
  rows = SHARED_PAGE,
  bytes = PAGE_BYTES,
) {
  const first = await source().paginate({ cursor, numItems: rows, maximumBytesRead: bytes });
  let read = first.page.reduce((n, r) => n + getDocumentSize(r), 0);
  const out: { row: T; parent: Parent }[] = [];
  for (const row of first.page) {
    if (out.length && read >= bytes) {
      const cut = await source().paginate({ cursor, numItems: out.length });
      return { rows: out, isDone: false, continueCursor: cut.continueCursor };
    }
    const parent = await parentOf(row);
    if (parent) read += getDocumentSize(parent);
    out.push({ row, parent });
  }
  return { rows: out, isDone: first.isDone, continueCursor: first.continueCursor };
}
function sharedSource(ctx: QueryCtx | MutationCtx, kind: SharedKind, actor: string) {
  const s = stream(ctx.db, schema);
  return (kind === 'readers'
    ? s.query('importReaders').withIndex('by_reader_and_importId', q => q.eq('reader', actor))
    : kind === 'zones'
      ? s.query('zoneReaders').withIndex('by_reader_and_zoneId', q => q.eq('reader', actor))
      : kind === 'teams'
        ? s.query('teamMembers').withIndex('by_member_and_teamId', q => q.eq('member', actor))
        : kind === 'projectReaders'
          ? s.query('projectReaders').withIndex('by_reader', q => q.eq('reader', actor))
          : s
              .query('projectContributors')
              .withIndex('by_contributor', q => q.eq('contributor', actor))) as unknown as QueryStream<Grant>;
}
const PARENT = {
  readers: 'importId',
  zones: 'zoneId',
  teams: 'teamId',
  projects: 'projectId',
  projectReaders: 'projectId',
} as const;
/** What a shared grant gives the person, as a review binds it and a cleanup re-checks it: the whole grant row (ids and
 * any access it carries, such as being a project's guidance maintainer), without a contributor's usage counters, which
 * change with ordinary work and give no access. */
export function grantAccess(kind: LeaveKind, row: GenericDocument): GenericDocument {
  if (kind !== 'projects') return row;
  const access: GenericDocument = { ...row, agentGuidanceMaintainer: row.agentGuidanceMaintainer === true };
  delete access.workBudget;
  return access;
}
/** Labels for what was shared: the parent's own name where it has one; never a location, never a person. */
function sharedLabel(kind: SharedKind, parent: Parent) {
  const name = typeof parent?.name === 'string' && !/[\\/]/.test(parent.name) ? clip(parent.name) : '';
  if (kind === 'teams') return name || 'A team';
  if (kind === 'projects' || kind === 'projectReaders') return name || 'A project';
  if (kind === 'zones') return name || 'A shared source zone';
  return 'A repository shared with you';
}
/** One page of what others shared with the actor that the actor can see, excluding their own resources: the grant
 * rows, and the rows as the review shows them. */
export async function incomingPage(
  ctx: QueryCtx | MutationCtx,
  kind: SharedKind,
  actor: string,
  cursor: string | null,
) {
  invariant(SHARED.includes(kind), 'BAD_ARGUMENT', 'Choose what shared with you to review.');
  const p = await grantsWithParents(
    () => sharedSource(ctx, kind, actor),
    cursor,
    async row => ctx.db.get(row[PARENT[kind]] as Id<'imports'>) as Promise<Parent>,
  );
  const kept = p.rows.filter(({ parent }) => parent?.owner !== actor),
    grants = kept.map(x => grantAccess(kind, x.row)),
    shown = kept.map(({ row, parent }) => ({ id: row._id, label: sharedLabel(kind, parent) }));
  return {
    grants,
    shown,
    // What the token binds: each row as shown, plus the access it gives as read (an in-place access change, such as a
    // maintainer flag, keeps the id and label but changes this).
    bound: shown.map((row, i) => ({ ...row, access: digest(metadataBytes(grants[i])) })),
    isDone: p.isDone,
    continueCursor: p.continueCursor,
  };
}
/** The chain a review and its cleanup both compute: one link per page, in SHARED order, over exactly the rows the
 * review shows (ids and labels). It is built from nothing the person cannot see, so it cannot tell anyone anything
 * hidden, whatever prefix a caller chooses; secret grants are never part of it. A token is `<epoch>:<digest>`: `epoch`
 * is the review epoch the server issued when the review started (accountData.review), carried through the chain
 * unchanged. The cleanup accepts it only while it is the person's latest (accountPlan.register) and leaves only the
 * secret grants given before it (accountExecute.leaveSecrets). */
export function incomingStart(epoch: number) {
  return `${epoch}:${digest(`forge-incoming\n${epoch}`)}`;
}
/** The review epoch a token carries, or null when it carries none. */
export function reviewEpoch(token: string) {
  const at = Number(token.slice(0, token.indexOf(':')));
  return token.includes(':') && Number.isSafeInteger(at) && at > 0 ? at : null;
}
export function incomingLink(
  token: string,
  kind: SharedKind,
  shown: { id: string; label: string; access: string }[],
) {
  const at = token.includes(':') ? token.slice(0, token.indexOf(':')) : '';
  return `${at}:${digest(`${token}\n${kind}\n${metadataBytes(shown)}`)}`;
}
/** One page of what is shared and the chain after it. Internal: cleanup re-reads exactly what the review read. */
export const incoming = internalQuery({
  args: { kind: sharedKind, cursor: v.union(v.string(), v.null()), token: v.string() },
  returns: v.any(),
  handler: async (ctx, { kind, cursor, token }) => {
    try {
      const actor = await accountActor(ctx);
      const p = await incomingPage(ctx, kind, actor, cursor);
      return {
        page: p.grants,
        token: incomingLink(token, kind, p.bound),
        isDone: p.isDone,
        continueCursor: p.continueCursor,
      };
    } catch (e) {
      return report(e);
    }
  },
});

export async function incomingCurrent(
  ctx: QueryCtx | MutationCtx,
  kind: LeaveKind,
  id: string,
  actor: string,
  read?: Reads,
) {
  const table = {
    readers: 'importReaders',
    zones: 'zoneReaders',
    teams: 'teamMembers',
    projects: 'projectContributors',
    projectReaders: 'projectReaders',
    secrets: 'secretGrants',
  } as const;
  if (!ctx.db.normalizeId(table[kind], id)) return null;
  const get = async <T extends GenericDocument>(doc: Promise<T | null>) => {
    const value = await doc;
    read?.(value);
    return value;
  };
  if (kind === 'readers') {
    const r = await get(ctx.db.get(id as Id<'importReaders'>));
    return r?.reader === actor && (await get(ctx.db.get(r.importId)))?.owner !== actor ? r : null;
  }
  if (kind === 'zones') {
    const r = await get(ctx.db.get(id as Id<'zoneReaders'>));
    return r?.reader === actor && (await get(ctx.db.get(r.zoneId)))?.owner !== actor ? r : null;
  }
  if (kind === 'teams') {
    const r = await get(ctx.db.get(id as Id<'teamMembers'>));
    return r?.member === actor && (await get(ctx.db.get(r.teamId)))?.owner !== actor ? r : null;
  }
  if (kind === 'projects') {
    const r = await get(ctx.db.get(id as Id<'projectContributors'>));
    return r?.contributor === actor && (await get(ctx.db.get(r.projectId)))?.owner !== actor
      ? grantAccess(kind, r)
      : null;
  }
  if (kind === 'projectReaders') {
    const r = await get(ctx.db.get(id as Id<'projectReaders'>));
    return r?.reader === actor && (await get(ctx.db.get(r.projectId)))?.owner !== actor ? r : null;
  }
  const r = await get(ctx.db.get(id as Id<'secretGrants'>));
  return r?.principal === actor && (await get(ctx.db.get(r.secretId)))?.owner !== actor ? r : null;
}
