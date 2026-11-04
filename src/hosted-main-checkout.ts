// SPDX-License-Identifier: Apache-2.0
import { readHostedMainMarker } from './hosted-main-marker.js';
import { reuseMainSource } from './hosted-main-reuse.js';
import { canonicalRoot, clientCacheRoot } from './root-paths.js';
import { preserveMisplacedReadCaches } from './hosted-legacy-cache.js';
import { planCheckoutPreservation, preserveCheckoutArtifacts } from './hosted-checkout-preserve.js';
import { recordMetricCache } from './self-metrics-source-observations.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { parseNativeState } from './native-state-format.js';
import { hostedMainSchema, type HostedMain, type MainExpectation } from './hosted-main.js';
import { durableReplace, syncDirectory } from './native-durability.js';
import {
  cleanHostedCheckout,
  installHostedFiles,
  flushHostedCheckoutFiles,
} from './hosted-checkout-files.js';
import { workLocked } from './work-lock.js';
import { readSource } from './files.js';
import { HostedCheckoutCache, type CheckoutObjectTransport } from './hosted-checkout-cache.js';
export interface MainTransport extends CheckoutObjectTransport {
  current(expected?: MainExpectation): Promise<HostedMain>;
  /** Actual Convex requests, including recipe metadata when available. */
  calls?(): { queries: number; mutations: number; actions: number };
}
const requestSchema = z
  .object({
    projectId: z.string(),
    operationId: z.uuid(),
    url: z.url(),
    expected: z.object({ head: z.string(), receiptId: z.string() }).optional(),
    refresh: z.boolean().optional(),
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
  root = canonicalRoot(root);
  const cache = clientCacheRoot(root),
    lock = join(cache, 'lock');
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  invariant(!lstatSync(cache).isSymbolicLink(), 'UNSAFE_PATH', 'Client cache must be real.');
  mkdirSync(join(cache, 'objects'), { recursive: true, mode: 0o700 });
  invariant(
    !lstatSync(join(cache, 'objects')).isSymbolicLink(),
    'UNSAFE_PATH',
    'Client objects must be real.',
  );
  const recoveryPath = join(cache, `legacy-cache-recovery-${request.operationId}.json`);
  const localRecovery = () => (existsSync(recoveryPath) ? { localRecovery: json(recoveryPath) } : {});
  const preserveCaches = (files: readonly { path: string }[]) => {
    preserveMisplacedReadCaches(
      root,
      files,
      receipt => {
        const moved = (existsSync(recoveryPath) ? json(recoveryPath) : []).filter(
          (item: { preservedAt: string }) => existsSync(item.preservedAt),
        );
        if (!moved.some((item: { preservedAt: string }) => item.preservedAt === receipt.preservedAt))
          moved.push(receipt);
        else
          moved[
            moved.findIndex((item: { preservedAt: string }) => item.preservedAt === receipt.preservedAt)
          ] = receipt;
        save(recoveryPath, moved);
      },
      existsSync(recoveryPath) ? json(recoveryPath) : [],
    );
  };
  const preservationPath = join(cache, `preserve-${request.operationId}.json`);
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
    const marker = readHostedMainMarker(root);
    if (request.refresh) {
      invariant(marker, 'WORK_CONFLICT', 'Pull requires a Forge clone root.');
      invariant(
        marker.selection.projectId === request.projectId,
        'PROJECT_UNAVAILABLE',
        'Select this clone’s project.',
      );
      cleanHostedCheckout(root, marker.state.files, 'hosted-main.json', true, { deferExtras: true });
    }
    const next = {
      request,
      selection: observed,
      complete: Boolean(
        request.refresh &&
        !existsSync(previous) &&
        marker?.selection.head === observed.head &&
        marker?.selection.receipt.id === observed.receipt.id,
      ),
      previousMarker: before ? digest(before) : null,
    };
    save(receiptPath, next);
    recordMetricCache(cache, observed, 'authority', request.operationId);
    return next;
  });
  const selection = hostedMainSchema.parse(operation.selection);
  invariant(selection.projectId === request.projectId, 'PROJECT_UNAVAILABLE', 'Select this project.');
  if (operation.complete)
    return {
      ...selection,
      root,
      downloadedObjects: 0,
      downloadedBytes: 0,
      replayed: true,
      ...localRecovery(),
    };
  // Refresh never uses a full source pack, even for a thousand-file delta.
  const objects = new HostedCheckoutCache(
    cache,
    request.refresh ? { ...transport, sourcePack: async () => null } : transport,
  );
  await objects.ensure([selection.head]);
  const state = parseNativeState(readFileSync(join(objects.objects, selection.head)));
  if (request.refresh) {
    const baseline = readHostedMainMarker(root);
    if (baseline) reuseMainSource(root, objects.objects, baseline.state.files, state.files);
  }
  await objects.ensure(state.files.map(file => file.blob));
  const stage = mkdtempSync(join(cache, 'checkout-'));
  try {
    await installHostedFiles(stage, objects.objects, state.files);
    mkdirSync(join(stage, '.forge'), { mode: 0o700 });
    save(join(stage, '.forge', 'hosted-main.json'), { selection, state });
    await flushHostedCheckoutFiles(stage, state.files);
    // Reauthorize after transfer and staging, immediately before publication.
    const authorized = await transport.current();
    invariant(authorized.projectId === request.projectId, 'PROJECT_UNAVAILABLE', 'Select this project.');
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
      const beforeFiles = marker ? parseNativeState(Buffer.from(JSON.stringify(marker.state))).files : [];
      const preserveArtifacts = () =>
        preserveCheckoutArtifacts(root, previous, preservationPath, () => {
          const oldBytes = readSource(previous, '.forge/hosted-main.json', Number.MAX_SAFE_INTEGER);
          invariant(
            (oldBytes ? digest(oldBytes) : null) === operation.previousMarker,
            'WORK_CONFLICT',
            'The prior checkout baseline changed; both copies are preserved.',
          );
          const old = oldBytes ? markerSchema.parse(JSON.parse(oldBytes.toString())) : null;
          return cleanHostedCheckout(
            previous,
            old ? parseNativeState(Buffer.from(JSON.stringify(old.state))).files : [],
            'hosted-main.json',
            Boolean(old),
            { target: state.files },
          );
        });
      const installed = marker && JSON.stringify(marker.selection) === JSON.stringify(selection);
      if (installed) preserveArtifacts();
      preserveCaches([...beforeFiles, ...state.files]);
      const artifacts = cleanHostedCheckout(root, beforeFiles, 'hosted-main.json', Boolean(marker), {
        target: state.files,
      });
      if (!installed) {
        invariant(!existsSync(previous), 'WORK_CONFLICT', 'An earlier checkout backup is preserved.');
        planCheckoutPreservation(preservationPath, artifacts);
        if (existsSync(root)) renameSync(root, previous);
        renameSync(stage, root);
        preserveArtifacts();
      }
      syncDirectory(dirname(root));
      syncDirectory(cache);
      if (existsSync(previous)) rmSync(previous, { recursive: true });
      operation.complete = true;
      save(receiptPath, operation);
      recordMetricCache(cache, selection, 'replica', request.operationId);
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
    ...localRecovery(),
  };
}
