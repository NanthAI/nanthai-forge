// SPDX-License-Identifier: Apache-2.0
'use node';
import { internal } from './_generated/api';
import type { ActionCtx } from './_generated/server';
import type { Cursor } from './projectSourceReturnStep';
import { deltaFits, derivedCollections } from './projectSourceReturnDelta';
import type { IndexEntry } from '../src/work-hosted-index';
const identity = (r: { collection: string; key: string }) => JSON.stringify([r.collection, r.key]);
/** Plan actual-row replacements once. Durable steps only drain immutable output. */
export async function prepareOwnerIndexRows(ctx: ActionCtx, c: Cursor) {
  if (c.delta) {
    const delta = c.delta,
      selected = new Map<string, IndexEntry>();
    const removed = new Map(delta.removed.map(row => [identity(row), row]));
    for (let offset = 0; offset < c.rows.length; offset += 100) {
      const entries = c.rows.slice(offset, offset + 100);
      const oldRows: (IndexEntry | null)[] = await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
        projectId: c.final.projectId,
        owner: c.final.owner,
        generationId: c.generationId,
        keys: entries.map(({ collection, key }) => ({ collection, key })),
      });
      for (const [i, row] of entries.entries()) {
        const key = identity(row),
          old = oldRows[i] ?? selected.get(key);
        if (oldRows[i] && !selected.has(key)) {
          delta.readBytes += Buffer.byteLength(JSON.stringify(oldRows[i])) + 2048;
          if (!row.collection.endsWith(':payload')) {
            const payloadKey = JSON.parse(oldRows[i]!.value).payloadKey;
            if (payloadKey && JSON.parse(row.value).payloadKey !== payloadKey) {
              delta.payloadReplacements++;
              const parts = JSON.parse(oldRows[i]!.value).payloadParts;
              for (let part = 0; part < parts; part++) {
                const pin = { collection: `${row.collection}:payload`, key: `${payloadKey}:${part}` };
                removed.set(identity(pin), pin);
              }
            }
          }
        }
        if (old) {
          if (row.collection === 'diffstats' && JSON.parse(old.value).provenance === 'server-computed')
            row.value = old.value;
          if (row.collection !== 'viewFiles') row.position = old.position;
        } else {
          const position = delta.positions[row.collection] ?? 0;
          delta.positions[row.collection] = position + 1;
          if (
            row.collection !== 'viewFiles' &&
            !row.collection.endsWith(':payload') &&
            !row.collection.startsWith('sourceTree')
          )
            row.position = position;
          if (
            row.collection.endsWith(':payload') ||
            derivedCollections.includes(row.collection) ||
            row.collection === 'diffstats' ||
            (delta.partial && row.collection === 'sourcePins') ||
            row.collection.startsWith('sourceStateParent') ||
            row.collection.startsWith('sourceTree') ||
            row.collection.startsWith('sourceAncestry')
          )
            c.metadata!.counts[row.collection] = (c.metadata!.counts[row.collection] ?? 0) + 1;
        }
        selected.set(key, row);
      }
    }
    delta.removed = [...removed.values()];
    const payloads = delta.removed.filter(row => row.collection.endsWith(':payload'));
    for (let offset = 0; offset < payloads.length; offset += 100) {
      const oldRows: (IndexEntry | null)[] = await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
        projectId: c.final.projectId,
        owner: c.final.owner,
        generationId: c.generationId,
        keys: payloads.slice(offset, offset + 100),
      });
      for (const old of oldRows)
        if (old) {
          c.metadata!.counts[old.collection] = (c.metadata!.counts[old.collection] ?? 0) - 1;
          delta.readBytes += Buffer.byteLength(JSON.stringify(old)) + 2048;
        }
    }
    delta.entries = [...selected.values()];
    c.rows = [];
    if (deltaFits(delta, Buffer.byteLength(JSON.stringify(c.final)))) return;
    c.snapshot.omit = [...delta.entries, ...delta.removed].map(identity);
    c.copy = { cursor: null };
    c.rows = delta.entries;
    c.full = true;
    delete c.delta;
  }
  if (!c.copy) {
    const positions = new Map<string, number>();
    for (const row of c.rows)
      if (derivedCollections.includes(row.collection) && row.collection !== 'viewFiles') {
        row.position = positions.get(row.collection) ?? 0;
        positions.set(row.collection, row.position + 1);
      }
  }
  c.snapshot.output = c.rows;
  c.offset = 0;
  c.rows = [];
}
