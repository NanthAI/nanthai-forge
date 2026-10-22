// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { hostedLaneSelectionSchema, type HostedLaneSelection } from './hosted-lane.js';
import { parseNativeState } from './native-state-format.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { durableReplace, syncDirectory } from './native-durability.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { readSource } from './files.js';
import { workLocked } from './work-lock.js';
import { HostedCheckoutCache, type CheckoutObjectTransport } from './hosted-checkout-cache.js';
import {
  checkoutPathExists,
  cleanHostedCheckout,
  installHostedFile,
  flushHostedCheckout,
} from './hosted-checkout-files.js';
import {
  hostedLaneCheckoutSchema,
  hostedLaneMarkerName,
  readHostedLaneCheckout,
  type HostedLaneCheckoutMarker,
} from './hosted-lane-checkout-marker.js';
export interface LaneTransport extends CheckoutObjectTransport {
  select(laneId: string): Promise<HostedLaneSelection>;
}
const operationSchema = z
  .object({
    request: hostedLaneCheckoutSchema,
    selection: hostedLaneSelectionSchema,
    complete: z.boolean(),
    previousMarker: z.string().nullable(),
  })
  .strict();
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
/** Thin editing directory; no native Work owner, Channel writer or acceptance authority. */
export async function checkoutHostedLane(root: string, input: unknown, transport: LaneTransport) {
  const request = hostedLaneCheckoutSchema.parse(input);
  root = resolve(root);
  mkdirSync(dirname(root), { recursive: true });
  root = join(realpathSync(dirname(root)), basename(root));
  const cache = new HostedCheckoutCache(`${root}.forge-client`, transport),
    lock = join(cache.root, 'lock'),
    previous = join(cache.root, 'previous'),
    receiptPath = join(cache.root, `${request.operationId}.json`);
  const markerDigest = () => {
    const bytes = checkoutPathExists(root)
      ? readSource(root, `.forge/${hostedLaneMarkerName}`, Number.MAX_SAFE_INTEGER)
      : null;
    return bytes ? digest(bytes) : null;
  };
  const recover = () => {
    if (checkoutPathExists(previous) && !checkoutPathExists(root)) renameSync(previous, root);
  };
  const identity = (selection: HostedLaneSelection) => {
    invariant(
      selection.projectId === request.projectId && selection.laneId === request.laneId,
      'PROJECT_UNAVAILABLE',
      'Select this project and Lane.',
    );
  };
  const materializedFiles = (marker: HostedLaneCheckoutMarker | null) => {
    const paths = new Set(marker?.materialized ?? []);
    return marker?.state.files.filter(file => paths.has(file.path)) ?? [];
  };
  const baseline = () => {
    const marker = checkoutPathExists(root) ? readHostedLaneCheckout(root) : null;
    if (marker) {
      identity(marker.selection);
      invariant(
        marker.url === request.url,
        'PROJECT_UNAVAILABLE',
        'This checkout belongs to another deployment.',
      );
    }
    return marker;
  };
  // Access is checked even on verified cache hits and completed original-operation retries.
  const observed = hostedLaneSelectionSchema.parse(await transport.select(request.laneId));
  identity(observed);
  let operation = workLocked(lock, () => {
    recover();
    if (checkoutPathExists(receiptPath)) {
      const original = operationSchema.parse(json(receiptPath));
      invariant(
        canonicalPayload(original.request) === canonicalPayload(request),
        'WORK_OPERATION_CHANGED',
        'Retry the original Lane checkout request.',
      );
      return original;
    }
    invariant(
      !request.expected ||
        canonicalPayload(request.expected) ===
          canonicalPayload({
            head: observed.head,
            sourceVersion: observed.sourceVersion,
            version: observed.version,
          }),
      'WORK_STALE',
      'The Lane changed from its expected source pins.',
    );
    const marker = baseline();
    cleanHostedCheckout(root, materializedFiles(marker), hostedLaneMarkerName, Boolean(marker));
    const next = { request, selection: observed, complete: false, previousMarker: markerDigest() };
    durableReplace(receiptPath, JSON.stringify(next));
    return next;
  });
  const selection = operation.selection;
  identity(selection);
  const result = (replayed: boolean) => ({
    ...selection,
    root,
    downloadedObjects: cache.downloadedObjects,
    downloadedBytes: cache.downloadedBytes,
    replayed,
  });
  if (operation.complete) return result(true);
  await cache.ensure([selection.head]);
  const state = parseNativeState(readFileSync(join(cache.objects, selection.head)));
  const before = workLocked(lock, () => {
    recover();
    return baseline();
  });
  const scope =
    request.paths === undefined || before?.scope === null
      ? null
      : [...new Set([...(before?.scope ?? []), ...request.paths])].sort();
  const retained = new Set(before?.materialized ?? []);
  const files = state.files.filter(
    file =>
      scope === null ||
      retained.has(file.path) ||
      scope.some(path => file.path === path || file.path.startsWith(`${path}/`)),
  );
  await cache.ensure(files.map(file => file.blob));
  identity(hostedLaneSelectionSchema.parse(await transport.select(request.laneId)));
  const stage = mkdtempSync(join(cache.root, 'checkout-'));
  try {
    for (const file of files) installHostedFile(stage, cache.objects, file);
    mkdirSync(join(stage, '.forge'), { mode: 0o700 });
    const marker: HostedLaneCheckoutMarker = {
      schema: 1,
      kind: 'forge-hosted-lane-checkout',
      url: request.url,
      operationId: request.operationId,
      selection,
      state,
      scope,
      materialized: files.map(file => file.path),
    };
    durableReplace(join(stage, '.forge', hostedLaneMarkerName), JSON.stringify(marker));
    flushHostedCheckout(stage);
    workLocked(lock, () => {
      operation = operationSchema.parse(json(receiptPath));
      if (operation.complete) return;
      recover();
      const current = baseline();
      invariant(
        markerDigest() === operation.previousMarker || current?.operationId === request.operationId,
        'WORK_STALE',
        'Another checkout updated this client while source was downloading.',
      );
      cleanHostedCheckout(root, materializedFiles(current), hostedLaneMarkerName, Boolean(current));
      // An interrupted post-rename install already has the original marker. Reconcile it.
      if (current?.operationId !== request.operationId) {
        invariant(!checkoutPathExists(previous), 'WORK_CONFLICT', 'An earlier checkout backup is preserved.');
        if (checkoutPathExists(root)) renameSync(root, previous);
        renameSync(stage, root);
        syncDirectory(dirname(root));
        syncDirectory(cache.root);
      }
      operation.complete = true;
      durableReplace(receiptPath, JSON.stringify(operation));
      if (checkoutPathExists(previous)) rmSync(previous, { recursive: true });
    });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  return result(false);
}
