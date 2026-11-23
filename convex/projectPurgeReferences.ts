// SPDX-License-Identifier: Apache-2.0
import { getDocumentSize, v, type Infer } from 'convex/values';
import type { PaginationOptions, PaginationResult } from 'convex/server';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './server';
import { r2ReferencePosition, r2Sections } from './projectPurgeReferenceFields';
import { projectPrefix } from './r2Operations';
import { invariant } from '../src/errors';

type ProjectId = Id<'hostedProjects'>;
type StorageId = Id<'_storage'>;
type PageQuery<Row> = { paginate: (options: PaginationOptions) => Promise<PaginationResult<Row>> };
type StorageRow = { storageId?: StorageId; archiveReceipt?: { storageId?: StorageId } };
type KeyRow = { r2Key?: string; archiveReceipt?: { r2Key?: string } };
type AliasRow = { projectId: ProjectId };
type AliasQuery = PageQuery<AliasRow> & { take: (count: number) => Promise<AliasRow[]> };
type KeyedRow = { projectId: ProjectId } & KeyRow;

const candidates = {
  objects: (ctx, projectId) =>
    ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_storage_and_removed', q =>
        q.eq('projectId', projectId).gt('storageId', undefined),
      ),
  backups: (ctx, projectId) =>
    ctx.db.query('projectBackups').withIndex('by_project', q => q.eq('projectId', projectId)),
  proposals: (ctx, projectId) =>
    ctx.db.query('projectProposals').withIndex('by_project_and_operation', q => q.eq('projectId', projectId)),
} satisfies Record<string, (ctx: QueryCtx, projectId: ProjectId) => PageQuery<StorageRow>>;

// Existing cleanup indexes, including the oldest archive receipt alias path.
const aliases = {
  objects: (ctx, id) => ctx.db.query('projectObjects').withIndex('by_storage', q => q.eq('storageId', id)),
  backups: (ctx, id) => ctx.db.query('projectBackups').withIndex('by_storage', q => q.eq('storageId', id)),
  archives: (ctx, id) =>
    ctx.db.query('projectBackups').withIndex('by_archive_storage', q => q.eq('archiveReceipt.storageId', id)),
  proposals: (ctx, id) =>
    ctx.db.query('projectProposals').withIndex('by_storage', q => q.eq('storageId', id)),
} satisfies Record<string, (ctx: QueryCtx, id: StorageId) => AliasQuery>;
type Alias = keyof typeof aliases;
const aliasKinds = Object.keys(aliases) as Alias[];
const aliasTable = {
  objects: 'projectObjects',
  backups: 'projectBackups',
  archives: 'projectBackups',
  proposals: 'projectProposals',
};

// Every stored key under the selected project's prefix, from any project, on an index of the stored
// key itself (Item 411727ba): Convex maintains it, so no writer can miss a row. The page reads the
// selected project's own key-bearing rows plus real matches, never every other project's rows.
// Prefixes are ASCII and end in '/', so the range [prefix, prefix with '/' -> '0') is startsWith.
type KeyField = 'r2Key' | 'archiveReceipt.r2Key';
const keyRows = {
  objectKeys: ['projectObjects', 'r2Key'],
  backupKeys: ['projectBackups', 'r2Key'],
  archiveKeys: ['projectBackups', 'archiveReceipt.r2Key'],
  proposalKeys: ['projectProposals', 'r2Key'],
  uploadKeys: ['projectUploadCleanup', 'r2Key'],
} as const satisfies Record<Exclude<(typeof r2Sections)[number], 'artifactKeys'>, [string, KeyField]>;
function keyRange(ctx: Pick<QueryCtx, 'db'>, section: keyof typeof keyRows, prefix: string) {
  const end = prefix.slice(0, -1) + '0';
  const db = ctx.db;
  const ranges = {
    objectKeys: () =>
      db.query('projectObjects').withIndex('by_r2Key', q => q.gte('r2Key', prefix).lt('r2Key', end)),
    backupKeys: () =>
      db.query('projectBackups').withIndex('by_r2Key', q => q.gte('r2Key', prefix).lt('r2Key', end)),
    archiveKeys: () =>
      db
        .query('projectBackups')
        .withIndex('by_archive_r2Key', q =>
          q.gte('archiveReceipt.r2Key', prefix).lt('archiveReceipt.r2Key', end),
        ),
    proposalKeys: () =>
      db.query('projectProposals').withIndex('by_r2Key', q => q.gte('r2Key', prefix).lt('r2Key', end)),
    uploadKeys: () =>
      db.query('projectUploadCleanup').withIndex('by_r2Key', q => q.gte('r2Key', prefix).lt('r2Key', end)),
  } satisfies Record<keyof typeof keyRows, () => PageQuery<KeyedRow>>;
  return ranges[section]() as PageQuery<KeyedRow>;
}

type Section = keyof typeof candidates | (typeof r2Sections)[number];
const sections = [...Object.keys(candidates), ...r2Sections] as Section[];
const cursor = v.union(v.string(), v.null());
const scan = v.object({
  section: v.union(...sections.map(section => v.literal(section))),
  cursor,
  side: r2ReferencePosition.fields.side,
  single: r2ReferencePosition.fields.single,
});
const alias = v.object({
  id: v.string(),
  kind: v.union(...aliasKinds.map(kind => v.literal(kind))),
  cursor,
});
const checks = v.object({
  section: v.literal('fileChecks'),
  remaining: v.array(v.string()),
  aliases: v.array(alias),
  resume: v.union(scan, v.null()),
});
const continuation = v.union(scan, checks);
const reference = v.object({ key: v.string(), table: v.string() });
type Reference = Infer<typeof reference>;
type AliasPosition = Infer<typeof alias>;
type FileChecks = Infer<typeof checks>;
type Position = Infer<typeof continuation>;
export const referenceArgs = { projectId: v.id('hostedProjects'), next: v.optional(continuation) };
export const referenceResult = v.object({
  section: v.union(scan.fields.section, checks.fields.section),
  next: v.union(continuation, v.null()),
  references: v.array(reference),
  documentBytes: v.number(),
  documentsRead: v.number(),
  databaseQueries: v.number(),
});

function readPage<Row>(selection: PageQuery<Row>, cursor: string | null, numItems: number) {
  return selection.paginate({ cursor, numItems, maximumRowsRead: numItems, maximumBytesRead: 512 * 1024 });
}

async function importReference(ctx: Pick<QueryCtx, 'db'>, key: string) {
  const jobs = await ctx.db
    .query('imports')
    .withIndex('by_artifactKey', q => q.eq('artifactKey', key))
    .take(1);
  if (jobs.length) return 'imports';
  const artifacts = await ctx.db
    .query('importArtifacts')
    .withIndex('by_artifactKey', q => q.eq('artifactKey', key))
    .take(1);
  if (artifacts.length) return 'importArtifacts';
}

function nextChecks(state: FileChecks): Position | null {
  return state.remaining.length || state.aliases.length ? state : state.resume;
}

/** Continuations carry index keys as strings. Normalize only for the metadata lookup. */
function fileKey(ctx: QueryCtx, raw: string) {
  const id = ctx.db.system.normalizeId('_storage', raw);
  invariant(id, 'BAD_ARGUMENT', 'Use the returned reference cursor.');
  return id;
}

async function checkFiles(ctx: QueryCtx, projectId: ProjectId, state: FileChecks, references: Reference[]) {
  const pending = state.aliases[0];
  if (pending) {
    const id = fileKey(ctx, pending.id);
    const page = await readPage<AliasRow>(aliases[pending.kind](ctx, id), pending.cursor, 100);
    if (page.page.some(row => row.projectId !== projectId)) {
      references.push({ key: pending.id, table: aliasTable[pending.kind] });
      state.aliases = state.aliases.filter(entry => entry.id !== pending.id);
    } else if (page.isDone) state.aliases.shift();
    else pending.cursor = page.continueCursor;
    return nextChecks(state);
  }

  let bytes = (await ctx.meta.getTransactionMetrics()).bytesRead.used;
  const limit = 4 * 1024 * 1024;
  const remaining = state.remaining;
  // Each id can read two documents on four indexes and one import witness.
  // Start below 4 MiB to leave room for nine maximum-size documents.
  while (remaining.length && bytes < limit) {
    const id = fileKey(ctx, remaining.shift()!);
    let table: string | undefined;
    const saturated: AliasPosition[] = [];
    for (const kind of aliasKinds) {
      const rows = await aliases[kind](ctx, id).take(2);
      for (const row of rows) bytes += getDocumentSize(row);
      if (rows.some(row => row.projectId !== projectId)) {
        table = aliasTable[kind];
        break;
      }
      if (rows.length === 2) saturated.push({ id, kind, cursor: null });
    }
    if (!table) {
      table = await importReference(ctx, id);
      // One import witness may have been read. Reserve a full document.
      if (table) bytes += 1024 * 1024;
    }
    if (table) references.push({ key: id, table });
    else state.aliases.push(...saturated);
  }
  return nextChecks(state);
}

const isStorage = (section: Section): section is keyof typeof candidates =>
  Object.hasOwn(candidates, section);

async function scanSection(
  ctx: QueryCtx,
  projectId: ProjectId,
  { section, cursor, side, single }: Infer<typeof scan>,
  references: Reference[],
): Promise<Position | null> {
  const following = sections[sections.indexOf(section) + 1];
  const resume = following ? { section: following, cursor: null } : null;
  if (isStorage(section)) {
    const page = await readPage<StorageRow>(candidates[section](ctx, projectId), cursor, 4);
    const keys = new Set(
      page.page.flatMap(row => [row.storageId, row.archiveReceipt?.storageId]).filter(id => id !== undefined),
    );
    return checkFiles(
      ctx,
      projectId,
      {
        section: 'fileChecks',
        remaining: [...keys],
        aliases: [],
        resume: page.isDone ? resume : { section, cursor: page.continueCursor },
      },
      references,
    );
  }

  return (
    await scanR2References(
      ctx,
      projectId,
      { section, cursor, ...(side ? { side } : {}), ...(single ? { single } : {}) },
      references,
    )
  ).next;
}

/** Returns the next unchecked R2 range. A split-required page can prove presence
 * but cannot prove absence, so retry its original range one document at a time.
 * A position saved by the earlier per-side foreign scan carries `side`; its cursor
 * belongs to another index, so it proves nothing and the scan restarts. */
export async function scanR2References(
  ctx: Pick<QueryCtx, 'db'>,
  projectId: ProjectId,
  saved: Infer<typeof r2ReferencePosition> = { section: 'objectKeys', cursor: null },
  references: Reference[] = [],
) {
  const position: Infer<typeof r2ReferencePosition> =
    saved.side === undefined ? saved : { section: 'objectKeys', cursor: null };
  const { section, cursor, single } = position;
  const following = r2Sections[r2Sections.indexOf(section) + 1];
  const resume = following ? { section: following, cursor: null } : null;
  const prefix = projectPrefix(projectId);
  const read = <Row>(selection: PageQuery<Row>, size: number) =>
    single ? selection.paginate({ cursor, numItems: 1 }) : readPage(selection, cursor, size);
  const advance = <Row>(page: PaginationResult<Row>, end: Infer<typeof r2ReferencePosition> | null) => {
    if (page.pageStatus === 'SplitRequired') {
      invariant(!single, 'WORK_STALE', 'The R2 reference range could not be read completely.');
      return { ...position, single: true as const };
    }
    invariant(
      page.isDone || page.continueCursor !== cursor,
      'WORK_STALE',
      'The R2 reference range did not advance.',
    );
    return page.isDone ? end : { section, cursor: page.continueCursor };
  };

  if (section === 'artifactKeys') {
    // Artifact keys derive from the namespace. The import aliases use its id.
    const page = await read(
      ctx.db
        .query('artifactBlobs')
        .withIndex('by_namespace_and_digest', q =>
          q.gte('namespace', prefix).lt('namespace', prefix.slice(0, -1) + '0'),
        ),
      4,
    );
    for (const row of page.page) {
      const table = await importReference(ctx, `r2blob:${row._id}`);
      if (table && row.r2Key.startsWith(prefix)) references.push({ key: row.r2Key, table });
    }
    return { next: advance(page, resume), references };
  }

  const [table, field] = keyRows[section];
  const page = await read(keyRange(ctx, section, prefix), 256);
  // Own rows enter the range too; only another project's row is a reference.
  for (const row of page.page) {
    const key = field === 'r2Key' ? row.r2Key : row.archiveReceipt?.r2Key;
    if (row.projectId !== projectId && key?.startsWith(prefix)) references.push({ key, table });
  }
  return { next: advance(page, resume), references };
}

export async function referencePage(
  ctx: QueryCtx,
  { projectId, next = { section: 'objects', cursor: null } }: { projectId: ProjectId; next?: Position },
) {
  invariant(
    await ctx.db.get(projectId),
    'PROJECT_UNAVAILABLE',
    'This project has no retained project record.',
  );
  const references: Reference[] = [];
  if (next.section === 'fileChecks')
    invariant(
      next.remaining.length <= 8 && next.aliases.length <= 32,
      'BAD_ARGUMENT',
      'Use the returned reference cursor.',
    );
  const position =
    next.section === 'fileChecks'
      ? await checkFiles(ctx, projectId, next, references)
      : await scanSection(ctx, projectId, next, references);
  const metrics = await ctx.meta.getTransactionMetrics();
  return {
    section: next.section,
    next: position,
    references,
    documentBytes: metrics.bytesRead.used,
    documentsRead: metrics.documentsRead.used,
    databaseQueries: metrics.databaseQueries.used,
  };
}
