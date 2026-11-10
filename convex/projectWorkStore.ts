// SPDX-License-Identifier: Apache-2.0
// Flip 5 S1 and S2 (Issue 0695ab24): copy the journal index's Issues, comments and notes into the hosted
// record store in pages, and compare the two read-only. Nothing here changes what Work reads or writes:
// the owner runs these through `hosted-work` and the journal stays the authority until a later slice.
// S3 adds the dual write: with `workStore: 'dual'` each journal append also stores its records.
// Intents are mutable records: the journal owns a copied Intent until a hosted Lane pins its execution
// (a base with a receipt); from then on hosted paths own it and the copy, compare and dual write leave it.
import { v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { invariant, ForgeError } from '../src/errors';
import { report } from './errors';
import { accessibleProject } from './projectAuthority';
import { sourceAuthority } from '../src/hosted-source-authority';
import { selectedGeneration, recordPartition, record as indexRecord } from './projectWorkIndexStore';
import { recordHead, recordVersion, hostedRecordBody } from './projectHostedRecords';
import { hostedRecordIndex, hostedRecordValue } from '../src/hosted-records';
import { assembleIndexValue } from '../src/work-index-value';
import { workStoreRecord, workStoreSources, type WorkStoreSource } from '../src/work-store-records';
import { sameValue, storeReadOf } from './projectWorkStoreReads';

/** Rows per page: a copy page writes at most 3 documents per row (body, version, head). */
export const WORK_STORE_PAGE = 100;
const SAMPLE = 20;
const copySource = v.union(...workStoreSources.map(name => v.literal(name)));
/** S4 reader compares: each journal row against what the store reader returns for it. */
const readCompares = {
  readItems: 'planningItems',
  readVersions: 'planningVersions',
  readComments: 'planningComments',
  readNotes: 'notes',
  readLifecycle: 'lifecycle',
} as const;
const compareSource = v.union(
  copySource,
  v.literal('planningItems'),
  v.literal('issueHeads'),
  ...Object.keys(readCompares).map(name => v.literal(name as keyof typeof readCompares)),
);
type CompareSource = WorkStoreSource | 'planningItems' | 'issueHeads' | keyof typeof readCompares;

async function ownerStore(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to use your Forge project.');
  const project = await accessibleProject(ctx, projectId, user.subject);
  invariant(
    project.owner === user.subject,
    'PROJECT_UNAVAILABLE',
    'The Work store copy and compare are available to the project owner.',
  );
  invariant(
    sourceAuthority(project).mode !== 'native-owner',
    'BAD_ARGUMENT',
    'A native-owner project keeps its Work in the journal.',
  );
  const generation = await selectedGeneration(ctx, project);
  invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'Prepare the hosted Work index first.');
  return { project, partition: recordPartition(generation) };
}

/** One page of a journal index collection with large values joined from their stored parts. */
async function indexPage(
  ctx: QueryCtx | MutationCtx,
  partition: Id<'projectWorkGenerations'>,
  collection: string,
  cursor: string | null,
  newest?: number,
) {
  const page = await ctx.db
    .query('projectWorkRecords')
    .withIndex('by_generation_and_collection_and_position', q =>
      q.eq('generationId', partition).eq('collection', collection),
    )
    .order(newest ? 'desc' : 'asc')
    .paginate({
      cursor,
      numItems: Math.min(newest ?? WORK_STORE_PAGE, WORK_STORE_PAGE),
      maximumBytesRead: 4 * 1024 * 1024,
    });
  const rows: { key: string; value: unknown }[] = [];
  for (const row of page.page) {
    const header = JSON.parse(row.value);
    if (!header.payloadKey) {
      rows.push({ key: row.key, value: header });
      continue;
    }
    const parts: { position: number; value: string }[] = [];
    for (;;) {
      const last = parts.at(-1)?.position;
      const batch = await ctx.db
        .query('projectWorkRecords')
        .withIndex('by_generation_and_collection_and_parent_and_position', q => {
          const parent = q
            .eq('generationId', partition)
            .eq('collection', `${collection}:payload`)
            .eq('parent', header.payloadKey);
          return last === undefined ? parent : parent.gt('position', last);
        })
        .take(100);
      parts.push(...batch);
      if (batch.length < 100) break;
    }
    rows.push({
      key: row.key,
      value: assembleIndexValue(collection, header, parts, {
        incomplete: () => {
          throw new ForgeError('INVALID_WORK_JOURNAL', 'Indexed record payload coverage is incomplete.');
        },
      }),
    });
  }
  return { rows, cursor: page.isDone ? null : page.continueCursor };
}

const tally = () => ({ count: 0, keys: [] as string[] });
const note = (bucket: { count: number; keys: string[] }, key: string) => {
  bucket.count++;
  if (bucket.keys.length < SAMPLE) bucket.keys.push(key);
};

/** Store one record version unless it is already there. A version stored with other bytes is left
 * as it is and reported. History can arrive in any order: the head only moves to a newer version. */
export async function storeVersion(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  encoded: ReturnType<typeof hostedRecordValue>,
): Promise<'copied' | 'same' | 'different'> {
  const { record, ref } = encoded;
  const old = await recordVersion(ctx, projectId, record.kind, record.id, record.version);
  if (old) return old.digest === ref.digest && old.bytes === ref.bytes ? 'same' : 'different';
  await insertVersion(ctx, projectId, encoded, await recordHead(ctx, projectId, record.kind, record.id));
  return 'copied';
}

async function insertVersion(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  { record, ref, value }: ReturnType<typeof hostedRecordValue>,
  head: Awaited<ReturnType<typeof recordHead>>,
) {
  const indexed = { ...hostedRecordIndex(record), version: record.version },
    identity = { projectId, kind: record.kind, key: record.id };
  const bodyId = await ctx.db.insert('projectHostedRecordBodies', { projectId, value });
  const recordId = await ctx.db.insert('projectHostedRecords', {
    ...identity,
    ...indexed,
    bodyId,
    digest: ref.digest,
    bytes: ref.bytes,
  });
  if (!head) await ctx.db.insert('projectHostedRecordHeads', { ...identity, ...indexed, recordId });
  else if (head.version < record.version)
    await ctx.db.replace(head._id, { ...identity, ...indexed, recordId });
}

/** The journal Intent `value` against its stored head. `hosted`: a Lane pinned it, so hosted paths own it.
 * `same`: the head already holds these bytes. With `write`, a missing Intent is stored at version 0 and a
 * changed one as the next version; without it a change is only reported (`different`). */
export async function storeIntent(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  value: unknown,
  write: boolean,
): Promise<'copied' | 'same' | 'different' | 'hosted' | 'missing'> {
  const id = (value as { id: string }).id;
  const head = await recordHead(ctx, projectId, 'intent', id);
  if (head) {
    const row = await ctx.db.get(head.recordId);
    const stored = row ? JSON.parse(await hostedRecordBody(ctx, row)) : null;
    if (!stored || stored.base?.receiptId) return 'hosted';
    const same = hostedRecordValue(workStoreRecord('intents', value, { owner, version: head.version }));
    if (same.ref.digest === row!.digest && same.ref.bytes === row!.bytes) return 'same';
    if (!write) return 'different';
  } else if (!write) return 'missing';
  const encoded = hostedRecordValue(
    workStoreRecord('intents', value, { owner, version: head ? head.version + 1 : 0 }),
  );
  await insertVersion(ctx as MutationCtx, projectId, encoded, head);
  return 'copied';
}

/** S3 dual write: the Issue versions, comments, notes, Intents and lifecycle moves one journal append
 * projects, stored in the same mutation. Large values are joined from the payload parts of the same
 * projection. */
export async function storeProjection(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  entries: { collection: string; key: string; parent: string; position: number; value: string }[],
) {
  for (const entry of entries) {
    if (!(workStoreSources as readonly string[]).includes(entry.collection)) continue;
    const collection = entry.collection as WorkStoreSource,
      header = JSON.parse(entry.value);
    const value = header.payloadKey
      ? assembleIndexValue(
          collection,
          header,
          entries
            .filter(part => part.collection === `${collection}:payload` && part.parent === header.payloadKey)
            .sort((a, b) => a.position - b.position),
        )
      : header;
    try {
      if (collection === 'intents') await storeIntent(ctx, projectId, owner, value, true);
      else await storeVersion(ctx, projectId, hostedRecordValue(workStoreRecord(collection, value)));
    } catch {
      // The journal append stands; the compare reports the row as unreadable.
      continue;
    }
  }
}

/** Switch a project's Work store mode. Dual write starts only after a clean copy and compare; on the
 * dogfood project, only after the restore drill (Issue 7e9678c8) has passed. `records` keeps the dual
 * write and also serves the planning reads from the store (S4); `dual` switches those reads back. */
export const setMode = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    mode: v.union(v.literal('journal'), v.literal('dual'), v.literal('records')),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { project } = await ownerStore(ctx, input.projectId);
      const workStore = input.mode === 'journal' ? undefined : input.mode;
      if (project.workStore !== workStore) await ctx.db.patch(project._id, { workStore });
      return JSON.stringify({ mode: input.mode, changed: project.workStore !== workStore });
    } catch (error) {
      return report(error);
    }
  },
});

/** S1: copy one page. A version already stored with the same digest is left alone, so a retry or a
 * second full run copies nothing; one stored with different bytes is reported, never overwritten. A
 * journal-owned Intent is mutable: a changed one is stored as its next version. */
export const copy = mutation({
  args: { projectId: v.id('hostedProjects'), collection: copySource, cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { project, partition } = await ownerStore(ctx, input.projectId);
      const page = await indexPage(ctx, partition, input.collection, input.cursor);
      let copied = 0,
        same = 0,
        hosted = 0;
      const different = tally(),
        invalid = tally();
      for (const row of page.rows) {
        if (input.collection === 'intents') {
          let stored;
          try {
            // A journal-owned Intent the journal has changed since is stored as its next version.
            stored = await storeIntent(ctx, input.projectId, project.owner, row.value, true);
          } catch {
            note(invalid, row.key);
            continue;
          }
          if (stored === 'copied') copied++;
          else if (stored === 'same') same++;
          else hosted++;
          continue;
        }
        let encoded;
        try {
          encoded = hostedRecordValue(workStoreRecord(input.collection, row.value));
        } catch {
          note(invalid, row.key);
          continue;
        }
        const stored = await storeVersion(ctx, input.projectId, encoded);
        if (stored === 'copied') copied++;
        else if (stored === 'same') same++;
        else note(different, `${encoded.record.kind}:${encoded.record.id}:${encoded.record.version}`);
      }
      return JSON.stringify({ copied, same, hosted, different, invalid, cursor: page.cursor });
    } catch (error) {
      return report(error);
    }
  },
});

/** S2: compare one page read-only. Journal pages check each row has its record version with the same
 * digest (an Intent: its head holds the journal's current Intent, or a Lane pinned it: `hosted`); `planningItems` checks each Issue head is at the journal's latest version; `issueHeads`
 * pages the store and checks each head has its journal Issue (nothing extra). `readItems`, `readVersions`,
 * `readComments`, `readNotes` and `readLifecycle` (S4) check that the store reader returns each journal row field for field.
 * `newest` samples: pages run newest first with at most that many rows, so a bounded check reads the
 * recent rows only (the client stops after its sample). */
export const compare = query({
  args: {
    projectId: v.id('hostedProjects'),
    collection: compareSource,
    cursor: v.union(v.string(), v.null()),
    newest: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { project, partition } = await ownerStore(ctx, input.projectId);
      const collection = input.collection as CompareSource;
      let checked = 0,
        matched = 0,
        hosted = 0;
      const missing = tally(),
        different = tally(),
        invalid = tally();
      if (collection === 'issueHeads') {
        const page = await ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind', q => q.eq('projectId', input.projectId).eq('kind', 'issue'))
          .order(input.newest ? 'desc' : 'asc')
          .paginate({
            cursor: input.cursor,
            numItems: Math.min(input.newest ?? WORK_STORE_PAGE, WORK_STORE_PAGE),
          });
        for (const head of page.page) {
          checked++;
          const row = await indexRecord(ctx, partition, 'planningItems', head.key);
          const version = row ? (JSON.parse(row.value) as { version?: number }).version : undefined;
          if (!row) note(missing, head.key);
          else if (version !== head.version) note(different, `${head.key}:${head.version}:${version}`);
          else matched++;
        }
        return JSON.stringify({
          checked,
          matched,
          missing,
          different,
          invalid,
          cursor: page.isDone ? null : page.continueCursor,
        });
      }
      if (
        collection === 'readItems' ||
        collection === 'readVersions' ||
        collection === 'readComments' ||
        collection === 'readNotes' ||
        collection === 'readLifecycle'
      ) {
        const source = readCompares[collection];
        const page = await indexPage(ctx, partition, source, input.cursor, input.newest);
        for (const row of page.rows) {
          checked++;
          let read;
          try {
            read = await storeReadOf(ctx, input.projectId, source, row.value as { id?: string });
          } catch {
            // A stored body that fails its digest: the reader refuses it, so the compare names it.
            note(invalid, row.key);
            continue;
          }
          if (read == null) note(missing, row.key);
          else if (!sameValue(read, row.value)) note(different, row.key);
          else matched++;
        }
        return JSON.stringify({ checked, matched, missing, different, invalid, cursor: page.cursor });
      }
      const page = await indexPage(ctx, partition, collection, input.cursor, input.newest);
      for (const row of page.rows) {
        checked++;
        if (collection === 'intents') {
          let stored;
          try {
            stored = await storeIntent(ctx, input.projectId, project.owner, row.value, false);
          } catch {
            note(invalid, row.key);
            continue;
          }
          if (stored === 'same') matched++;
          else if (stored === 'hosted') hosted++;
          else note(stored === 'missing' ? missing : different, row.key);
          continue;
        }
        let encoded;
        try {
          encoded = hostedRecordValue(
            workStoreRecord(collection === 'planningItems' ? 'planningVersions' : collection, row.value),
          );
        } catch {
          note(invalid, row.key);
          continue;
        }
        const { record, ref } = encoded;
        if (collection === 'planningItems') {
          const head = await recordHead(ctx, input.projectId, 'issue', record.id);
          if (!head) note(missing, record.id);
          else if (head.version !== record.version)
            note(different, `${record.id}:${head.version}:${record.version}`);
          else matched++;
          continue;
        }
        const stored = await recordVersion(ctx, input.projectId, record.kind, record.id, record.version);
        if (!stored) note(missing, `${record.kind}:${record.id}:${record.version}`);
        else if (stored.digest !== ref.digest || stored.bytes !== ref.bytes)
          note(different, `${record.kind}:${record.id}:${record.version}`);
        else matched++;
      }
      return JSON.stringify({ checked, matched, hosted, missing, different, invalid, cursor: page.cursor });
    } catch (error) {
      return report(error);
    }
  },
});
