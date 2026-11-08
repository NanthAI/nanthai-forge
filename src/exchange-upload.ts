// SPDX-License-Identifier: Apache-2.0
import { setTimeout as sleep } from 'node:timers/promises';
import type { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { ContentPin } from './native-exchange.js';
import { ForgeError, invariant } from './errors.js';
import { digest } from './hash.js';
import { mapExchange } from './exchange-parallel.js';
import { putTarget, type ExchangeBlobs, type PutTarget } from './exchange-blobs.js';

type Upload = { pin: ContentPin; read: () => Buffer | Promise<Buffer> };
type Prepared = {
  index: number;
  id: string;
  stored: boolean;
  created: boolean;
  target?: PutTarget;
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
  options: {
    batchSize?: number;
    onRaw?: (sha256: string) => void;
    blobs?: Pick<ExchangeBlobs, 'put'>;
    wait?: (ms: number) => Promise<unknown>;
    /** Collect PUT rows here instead of committing each window; the caller commits them later
     * (`projectObjectCommit:commitBatch`) before anything relies on them being stored. */
    deferCommit?: { id: string }[];
  } = {},
): Promise<{ uploadedObjects: number; uploadedBytes: number }> {
  const pending = [...objects];
  let active = 0,
    reserved = 0,
    failed = false,
    failure: unknown,
    uploadedObjects = 0,
    uploadedBytes = 0;
  return new Promise((resolve, reject) => {
    async function transfer(window: Upload[], first = true) {
      // Hosting already negotiated missing pins for this page. Prepare the full
      // window authoritatively, avoiding a redundant discovery round trip. The
      // normal concurrent-exchange scheduler retains fresh-first discovery.
      const hints: { selected: number[]; stored: number[] } =
        options.batchSize || !first
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
      if (first) pending.push(...window.filter((_, index) => !seen.has(index)));
      schedule();
      const attempts = await mapExchange(selected, options.batchSize ? 16 : 8, async row => {
        try {
          return {
            status: 'fulfilled' as const,
            value: await (async () => {
              if (row.stored) return null;
              // Every unstored row has a create-only R2 PUT target, so a retry needs no reconcile.
              invariant(
                row.target,
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
              await (options.blobs?.put ?? putTarget)(row.target, bytes);
              return { id: row.id };
            })(),
          };
        } catch (reason) {
          return {
            status: 'rejected' as const,
            reason:
              reason instanceof ForgeError && reason.code === 'EXCHANGE_UPLOAD_UNKNOWN'
                ? new ForgeError(reason.code, `Object ${window[row.index]!.pin.sha256}: ${reason.message}`)
                : reason,
          };
        }
      });
      const completed = attempts.flatMap(result =>
        result.status === 'fulfilled' && result.value ? [result.value] : [],
      );
      if (completed.length && options.deferCommit) options.deferCommit.push(...completed);
      else if (completed.length) {
        invariant(
          client.action,
          'EXCHANGE_UPLOAD_UNKNOWN',
          'This client cannot verify object storage uploads.',
        );
        await client.action(makeFunctionReference<'action'>('projectObjectCommit:commitBatch'), {
          objects: completed,
        });
      }
      for (const object of completed) {
        const row = selected.find(row => row.id === object.id)!;
        options.onRaw?.(window[row.index]!.pin.sha256);
      }
      const error = attempts.find(result => result.status === 'rejected');
      if (error?.status === 'rejected') throw error.reason;
    }
    async function recover(window: Upload[]) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await transfer(window, attempt === 1);
        } catch (error) {
          if (!(error instanceof ForgeError) || error.code !== 'EXCHANGE_UPLOAD_UNKNOWN') throw error;
          if (attempt === 4)
            throw new ForgeError(
              error.code,
              `${error.message} Upload failed after ${attempt} attempts; original objects: ${window.map(o => o.pin.sha256).join(', ')}. Retry the same operation to reconcile.`,
            );
          // Re-prepare the exact window: stored rows are skipped and R2's
          // create-only PUT replays the same key before commit verification.
          // Successful peers stay saved.
          await (options.wait ?? sleep)(250 * 2 ** (attempt - 1));
        }
      }
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
        void recover(window)
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
/** PUT objects whose targets a source prepare already returned (feature prepare-upload-targets):
 * one row per object, in order, as `projectObjects:prepareBatch` returns them. Stored rows are
 * skipped; every other row's create-only, checksum-bound PUT runs at once (16 in flight), and its
 * row joins `deferCommit` for the caller's one verifying commit. Bytes are checked against their
 * pin before they are sent. A lost reply retries the same operation, whose prepare replays. */
export async function putPreparedObjects(
  objects: readonly Upload[],
  rows: readonly Omit<Prepared, 'index'>[],
  deferCommit: { id: string }[],
  blobs?: Pick<ExchangeBlobs, 'put'>,
) {
  invariant(
    rows.length === objects.length,
    'EXCHANGE_UPLOAD_UNKNOWN',
    'Upload preparation did not identify the original content window.',
  );
  const sent = await mapExchange([...rows.keys()], 16, async index => {
    const row = rows[index]!,
      object = objects[index]!;
    if (row.stored) return null;
    invariant(row.target, 'EXCHANGE_UPLOAD_UNKNOWN', 'Original upload destination is unavailable.');
    const bytes = await object.read();
    invariant(
      bytes.length === object.pin.size && digest(bytes) === object.pin.sha256,
      'EXCHANGE_SOURCE_CHANGED',
      'Content differs from its original physical pin.',
    );
    await (blobs?.put ?? putTarget)(row.target, bytes);
    return { id: row.id };
  });
  // Each id once: a save names a blob that is also a page only by coincidence of content.
  const seen = new Set(deferCommit.map(row => row.id));
  for (const row of sent)
    if (row && !seen.has(row.id)) {
      seen.add(row.id);
      deferCommit.push(row);
    }
}
