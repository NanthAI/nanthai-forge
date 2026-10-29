// SPDX-License-Identifier: Apache-2.0
import { recordMetricCache } from './self-metrics-source-observations.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { parseNativeState } from './native-source.js';
import { hostedMainSchema, type HostedMain, type MainExpectation } from './hosted-main.js';
import { durableReplace, syncDirectory } from './native-durability.js';
import { cleanHostedCheckout, installHostedFile, flushHostedCheckout } from './hosted-checkout-files.js';
import { workLocked } from './work-lock.js';
import { readSource } from './files.js';
import { HostedCheckoutCache, type CheckoutObjectTransport } from './hosted-checkout-cache.js';
export interface MainTransport extends CheckoutObjectTransport {
  current(expected?: MainExpectation): Promise<HostedMain>;
}
const requestSchema = z
  .object({
    projectId: z.string(),
    operationId: z.uuid(),
    url: z.url(),
    expected: z.object({ head: z.string(), receiptId: z.string() }).optional(),
  })
  .strict();
const markerSchema = z.object({ selection: hostedMainSchema, state: z.unknown() }).strict();
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
function save(path: string, value: unknown) {
  durableReplace(path, JSON.stringify(value));
}

/** Client source checkout; deliberately creates no Work owner or acceptance authority. */
export async function checkoutHostedMain(root: string, input: unknown, transport: MainTransport) {
  const request = requestSchema.parse(input);
  root = resolve(root);
  mkdirSync(dirname(root), { recursive: true });
  root = join(realpathSync(dirname(root)), basename(root));
  const cache = `${root}.forge-client`,
    lock = join(cache, 'lock');
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  invariant(!lstatSync(cache).isSymbolicLink(), 'UNSAFE_PATH', 'Client cache must be real.');
  mkdirSync(join(cache, 'objects'), { recursive: true, mode: 0o700 });
  invariant(
    !lstatSync(join(cache, 'objects')).isSymbolicLink(),
    'UNSAFE_PATH',
    'Client objects must be real.',
  );
  const receiptPath = join(cache, `${request.operationId}.json`),
    previous = join(cache, 'previous');
  // Recheck current access even on cache hits and completed-operation retries.
  const observed = hostedMainSchema.parse(await transport.current());
  invariant(observed.projectId === request.projectId, 'PROJECT_UNAVAILABLE', 'Select this project.');
  let operation = workLocked(lock, () => {
    if (existsSync(previous) && !existsSync(root)) renameSync(previous, root);
    const original = existsSync(receiptPath) ? json(receiptPath) : undefined;
    if (original) {
      invariant(
        JSON.stringify(original.request) === JSON.stringify(request),
        'WORK_OPERATION_CHANGED',
        'Retry the original client checkout request.',
      );
      return original as {
        request: typeof request;
        selection: HostedMain;
        complete: boolean;
        previousMarker: string | null;
      };
    }
    invariant(
      !request.expected ||
        (request.expected.head === observed.head && request.expected.receiptId === observed.receipt.id),
      'CHANNEL_CHANGED',
      'Hosted main changed from the expected head and receipt.',
    );
    const before = existsSync(root)
      ? readSource(root, '.forge/hosted-main.json', Number.MAX_SAFE_INTEGER)
      : null;
    const next = {
      request,
      selection: observed,
      complete: false,
      previousMarker: before ? digest(before) : null,
    };
    save(receiptPath, next);
    recordMetricCache(cache, observed, 'authority', request.operationId);
    return next;
  });
  const selection = hostedMainSchema.parse(operation.selection);
  invariant(selection.projectId === request.projectId, 'PROJECT_UNAVAILABLE', 'Select this project.');
  if (operation.complete)
    return { ...selection, root, downloadedObjects: 0, downloadedBytes: 0, replayed: true };
  const objects = new HostedCheckoutCache(cache, transport);
  await objects.ensure([selection.head]);
  const state = parseNativeState(readFileSync(join(objects.objects, selection.head)));
  await objects.ensure(state.files.map(file => file.blob));
  // Access can have been revoked during transfer. Cached bytes confer no authority.
  const authorized = await transport.current();
  invariant(authorized.projectId === request.projectId, 'PROJECT_UNAVAILABLE', 'Select this project.');
  const stage = mkdtempSync(join(cache, 'checkout-'));
  try {
    for (const file of state.files) {
      installHostedFile(stage, join(cache, 'objects'), file);
    }
    mkdirSync(join(stage, '.forge'), { mode: 0o700 });
    save(join(stage, '.forge', 'hosted-main.json'), { selection, state });
    flushHostedCheckout(stage);
    workLocked(lock, () => {
      operation = json(receiptPath);
      if (operation.complete) return;
      if (existsSync(previous) && !existsSync(root)) renameSync(previous, root);
      const markerBytes = existsSync(root)
        ? readSource(root, '.forge/hosted-main.json', Number.MAX_SAFE_INTEGER)
        : null;
      const marker = markerBytes ? markerSchema.parse(JSON.parse(markerBytes.toString())) : undefined;
      invariant(
        !marker || marker.selection.projectId === request.projectId,
        'PROJECT_UNAVAILABLE',
        'This checkout belongs to another project.',
      );
      invariant(
        (markerBytes ? digest(markerBytes) : null) === operation.previousMarker ||
          (marker && JSON.stringify(marker.selection) === JSON.stringify(selection)),
        'CHANNEL_CHANGED',
        'Another pull updated this client while the selected head was downloading.',
      );
      cleanHostedCheckout(
        root,
        marker ? parseNativeState(Buffer.from(JSON.stringify(marker.state))).files : [],
        'hosted-main.json',
        Boolean(marker),
      );
      if (existsSync(previous)) rmSync(previous, { recursive: true });
      if (existsSync(root)) renameSync(root, previous);
      renameSync(stage, root);
      syncDirectory(dirname(root));
      syncDirectory(cache);
      operation.complete = true;
      save(receiptPath, operation);
      recordMetricCache(cache, selection, 'replica', request.operationId);
      if (existsSync(previous)) rmSync(previous, { recursive: true });
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return {
    ...selection,
    root,
    downloadedObjects: objects.downloadedObjects,
    downloadedBytes: objects.downloadedBytes,
    replayed: false,
  };
}
