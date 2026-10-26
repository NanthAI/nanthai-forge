// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { makeFunctionReference, type FunctionReference } from 'convex/server';
import { invariant } from './errors.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { prepareHostedSeed } from './hosted-seed-capture.js';
import type { WorkStore } from './work-store.js';
import type { ExchangeTransport, TransferReceipt } from './native-exchange.js';
import type { hostProgress } from './host-progress.js';
import { digest } from './hash.js';
import { retainRecoveryCapture } from './recovery-capture.js';
export { prepareHostedSeed } from './hosted-seed-capture.js';
export interface SeedClient {
  mutation(ref: FunctionReference<'mutation'>, args: Record<string, unknown>): Promise<unknown>;
  action(ref: FunctionReference<'action'>, args: Record<string, unknown>): Promise<unknown>;
}
/** An explicit finite drive: no poll, worker, timer or scheduled continuation.
 * Every successful page advances a durable hosted cursor. Unknown outcomes use
 * the same operation/page and immutable local bytes on the next invocation. */
export async function seedHostedProject(
  store: WorkStore,
  input: { projectId: string; operationId: string; revision: number },
  client: SeedClient,
  exchange: ExchangeTransport,
  progress?: ReturnType<typeof hostProgress>,
) {
  const prepared = await prepareHostedSeed(store, input.revision, input.operationId);
  const { request, pages, directory } = prepared;
  const identity = { projectId: input.projectId, operationId: input.operationId };
  let state = JSON.parse(
    (await client.mutation(makeFunctionReference<'mutation'>('projectHostedSeed:begin'), {
      projectId: input.projectId,
      request: canonicalPayload(request),
    })) as string,
  );
  const total: TransferReceipt = { uploadedObjects: 0, uploadedBytes: 0 };
  const complete = async () => {
    invariant(
      state.backupId && (request.format !== 'native' || state.mainDigest === request.head),
      'SOURCE_HASH_MISMATCH',
      'Seed did not commit the pinned native main.',
    );
    const capturedManifest = JSON.parse(readFileSync(join(directory, request.manifest.sha256), 'utf8'));
    const hasLogs = capturedManifest.files.some((file: { path: string }) =>
      /\/(?:stdout|stderr)\.log$/.test(file.path),
    );
    if (hasLogs)
      await client.action(makeFunctionReference<'action'>('projectCheckLogRetentionActions:registerBackup'), {
        projectId: input.projectId,
        backupId: state.backupId,
        hasLogs,
      });
    return {
      ...total,
      backupId: state.backupId as string,
      mainDigest: state.mainDigest as string | null,
      recovery: retainRecoveryCapture(store, directory, request.root, {
        kind: 'seed',
        backupId: state.backupId,
        completeHistory: 'complete',
        files: { manifest: request.manifest.sha256, work: request.work.sha256 },
      }),
    };
  };
  // A completed begin reconciles a lost finish reply. Validate its original
  // main pin too; receipt publication is idempotent for this seed operation.
  if (state.backupId) return complete();
  const locations = JSON.parse(readFileSync(join(directory, 'locations.json'), 'utf8')) as Record<
    string,
    { path: string }
  >;
  progress?.phase(
    'seeding source and records',
    request.objects,
    pages.flat().reduce((sum, pin) => sum + pin.size, 0),
  );
  const account = (receipt: void | TransferReceipt, count: number, bytes: number) => {
    total.uploadedObjects += receipt?.uploadedObjects ?? count;
    total.uploadedBytes += receipt?.uploadedBytes ?? bytes;
  };
  for (let index = state.nextPage; index < pages.length; index = state.nextPage) {
    const entries = pages[index]!;
    const missing = new Set(await exchange.missing(entries));
    const pending = entries.filter(pin => missing.has(pin.sha256));
    const small = pending.filter(pin => pin.size <= 1024 * 1024 || !exchange.uploadFile);
    if (small.length) {
      const objects = small.map(pin => ({
        pin,
        read: () => {
          const bytes = readFileSync(locations[pin.sha256]!.path);
          invariant(
            bytes.length === pin.size && digest(bytes) === pin.sha256,
            'EXCHANGE_SOURCE_CHANGED',
            'Seed bytes differ from their original pins.',
          );
          return bytes;
        },
      }));
      if (exchange.uploadLazyBatch) {
        const receipt = await exchange.uploadLazyBatch(objects);
        account(
          receipt,
          small.length,
          small.reduce((sum, p) => sum + p.size, 0),
        );
      } else
        for (const object of objects)
          account(await exchange.upload(object.pin, object.read()), 1, object.pin.size);
    }
    for (const pin of pending.filter(pin => !small.includes(pin))) {
      const path = locations[pin.sha256]!.path;
      account(await exchange.uploadFile!(pin, dirname(path), basename(path)), 1, pin.size);
    }
    state = JSON.parse(
      (await client.action(makeFunctionReference<'action'>('projectHostedSeedActions:stage'), {
        ...identity,
        index,
        previous: state.chain,
        body: canonicalPayload(entries),
      })) as string,
    );
    progress?.advance(
      entries.length,
      entries.reduce((sum, p) => sum + p.size, 0),
    );
  }
  progress?.phase('validating seeded main');
  state = JSON.parse(
    (await client.action(
      makeFunctionReference<'action'>('projectHostedSeedActions:finish'),
      identity,
    )) as string,
  );
  return complete();
}
