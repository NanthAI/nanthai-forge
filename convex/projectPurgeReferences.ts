// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v, type Infer } from 'convex/values';
import type { PaginationOptions, PaginationResult } from 'convex/server';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './server';
import { r2ReferencePosition, r2Sections } from './projectPurgeReferenceFields';
import { projectPrefix } from './r2Operations';
import { invariant } from '../src/errors';

type ProjectId = Id<'hostedProjects'>;
type PageQuery<Row> = { paginate: (options: PaginationOptions) => Promise<PaginationResult<Row>> };
type KeyRow = { r2Key?: string; archiveReceipt?: { r2Key?: string } };
type KeyedRow = { projectId: ProjectId } & KeyRow;
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

type Section = (typeof r2Sections)[number];
const sections: Section[] = [...r2Sections];
const cursor = v.union(v.string(), v.null());
const scan = v.object({
  section: v.union(...sections.map(section => v.literal(section))),
  cursor,
  side: r2ReferencePosition.fields.side,
  single: r2ReferencePosition.fields.single,
});
const reference = v.object({ key: v.string(), table: v.string() });
type Reference = Infer<typeof reference>;
type Position = Infer<typeof scan>;
export const referenceArgs = { projectId: v.id('hostedProjects'), next: v.optional(scan) };
export const referenceResult = v.object({
  section: scan.fields.section,
  next: v.union(scan, v.null()),
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

async function scanSection(
  ctx: QueryCtx,
  projectId: ProjectId,
  { section, cursor, side, single }: Infer<typeof scan>,
  references: Reference[],
): Promise<Position | null> {
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
  { projectId, next = { section: 'objectKeys', cursor: null } }: { projectId: ProjectId; next?: Position },
) {
  invariant(
    await ctx.db.get(projectId),
    'PROJECT_UNAVAILABLE',
    'This project has no retained project record.',
  );
  const references: Reference[] = [];
  const position = await scanSection(ctx, projectId, next, references);
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
