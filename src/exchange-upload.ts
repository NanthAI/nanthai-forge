// SPDX-License-Identifier: Apache-2.0
import { setTimeout as sleep } from 'node:timers/promises';
import type { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';
import type { ContentPin } from './native-exchange.js';
import { ForgeError, invariant } from './errors.js';
import { digest } from './hash.js';
import { mapExchange } from './exchange-parallel.js';
import { putTarget, type ExchangeBlobs, type PutTarget } from './exchange-blobs.js';
import { buildUploadPack, uploadPackMembers } from './object-pack-upload.js';

type Upload = { pin: ContentPin; read: () => Buffer | Promise<Buffer> };
type Prepared = {
  index: number;
  id: string;
  stored: boolean;
  created: boolean;
  target?: PutTarget;
  contentType: string;
  /** Feature upload-packs: a member of the upload pack whose pending row is `id`. */
  pack?: { digest: string; size: number; offset: number };
};
/** A pack built before its prepare (the proposal names it): its exact bytes, PUT as they are. */
export type BuiltPack = { digest: string; bytes: Uint8Array };

/** PUT the upload packs among prepared rows, once each, from the first row's target. The bytes are
 * the members in offset order, each checked against its pin (or `built`, already checked). Returns
 * the pack rows to commit and the indexes of the objects they carry. */
async function putPacks(
  objects: readonly Upload[],
  rows: readonly Omit<Prepared, 'index'>[],
  blobs: Pick<ExchangeBlobs, 'put'> | undefined,
  built?: BuiltPack,
) {
  type Pack = { id: string; size: number; target?: PutTarget | undefined; members: Map<number, number> };
  const packs = new Map<string, Pack>();
  const carried = new Set<number>();
  for (const [index, row] of rows.entries()) {
    if (!row.pack || row.stored) continue;
    const pack: Pack = packs.get(row.pack.digest) ?? { id: row.id, size: row.pack.size, members: new Map() };
    invariant(pack.id === row.id, 'EXCHANGE_UPLOAD_UNKNOWN', 'Upload pack rows disagree.');
    pack.target ??= row.target;
    if (!pack.members.has(row.pack.offset)) pack.members.set(row.pack.offset, index);
    packs.set(row.pack.digest, pack);
    carried.add(index);
  }
  const sent: { id: string }[] = [];
  for (const [packDigest, pack] of packs) {
    invariant(pack.target, 'EXCHANGE_UPLOAD_UNKNOWN', 'Original upload pack destination is unavailable.');
    const order = [...pack.members.entries()].sort((a, b) => a[0] - b[0]);
    let bytes = built?.digest === packDigest ? built.bytes : undefined;
    if (!bytes) {
      let offset = 0;
      for (const [at, index] of order) {
        invariant(at === offset, 'EXCHANGE_UPLOAD_UNKNOWN', 'Upload pack members are not contiguous.');
        offset += objects[index]!.pin.size;
      }
      bytes = (
        await buildUploadPack(
          objects,
          order.map(([, index]) => index),
        )
      )?.bytes;
    }
    invariant(
      bytes && bytes.length === pack.size && digest(bytes) === packDigest,
      'EXCHANGE_SOURCE_CHANGED',
      'Upload pack differs from its prepared digest.',
    );
    await (blobs?.put ?? putTarget)(pack.target, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    sent.push({ id: pack.id });
  }
  return { sent, carried };
}
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
    /** Feature upload-packs (hosting windows only): send each window's new small objects as one
     * pack with one PUT. */
    pack?: boolean;
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
      const chosen = hints.selected.map(index => window[index]!),
        built =
          options.pack && options.batchSize
            ? await buildUploadPack(chosen, uploadPackMembers(chosen.map(object => object.pin)))
            : null;
      const rows: Omit<Prepared, 'index'>[] = hints.selected.length
        ? await client.mutation(mutation('projectObjects:prepareBatch'), {
            projectId,
            objects: chosen.map(object => ({ digest: object.pin.sha256, size: object.pin.size })),
            ...(built ? { pack: built.proposal } : {}),
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
      // One PUT for the window's pack, beside the single PUTs of everything outside it.
      const packing = built
        ? putPacks(chosen, rows, options.blobs, { digest: built.proposal.digest, bytes: built.bytes }).then(
            result => {
              for (const index of result.carried) {
                uploadedObjects++;
                uploadedBytes += chosen[index]!.pin.size;
              }
              return result;
            },
          )
        : null;
      packing?.catch(() => {});
      const attempts = await mapExchange(selected, options.batchSize ? 16 : 8, async row => {
        try {
          return {
            status: 'fulfilled' as const,
            value: await (async () => {
              if (row.stored || row.pack) return null;
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
      let packed: Awaited<ReturnType<typeof putPacks>> | null = null;
      try {
        packed = packing && (await packing);
      } catch (reason) {
        attempts.push({ status: 'rejected' as const, reason });
      }
      const completed = [
        ...(packed?.sent ?? []),
        ...attempts.flatMap(result => (result.status === 'fulfilled' && result.value ? [result.value] : [])),
      ];
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
      const carried = packed?.carried ?? new Set<number>();
      for (const [position, row] of selected.entries())
        if (carried.has(position) || (!row.pack && completed.some(object => object.id === row.id)))
          options.onRaw?.(window[row.index]!.pin.sha256);
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
  built?: BuiltPack,
) {
  invariant(
    rows.length === objects.length,
    'EXCHANGE_UPLOAD_UNKNOWN',
    'Upload preparation did not identify the original content window.',
  );
  const [packed, single] = await Promise.all([
    putPacks(objects, rows, blobs, built),
    mapExchange([...rows.keys()], 16, async index => {
      const row = rows[index]!,
        object = objects[index]!;
      if (row.stored || row.pack) return null;
      invariant(row.target, 'EXCHANGE_UPLOAD_UNKNOWN', 'Original upload destination is unavailable.');
      const bytes = await object.read();
      invariant(
        bytes.length === object.pin.size && digest(bytes) === object.pin.sha256,
        'EXCHANGE_SOURCE_CHANGED',
        'Content differs from its original physical pin.',
      );
      await (blobs?.put ?? putTarget)(row.target, bytes);
      return { id: row.id };
    }),
  ]);
  // Each id once: a save names a blob that is also a page only by coincidence of content.
  const seen = new Set(deferCommit.map(row => row.id));
  for (const row of [...packed.sent, ...single])
    if (row && !seen.has(row.id)) {
      seen.add(row.id);
      deferCommit.push(row);
    }
}
