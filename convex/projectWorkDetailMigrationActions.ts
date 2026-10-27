// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { action } from './cliServer';
import type { Doc } from './_generated/dataModel';
import { caller, load } from './projectWorkActions';
import { exchangeObjectReader } from './projectExchangeReader';
import { recordExchange } from './projectWorkRecordExchange';
import { detailObjectWriter } from './projectWorkDetailObjects';
import { compactDetailPage, slimWorkFormat, type WorkDetailPin } from '../src/work-record-details';
import { buildWorkRecords, readRecord, recordBytes } from '../src/work-exchange-records';
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
      const saved = JSON.parse(
        await ctx.runMutation(makeFunctionReference<'mutation'>('projectWorkDetailMigration:begin'), scope),
      ) as Doc<'projectWorkDetailMigrations'>;
      if (saved.root) return JSON.stringify({ complete: true, root: saved.root });
      const reader = exchangeObjectReader(ctx),
        put = detailObjectWriter(ctx, input.projectId, owner);
      const info = (await ctx.runQuery(makeFunctionReference<'query'>('projectBackups:get'), {
        id: saved.backupId,
        owner,
      })) as { backup: Doc<'projectBackups'> };
      const exchange =
        info.backup.transport === 'objects' ? await recordExchange(info.backup, owner, reader) : undefined;
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
      for (const [id, bytes] of built.objects) if (!known.has(id)) await put(bytes);
      await put(Buffer.from(JSON.stringify(snapshot.data, null, 2)));
      const root = await put(built.bytes);
      await ctx.runMutation(makeFunctionReference<'mutation'>('projectWorkDetailMigration:publish'), {
        ...scope,
        root,
      });
      return JSON.stringify({ complete: true, root });
    } catch (error) {
      return report(error);
    }
  },
});
