// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { randomUUID } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { action } from './cliServer';
import type { Doc } from './_generated/dataModel';
import { caller, load } from './projectWorkActions';
import { exchangeObjectReader } from './projectExchangeReader';
import { recordExchange } from './projectWorkRecordExchange';
import { detailObjectWriter } from './projectWorkDetailObjects';
import { compactDetailPage, slimWorkFormat, type WorkDetailPin } from '../src/work-record-details';
import {
  buildWorkRecords,
  readRecord,
  recordBytes,
  workRecordRootSchema,
} from '../src/work-exchange-records';
import { purgeR2Bytes } from './r2Operations';
import { r2Config } from './r2';
import type { ActionCtx } from './_generated/server';
import { digest } from '../src/hash';
import { invariant } from '../src/errors';
import { report } from './errors';
import type { WorkData } from '../src/work-types';
const collections = ['runs', 'automaticActions'] as const;
type Page = { previous: WorkDetailPin | null; collection: number; offset: number; records: WorkDetailPin[] };

/** A finite page per invocation, with a durable original-operation cursor.
 * Native-owner and server projects use the same existing account authority.
 * Source/acceptance receipts, journal IDs and original backup digests stay intact. */
export const step = action({
  args: { projectId: v.id('hostedProjects'), operationId: v.string() },
  returns: v.string(),
  handler: async (ctx, input): Promise<string> => {
    try {
      z.uuid().parse(input.operationId);
      const owner = await caller(ctx),
        scope = { ...input, owner };
      const begin = async () =>
        JSON.parse(
          await ctx.runMutation(makeFunctionReference<'mutation'>('projectWorkDetailMigration:begin'), scope),
        ) as Doc<'projectWorkDetailMigrations'>;
      let saved = await begin();
      if (saved.root) return JSON.stringify({ complete: true, root: saved.root });
      const reader = exchangeObjectReader(ctx),
        put = detailObjectWriter(ctx, input.projectId, owner);
      const info = (await ctx.runQuery(makeFunctionReference<'query'>('projectBackups:get'), {
        id: saved.backupId,
        owner,
      })) as { backup: Doc<'projectBackups'> };
      const exchange =
        info.backup.transport === 'objects' ? await recordExchange(info.backup, owner, reader) : undefined;
      // A staged copy an earlier run left (stopped or rejected) is deleted first; begin then checks the Work again.
      if (saved.staged) {
        // Its writer may still be running (an action runs at most 10 minutes): only a stale copy is deleted here.
        invariant(
          Date.now() - saved.staged.at >= STAGE_LEASE_MS,
          'WORK_STALE',
          'Another run of this detail migration is writing its copy. Run the step again in a few minutes.',
        );
        await discardStaged(ctx, scope, saved, reader, exchange);
        saved = await begin();
      }
      const collection = collections[saved.collection];
      if (collection) {
        const field = exchange?.records.fields.find(field => field.name === collection);
        const catalog = field && 'records' in field ? field.records : undefined;
        // Legacy archives have no record catalog. Their compatibility load still
        // retains only one Work; object-backed owners read this selected page only.
        const legacy = catalog
          ? undefined
          : await load(ctx, input.projectId, owner, reader, { requireCurrent: true });
        const records = catalog
          ? await Promise.all(
              catalog
                .slice(saved.offset, saved.offset + 16)
                .map(pin => readRecord(pin, exchange!.read, collection)),
            )
          : (legacy!.data[collection] ?? []).slice(saved.offset, saved.offset + 16);
        const pending = new Map<string, Uint8Array>();
        const compact = compactDetailPage(collection, records, bytes => {
          const pin = { sha256: digest(bytes), size: bytes.length };
          pending.set(pin.sha256, bytes);
          return pin;
        });
        for (const bytes of pending.values()) await put(bytes);
        const pins: WorkDetailPin[] = [];
        for (const record of compact) pins.push(await put(recordBytes(record)));
        const end = saved.offset + records.length,
          count = catalog?.length ?? legacy!.data[collection]?.length ?? 0;
        const nextCollection = end < count ? saved.collection : saved.collection + 1;
        const nextOffset = end < count ? end : 0;
        const pages = await put(
          Buffer.from(
            JSON.stringify({
              previous: saved.pages,
              collection: saved.collection,
              offset: saved.offset,
              records: pins,
            } satisfies Page),
          ),
        );
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectWorkDetailMigration:advance'), {
          ...scope,
          collection: saved.collection,
          offset: saved.offset,
          pages,
          nextCollection,
          nextOffset,
        });
        return JSON.stringify({ complete: false, collection: nextCollection, offset: nextOffset });
      }
      const snapshot = await load(ctx, input.projectId, owner, reader, { requireCurrent: true });
      invariant(
        snapshot.backup._id === saved.backupId && snapshot.data.revision === saved.revision,
        'WORK_STALE',
        'Work changed while completing the detail migration.',
      );
      const known = new Set(
        exchange?.records.fields.flatMap(field =>
          'records' in field ? field.records.map(pin => pin.sha256) : [],
        ),
      );
      let pagePin = saved.pages;
      while (pagePin) {
        const [bytes] = await reader.read(input.projectId, owner, [pagePin]);
        const page = JSON.parse(bytes!.toString('utf8')) as Page;
        const values = await reader.read(input.projectId, owner, page.records);
        const target = collections[page.collection]!;
        const records = snapshot.data[target] ?? [];
        values.forEach((bytes, index) => {
          records[page.offset + index] = JSON.parse(bytes.toString('utf8'));
          known.add(page.records[index]!.sha256);
        });
        pagePin = page.previous;
      }
      snapshot.data.schema = slimWorkFormat(Number(snapshot.data.schema)) as WorkData['schema'];
      (snapshot.data as Record<string, unknown>).workDetailsMigrated = true;
      const built = buildWorkRecords(snapshot.data);
      invariant(built, 'INVALID_WORK_STORE', 'Retain uniquely keyed Work records for the migrated catalog.');
      const whole = Buffer.from(JSON.stringify(snapshot.data, null, 2));
      const root = { sha256: digest(built.bytes), size: built.bytes.length };
      // The copy is recorded before any of it is written, so a rejection or a stopped run can find and delete it.
      const token = randomUUID();
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectWorkDetailMigration:stage'), {
        ...scope,
        root,
        work: { sha256: digest(whole), size: whole.length },
        token,
      });
      try {
        // The catalog first: a stopped run that wrote any record has written the catalog that names it.
        await put(built.bytes);
        await put(whole);
        for (const [id, bytes] of built.objects) if (!known.has(id)) await put(bytes);
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectWorkDetailMigration:publish'), {
          ...scope,
          root,
          token,
        });
      } catch (error) {
        // Only this run's own copy: a later run may have deleted it and staged its own.
        const now = (await begin()) as Doc<'projectWorkDetailMigrations'>;
        if (now.staged?.token === token) await discardStaged(ctx, scope, now, reader, exchange);
        throw error;
      }
      return JSON.stringify({ complete: true, root });
    } catch (error) {
      return report(error);
    }
  },
});

/** How long a staged copy belongs to the step that staged it: longer than an action can run. */
const STAGE_LEASE_MS = 15 * 60 * 1000;
type Scope = { projectId: Doc<'hostedProjects'>['_id']; operationId: string; owner: string };
/** Delete a rejected (or stopped) migration's staged copy (Item b6588425 line 2e): its catalog root, its whole Work
 * and every record the catalog names that the current base, a published record-detail catalog and the migration's
 * own detail pages do not, row and bytes, in batches. A fixed point: a stopped deletion resumes. Cost: the staged
 * catalog and the page chain once, one mutation and R2 batch per 200 objects. */
async function discardStaged(
  ctx: ActionCtx,
  scope: Scope,
  saved: Doc<'projectWorkDetailMigrations'>,
  reader: ReturnType<typeof exchangeObjectReader>,
  exchange: Awaited<ReturnType<typeof recordExchange>> | undefined,
) {
  const staged = saved.staged;
  if (!staged || saved.root) return;
  const settle = (done: boolean) =>
    ctx.runMutation(makeFunctionReference<'mutation'>('projectWorkDetailMigration:discardSettle'), {
      ...scope,
      done,
    });
  if (staged.pending) {
    await purgeR2Bytes(r2Config(), staged.pending);
    await settle(false);
  }
  const keep = new Set(
    exchange?.records.fields.flatMap(field =>
      'records' in field ? field.records.map(pin => pin.sha256) : [],
    ),
  );
  for (let pagePin = saved.pages; pagePin;) {
    keep.add(pagePin.sha256);
    const [bytes] = await reader.read(scope.projectId, scope.owner, [pagePin]);
    const page = JSON.parse(bytes!.toString('utf8')) as Page;
    for (const record of page.records) keep.add(record.sha256);
    pagePin = page.previous;
  }
  // The catalog is written first, so with no catalog stored nothing else of the copy is; it is deleted last, so a
  // stopped deletion still finds the records it names.
  const pins: { sha256: string; size: number }[] = [staged.work];
  const status = (await ctx.runQuery(makeFunctionReference<'query'>('projectWorkDetailMigration:staged'), {
    ...scope,
  })) as { catalog: boolean };
  if (status.catalog) {
    const [catalog] = await reader.read(scope.projectId, scope.owner, [staged.root]);
    for (const field of workRecordRootSchema.parse(JSON.parse(catalog!.toString('utf8'))).fields)
      if ('records' in field)
        for (const record of field.records)
          if (!keep.has(record.sha256)) pins.push({ sha256: record.sha256, size: record.size });
  }
  const unique = [...new Map(pins.map(pin => [pin.sha256, pin])).values()].filter(
    pin => pin.sha256 !== staged.root.sha256,
  );
  unique.push(staged.root);
  for (let start = 0; start < unique.length; start += 200) {
    await ctx.runMutation(makeFunctionReference<'mutation'>('projectWorkDetailMigration:discardBatch'), {
      ...scope,
      pins: unique.slice(start, start + 200),
    });
    const { pending } = (await ctx.runQuery(
      makeFunctionReference<'query'>('projectWorkDetailMigration:staged'),
      {
        ...scope,
      },
    )) as { pending: { deletes: string[]; zero: { key: string; offset: number; size: number }[] } };
    await purgeR2Bytes(r2Config(), pending);
    await settle(start + 200 >= unique.length);
  }
}
