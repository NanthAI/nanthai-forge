// SPDX-License-Identifier: Apache-2.0
// Flip 5 S1 and S2 (Issue 0695ab24): copy the journal index's Issues, comments and notes into the hosted
// record store in pages, and compare the two read-only. Nothing here changes what Work reads or writes:
// the owner runs these through `hosted-work` and the journal stays the authority until a later slice.
import { v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { invariant, ForgeError } from '../src/errors';
import { report } from './errors';
import { accessibleProject } from './projectAuthority';
import { sourceAuthority } from '../src/hosted-source-authority';
import { selectedGeneration, recordPartition, record as indexRecord } from './projectWorkIndexStore';
import { recordHead, recordVersion } from './projectHostedRecords';
import { hostedRecordIndex, hostedRecordValue } from '../src/hosted-records';
import { assembleIndexValue } from '../src/work-index-value';
import { workStoreRecord, workStoreSources, type WorkStoreSource } from '../src/work-store-records';

/** Rows per page: a copy page writes at most 3 documents per row (body, version, head). */
export const WORK_STORE_PAGE = 100;
const SAMPLE = 20;
const copySource = v.union(...workStoreSources.map(name => v.literal(name)));
const compareSource = v.union(copySource, v.literal('planningItems'), v.literal('issueHeads'));
type CompareSource = WorkStoreSource | 'planningItems' | 'issueHeads';

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
) {
  const page = await ctx.db
    .query('projectWorkRecords')
    .withIndex('by_generation_and_collection_and_position', q =>
      q.eq('generationId', partition).eq('collection', collection),
    )
    .paginate({ cursor, numItems: WORK_STORE_PAGE, maximumBytesRead: 4 * 1024 * 1024 });
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

/** S1: copy one page. A version already stored with the same digest is left alone, so a retry or a
 * second full run copies nothing; one stored with different bytes is reported, never overwritten. */
export const copy = mutation({
  args: { projectId: v.id('hostedProjects'), collection: copySource, cursor: v.union(v.string(), v.null()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { partition } = await ownerStore(ctx, input.projectId);
      const page = await indexPage(ctx, partition, input.collection, input.cursor);
      let copied = 0,
        same = 0;
      const different = tally(),
        invalid = tally();
      for (const row of page.rows) {
        let encoded;
        try {
          encoded = hostedRecordValue(workStoreRecord(input.collection, row.value));
        } catch {
          note(invalid, row.key);
          continue;
        }
        const { record, ref, value } = encoded;
        const old = await recordVersion(ctx, input.projectId, record.kind, record.id, record.version);
        if (old) {
          if (old.digest === ref.digest && old.bytes === ref.bytes) same++;
          else note(different, `${record.kind}:${record.id}:${record.version}`);
          continue;
        }
        const indexed = { ...hostedRecordIndex(record), version: record.version },
          identity = { projectId: input.projectId, kind: record.kind, key: record.id };
        const bodyId = await ctx.db.insert('projectHostedRecordBodies', {
          projectId: input.projectId,
          value,
        });
        const recordId = await ctx.db.insert('projectHostedRecords', {
          ...identity,
          ...indexed,
          bodyId,
          digest: ref.digest,
          bytes: ref.bytes,
        });
        // History arrives in any order: the head only ever moves to a newer version.
        const head = await recordHead(ctx, input.projectId, record.kind, record.id);
        if (!head) await ctx.db.insert('projectHostedRecordHeads', { ...identity, ...indexed, recordId });
        else if (head.version < record.version)
          await ctx.db.replace(head._id, { ...identity, ...indexed, recordId });
        copied++;
      }
      return JSON.stringify({ copied, same, different, invalid, cursor: page.cursor });
    } catch (error) {
      return report(error);
    }
  },
});

/** S2: compare one page read-only. Journal pages check each row has its record version with the same
 * digest; `planningItems` checks each Issue head is at the journal's latest version; `issueHeads`
 * pages the store and checks each head has its journal Issue (nothing extra). */
export const compare = query({
  args: {
    projectId: v.id('hostedProjects'),
    collection: compareSource,
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const { partition } = await ownerStore(ctx, input.projectId);
      const collection = input.collection as CompareSource;
      let checked = 0,
        matched = 0;
      const missing = tally(),
        different = tally(),
        invalid = tally();
      if (collection === 'issueHeads') {
        const page = await ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_key', q =>
            q.eq('projectId', input.projectId).eq('kind', 'issue'),
          )
          .paginate({ cursor: input.cursor, numItems: WORK_STORE_PAGE });
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
      const page = await indexPage(ctx, partition, collection, input.cursor);
      for (const row of page.rows) {
        checked++;
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
      return JSON.stringify({ checked, matched, missing, different, invalid, cursor: page.cursor });
    } catch (error) {
      return report(error);
    }
  },
});
