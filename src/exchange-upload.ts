// SPDX-License-Identifier: Apache-2.0
import type { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { ContentPin } from './native-exchange.js';
import { invariant } from './errors.js';
import { digest } from './hash.js';
import { mapExchange } from './exchange-parallel.js';
import { putTarget, type ExchangeBlobs, type PutTarget } from './exchange-blobs.js';

type Upload = { pin: ContentPin; read: () => Buffer | Promise<Buffer> };
type Prepared = {
  index: number;
  id: string;
  stored: boolean;
  created: boolean;
  uploadUrl?: string;
  target?: Extract<PutTarget, { kind: 'r2' }>;
  contentType: string;
};
const query = (name: string) => makeFunctionReference<'query'>(name);
const mutation = (name: string) => makeFunctionReference<'mutation'>(name);
const windowBytes = 8 * 1024 * 1024;
/** Independent clients prefer different useful work. No upload lease, sleep or
 * shared authority: existing pending content can always be sent immediately.
 * Default exchange uses two windows; hosting uses four, within the same byte
 * budget. An oversized logical member runs alone. */
export function uploadPhysicalObjects(
  client: Pick<ConvexHttpClient, 'mutation' | 'query'> & Partial<Pick<ConvexHttpClient, 'action'>>,
  projectId: string,
  objects: Upload[],
  options: { batchSize?: number; blobs?: Pick<ExchangeBlobs, 'put'> } = {},
): Promise<{ uploadedObjects: number; uploadedBytes: number }> {
  const pending = [...objects];
  let active = 0,
    reserved = 0,
    failed = false,
    failure: unknown,
    uploadedObjects = 0,
    uploadedBytes = 0;
  return new Promise((resolve, reject) => {
    async function transfer(window: Upload[]) {
      // Hosting already negotiated missing pins for this page. Prepare the full
      // window authoritatively, avoiding a redundant discovery round trip. The
      // normal concurrent-exchange scheduler retains fresh-first discovery.
      const hints: { selected: number[]; stored: number[] } = options.batchSize
        ? { selected: window.map((_, index) => index), stored: [] }
        : await client.query(query('projectObjects:available'), {
            projectId,
            objects: window.map(({ pin }) => ({ digest: pin.sha256, size: pin.size })),
          });
      const indexes = [...hints.stored, ...hints.selected],
        seen = new Set(indexes);
      invariant(
        indexes.length > 0 &&
          seen.size === indexes.length &&
          indexes.every(index => Number.isInteger(index) && index >= 0 && index < window.length),
        'EXCHANGE_UPLOAD_UNKNOWN',
        'Upload preparation did not identify the original content window.',
      );
      const rows: Omit<Prepared, 'index'>[] = hints.selected.length
        ? await client.mutation(mutation('projectObjects:prepareBatch'), {
            projectId,
            objects: hints.selected.map(index => ({
              digest: window[index]!.pin.sha256,
              size: window[index]!.pin.size,
            })),
          })
        : [];
      invariant(
        rows.length === hints.selected.length,
        'EXCHANGE_UPLOAD_UNKNOWN',
        'Upload preparation omitted original selected content.',
      );
      const selected = rows.map((row, index) => ({ ...row, index: hints.selected[index]! }));
      // Put deferred work behind other untouched windows. Returning it before
      // transfer also lets this caller fill its second slot with useful work.
      pending.push(...window.filter((_, index) => !seen.has(index)));
      schedule();
      const attempts = await mapExchange(selected, options.batchSize ? 16 : 8, async row => {
        try {
          return {
            status: 'fulfilled' as const,
            value: await (async () => {
              if (row.stored) return null;
              let cursor: string | null = null;
              // R2 PUTs are create-only and idempotent, so a retried row needs no storage scan.
              while (!row.created && !row.target) {
                const observed: { stored: boolean; isDone: boolean; cursor: string } = await client.mutation(
                  mutation('projectObjects:reconcile'),
                  { id: row.id, cursor },
                );
                if (observed.stored) return null;
                if (observed.isDone) break;
                cursor = observed.cursor;
              }
              invariant(
                row.target || row.uploadUrl,
                'EXCHANGE_UPLOAD_UNKNOWN',
                'Original upload destination is unavailable; reconcile the same request.',
              );
              const object = window[row.index]!,
                bytes = await object.read();
              invariant(
                bytes.length === object.pin.size && digest(bytes) === object.pin.sha256,
                'EXCHANGE_SOURCE_CHANGED',
                'Content differs from its original physical pin.',
              );
              uploadedObjects++;
              uploadedBytes += bytes.length;
              const stored = await (options.blobs?.put ?? putTarget)(
                row.target ?? { uploadUrl: row.uploadUrl!, contentType: row.contentType },
                bytes,
              );
              return row.target
                ? { id: row.id, r2: true as const }
                : { id: row.id, storageId: stored.storageId! };
            })(),
          };
        } catch (reason) {
          return { status: 'rejected' as const, reason };
        }
      });
      const completed = attempts.flatMap(result =>
        result.status === 'fulfilled' && result.value ? [result.value] : [],
      );
      const convex = completed.flatMap(c => ('storageId' in c ? [c] : [])),
        r2 = completed.flatMap(c => ('r2' in c ? [{ id: c.id }] : []));
      if (convex.length) await client.mutation(mutation('projectObjects:completeBatch'), { objects: convex });
      if (r2.length) {
        invariant(
          client.action,
          'EXCHANGE_UPLOAD_UNKNOWN',
          'This client cannot verify object storage uploads.',
        );
        await client.action(makeFunctionReference<'action'>('projectObjectCommit:commitBatch'), {
          objects: r2,
        });
      }
      const error = attempts.find(result => result.status === 'rejected');
      if (error?.status === 'rejected') throw error.reason;
    }
    function schedule() {
      while (!failed && pending.length && active < (options.batchSize ? 4 : 2)) {
        let count = 0,
          bytes = 0;
        for (const object of pending) {
          if (count && (count === (options.batchSize ?? 100) || bytes + object.pin.size > windowBytes)) break;
          count++;
          bytes += object.pin.size;
        }
        const cost = Math.min(2 * windowBytes, bytes);
        if (active && reserved + cost > 2 * windowBytes) break;
        const window = pending.splice(0, count);
        active++;
        reserved += cost;
        void transfer(window)
          .catch(error => {
            if (!failed) {
              failed = true;
              failure = error;
            }
          })
          .finally(() => {
            active--;
            reserved -= cost;
            schedule();
          });
      }
      if (!active) {
        if (failed) reject(failure);
        else if (!pending.length) resolve({ uploadedObjects, uploadedBytes });
      }
    }
    schedule();
  });
}
