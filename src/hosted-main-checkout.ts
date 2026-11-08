// SPDX-License-Identifier: Apache-2.0
import { recoverMainPublication } from './hosted-main-publish.js';
import { readHostedMainMarker } from './hosted-main-marker.js';
import { reuseMainSource } from './hosted-main-reuse.js';
import { canonicalRoot, clientCacheRoot } from './root-paths.js';
import { preserveMisplacedReadCaches } from './hosted-legacy-cache.js';
import { planCheckoutPreservation, preserveCheckoutArtifacts } from './hosted-checkout-preserve.js';
import { recordMetricCache } from './self-metrics-source-observations.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { digest } from './hash.js';
import { ForgeError, invariant } from './errors.js';
import { parseNativeState, parseNativeStateValue } from './native-state-format.js';
import { hostedMainSchema, type HostedMain, type MainExpectation } from './hosted-main.js';
import { durableReplace, syncDirectory } from './native-durability.js';
import {
  cleanHostedCheckout,
  installHostedFiles,
  flushHostedCheckoutFiles,
} from './hosted-checkout-files.js';
import { workLocked } from './work-lock.js';
import { indexInstalledFiles, readCheckoutStatIndex, writeCheckoutStatIndex } from './checkout-stat-index.js';
import {
  checkoutDelta,
  deltaDisplacement,
  deltaJournalName,
  deltaObstructed,
  deltaObstructionError,
  deltaRespell,
  journalCheckoutDelta,
  type CheckoutDelta,
} from './hosted-checkout-delta.js';
import { retainedDeltaBackups, settleCheckoutDelta } from './hosted-checkout-delta-settle.js';
import { sweepCheckoutStages } from './hosted-checkout-delta-pending.js';
import { readSource } from './files.js';
import { disposePriorCheckout } from './hosted-checkout-dispose.js';
import type { CheckoutStatIndex } from './checkout-stat-index.js';
import { HostedCheckoutCache, type CheckoutObjectTransport } from './hosted-checkout-cache.js';
import { parseHostedResponse } from './hosted-response.js';
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
  // An interrupted publication settles before anything reads the marker: a legacy per-file journal
  // (publish.json, older clients) rolls back; an in-place delta journal finishes from its durable
  // private stage, rolls back, or refuses, exactly as in a Lane checkout.
  const recover = () => {
    recoverMainPublication(root, cache);
    if (existsSync(previous) && !existsSync(root)) renameSync(previous, root);
    const settled = settleCheckoutDelta(root, cache);
    if (settled?.conflict) throw settled.conflict;
  };
  /** Retire the old clone once publication is durable: only exact baseline bytes are removed, and
   * anything recreated in the old root before the rename landed is held and reported. */
  const disposePrevious = (previousMarker: string | null, index?: CheckoutStatIndex) => {
    if (!existsSync(previous)) return;
    const bytes = readSource(previous, '.forge/hosted-main.json', Number.MAX_SAFE_INTEGER);
    const old =
      bytes && digest(bytes) === previousMarker ? markerSchema.parse(JSON.parse(bytes.toString())) : null;
    disposePriorCheckout({
      root,
      cacheRoot: cache,
      previous,
      files: old ? parseNativeStateValue(old.state).files : [],
      markerName: 'hosted-main.json',
      index: index ?? readCheckoutStatIndex(root),
    });
  };
  const displaced = () => {
    const kept = retainedDeltaBackups(cache);
    return kept.length
      ? {
          displacedRecovery: kept,
          warning: `Local bytes that differed from the clone's baseline were moved out of the working tree during an interrupted pull and kept at ${kept.join(', ')}. Copy back what you need, then delete the folder.`,
        }
      : {};
  };
  // Recheck current access even on cache hits and completed-operation retries.
  const observed = parseHostedResponse(hostedMainSchema, await transport.current());
  invariant(observed.projectId === request.projectId, 'PROJECT_UNAVAILABLE', 'Select this project.');
  let operation = workLocked(lock, () => {
    recover();
    const original = existsSync(receiptPath) ? json(receiptPath) : undefined;
    if (original) {
      invariant(
        JSON.stringify(original.request) === JSON.stringify(request),
        'WORK_OPERATION_CHANGED',
        'Retry the original client checkout request.',
      );
      // A crash after the completion receipt can leave the old clone behind.
      if (original.complete) disposePrevious(original.previousMarker);
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
      cleanHostedCheckout(root, marker.state.files, 'hosted-main.json', true, {
        deferExtras: true,
        index: readCheckoutStatIndex(root),
      });
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
      ...displaced(),
    };
  // Refresh never uses a full source pack, even for a thousand-file delta.
  const objects = new HostedCheckoutCache(
    cache,
    request.refresh ? { ...transport, sourcePack: async () => null } : transport,
  );
  await objects.ensure([selection.head]);
  const state = parseNativeState(readFileSync(join(objects.objects, selection.head)));
  // A pull changes the clone root in place (it never swaps the directory a shell may be in): only
  // changed paths are fetched, verified, staged, flushed and journaled, and the checkout is validated
  // through the stat index. Case/normalization-only renames apply in place too. An untracked
  // obstruction refuses here, before any object is fetched or staged (the clean check inside the
  // lock would refuse it anyway). Only a first checkout, or an ambiguous spelling (two paths that
  // share one folded name), keeps the full private-stage install, which still copies unchanged
  // bytes from the clone instead of downloading them.
  let delta: CheckoutDelta | null = null,
    baselineDigest: string | null = null;
  if (request.refresh) {
    const bytes = readSource(root, '.forge/hosted-main.json', Number.MAX_SAFE_INTEGER);
    const baseline = bytes ? readHostedMainMarker(root) : null;
    if (bytes && baseline) {
      baselineDigest = digest(bytes);
      delta = checkoutDelta(baseline.state.files, state.files, { transitions: true });
      const obstruction = delta && deltaObstructed(root, delta);
      if (obstruction) throw deltaObstructionError(obstruction);
      reuseMainSource(root, objects.objects, baseline.state.files, delta ? delta.install : state.files);
    }
  }
  const stagedFiles = delta ? delta.install : state.files;
  await objects.ensure(stagedFiles.map(file => file.blob));
  const stage = mkdtempSync(join(cache, delta ? 'delta-' : 'checkout-'));
  try {
    await installHostedFiles(stage, objects.objects, stagedFiles);
    mkdirSync(join(stage, '.forge'), { mode: 0o700 });
    save(join(stage, '.forge', 'hosted-main.json'), { selection, state });
    await flushHostedCheckoutFiles(stage, stagedFiles);
    // Stats of the private stage carry over the rename, so later checks read only edited files.
    const installedIndex = delta ? null : indexInstalledFiles(stage, stagedFiles);
    // Reauthorize after a transfer, immediately before publication. When every object came from
    // this machine's verified cache, no server bytes arrived since this operation's access check.
    if (objects.downloadedObjects > 0) {
      const authorized = await transport.current();
      invariant(authorized.projectId === request.projectId, 'PROJECT_UNAVAILABLE', 'Select this project.');
    }
    workLocked(lock, () => {
      operation = json(receiptPath);
      if (operation.complete) return;
      recover();
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
      const beforeFiles = marker ? parseNativeStateValue(marker.state).files : [];
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
            old ? parseNativeStateValue(old.state).files : [],
            'hosted-main.json',
            Boolean(old),
            { target: state.files },
          );
        });
      const installed = marker && JSON.stringify(marker.selection) === JSON.stringify(selection);
      if (installed) preserveArtifacts();
      preserveCaches([...beforeFiles, ...state.files]);
      const index = readCheckoutStatIndex(root);
      const artifacts = cleanHostedCheckout(root, beforeFiles, 'hosted-main.json', Boolean(marker), {
        target: state.files,
        index,
      });
      if (!installed && delta) {
        invariant(
          markerBytes !== null && digest(markerBytes) === baselineDigest,
          'CHANNEL_CHANGED',
          'Another pull updated this client while the selected head was downloading.',
        );
        const obstruction = deltaObstructed(root, delta);
        if (obstruction) throw deltaObstructionError(obstruction);
        sweepCheckoutStages(cache);
        journalCheckoutDelta(cache, {
          operationId: request.operationId,
          stage: basename(stage),
          marker: 'hosted-main.json',
          priorMarker: baselineDigest,
          targetMarker: digest(readFileSync(join(stage, '.forge', 'hosted-main.json'))),
          install: delta.install.map(({ path, blob, mode }) => ({ path, blob, mode })),
          displace: deltaDisplacement(root, delta, beforeFiles),
          targetFiles: state.files,
          ...(delta.respell ? { respell: deltaRespell(root, delta) } : {}),
        });
        let settled;
        try {
          settled = settleCheckoutDelta(root, cache);
        } catch (error) {
          // People read the clone root between commands, so a failed pull is undone now rather
          // than left half-applied until the next one. If even that fails, the journal stays
          // (marked aborting when possible) and the next pull resumes it.
          let undone = false;
          try {
            undone = settleCheckoutDelta(root, cache, { abort: true })?.outcome === 'rolled-back';
          } catch {
            /* Kept for the next pull. */
          }
          const recovery = error instanceof ForgeError ? error.recovery : undefined;
          if (undone && typeof recovery?.reason === 'string')
            throw new ForgeError(
              'WORK_CONFLICT',
              `This pull could not finish: ${recovery.reason} It was undone, so the clone is back at its previous head. Fix that path, then rerun the same command.`,
              undefined,
              { obstruction: recovery.obstruction },
            );
          throw error;
        }
        if (settled?.conflict) throw settled.conflict;
      } else if (!installed) {
        invariant(!existsSync(previous), 'WORK_CONFLICT', 'An earlier checkout backup is preserved.');
        planCheckoutPreservation(preservationPath, artifacts);
        if (existsSync(root)) renameSync(root, previous);
        renameSync(stage, root);
        preserveArtifacts();
        if (installedIndex) writeCheckoutStatIndex(root, installedIndex.since, installedIndex.entries);
      }
      syncDirectory(dirname(root));
      syncDirectory(cache);
      operation.complete = true;
      save(receiptPath, operation);
      disposePrevious(operation.previousMarker, index);
      recordMetricCache(cache, selection, 'replica', request.operationId);
    });
  } finally {
    // A journaled in-place install still owns its stage until it settles.
    const owned = () => {
      try {
        return json(join(cache, deltaJournalName)).stage === basename(stage);
      } catch {
        return false; // No journal (or another process just settled it).
      }
    };
    if (existsSync(stage) && !owned()) rmSync(stage, { recursive: true, force: true });
  }
  return {
    ...selection,
    root,
    downloadedObjects: objects.downloadedObjects,
    downloadedBytes: objects.downloadedBytes,
    replayed: false,
    ...localRecovery(),
    ...displaced(),
  };
}
