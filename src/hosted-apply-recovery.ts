// SPDX-License-Identifier: Apache-2.0
import { canonicalRoot, clientCacheRoot } from './root-paths.js';
import { lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ForgeError, invariant } from './errors.js';
import { durableReplace, syncDirectory } from './native-durability.js';
import { workLocked } from './work-lock.js';
import {
  checkoutPathExists,
  cleanHostedCheckout,
  installHostedFiles,
  flushHostedCheckoutFiles,
} from './hosted-checkout-files.js';
import { hostedLaneMarkerName } from './hosted-lane-checkout-marker.js';
import { HostedCheckoutCache } from './hosted-checkout-cache.js';
import { type LaneTransport } from './hosted-lane-checkout.js';
import { hostedRecoveryCommand } from './hosted-agent-resolution.js';
import { parseNativeStateValue } from './native-state-format.js';
import { applyHostedSync } from './hosted-sync-client.js';
import { applySchema } from './hosted-sync-contract.js';
import { withCheckoutWritePass } from './checkout-materialization.js';
import { hostedActionError } from './hosted-action-error.js';

import {
  receiptSchema,
  validBaseline,
  recoveryDirectory,
  pathFor,
  read,
  savedSchema,
  markerAt,
  localApplyBlocked,
} from './hosted-apply-recovery-records.js';
export { localApplyBlocked } from './hosted-apply-recovery-records.js';

/** Explicit recovery preserves the entire obstructed tree, then restores its exact baseline.
 * Each rename is journaled and retryable; no submitted source work is replaced or cancelled. */
export async function recoverLocalApply(root: string, id: string, transport: LaneTransport) {
  root = canonicalRoot(root);
  const cacheRoot = clientCacheRoot(root),
    saved = savedSchema.parse(read(pathFor(root, id)));
  const request = applySchema.parse(saved.request);
  invariant(request.operationId === id, 'WORK_OPERATION_CHANGED', 'Recover the retained apply.');
  const observed = await transport.select(request.lane.laneId); // fresh authority before local writes
  invariant(
    observed.projectId === request.lane.projectId && observed.laneId === request.lane.laneId,
    'PROJECT_UNAVAILABLE',
    'Recover this project.',
  );
  try {
    const directory = recoveryDirectory(root, id),
      backup = join(directory, 'checkout');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const path of [cacheRoot, directory])
      invariant(
        lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
        'UNSAFE_PATH',
        'Recovery directories must be real.',
      );
    const receiptPath = join(directory, 'receipt.json');
    const receipt = workLocked(join(cacheRoot, 'lock'), () => {
      if (checkoutPathExists(receiptPath)) return receiptSchema.parse(read(receiptPath));
      const observedMarker = markerAt(root),
        marker = saved.baseline ?? observedMarker;
      invariant(
        marker && validBaseline(marker, request),
        'WORK_STALE',
        'The local baseline changed; preserve it before recovering the retained apply.',
      );
      const value = {
        marker,
        restored: false,
        preservedAt: backup,
        baselineStage: join(directory, `baseline-${randomUUID()}`),
        undo: `The original checkout is preserved at ${backup}. Copy needed files back after apply; keep the new .forge marker. Additional preservation rounds remain in the same recovery directory.`,
      };
      durableReplace(receiptPath, JSON.stringify(value));
      return receiptSchema.parse(value);
    });
    invariant(
      validBaseline(receipt.marker, request),
      'WORK_OPERATION_CHANGED',
      'Recover the original checkout baseline.',
    );
    invariant(
      receipt.preservedAt === backup,
      'WORK_OPERATION_CHANGED',
      'Retain the original recovery backup.',
    );
    const checkoutReceipt = join(cacheRoot, `${id}.json`);
    const alreadyApplied =
      checkoutPathExists(checkoutReceipt) &&
      z.object({ complete: z.boolean() }).parse(read(checkoutReceipt)).complete;
    if (!receipt.restored && !alreadyApplied) {
      const paths = new Set<string>(receipt.marker.materialized);
      const state = parseNativeStateValue(receipt.marker.state);
      const files = state.files.filter(file => paths.has(file.path));
      const cache = new HostedCheckoutCache(cacheRoot, transport);
      await cache.ensure(files.map(file => file.blob));
      await withCheckoutWritePass(cacheRoot, async () => {
        Object.assign(receipt, receiptSchema.parse(read(receiptPath)));
        if (
          receipt.restored ||
          (checkoutPathExists(checkoutReceipt) &&
            z.object({ complete: z.boolean() }).parse(read(checkoutReceipt)).complete)
        )
          return;
        // Journal one private stage before creating it. A crash cannot orphan
        // another full tree, and concurrent replays share the write lease.
        if (!receipt.baselineStage) {
          receipt.baselineStage = join(directory, `baseline-${randomUUID()}`);
          durableReplace(receiptPath, JSON.stringify(receipt));
        }
        const stage = receipt.baselineStage;
        invariant(
          dirname(stage) === directory && /^baseline-[a-f0-9-]{36}$/.test(basename(stage)),
          'UNSAFE_PATH',
          'The private baseline stage must stay in its recovery directory.',
        );
        if (checkoutPathExists(stage)) rmSync(stage, { recursive: true, force: true });
        mkdirSync(stage, { mode: 0o700 });
        try {
          await installHostedFiles(stage, cache.objects, files);
          mkdirSync(join(stage, '.forge'), { mode: 0o700, recursive: true });
          durableReplace(join(stage, '.forge', hostedLaneMarkerName), JSON.stringify(receipt.marker));
          await flushHostedCheckoutFiles(stage, files);
          syncDirectory(directory);
          workLocked(join(cacheRoot, 'lock'), () => {
            const current = receiptSchema.parse(read(receiptPath));
            if (current.restored) return;
            let roundBackup = current.roundBackup ?? backup;
            const validateBackup = () => {
              invariant(
                dirname(roundBackup) === directory &&
                  (basename(roundBackup) === 'checkout' ||
                    /^checkout-[a-f0-9-]{36}$/.test(basename(roundBackup))),
                'UNSAFE_PATH',
                'Recovery backup must stay in its original directory.',
              );
            };
            validateBackup();
            const publishedBaseline = () => {
              if (JSON.stringify(markerAt(root)) !== JSON.stringify(current.marker)) return false;
              try {
                cleanHostedCheckout(root, files, hostedLaneMarkerName, true);
                return true;
              } catch (error) {
                if (error instanceof ForgeError && error.code === 'WORK_CONFLICT') return false;
                throw error;
              }
            };
            if (checkoutPathExists(roundBackup) && checkoutPathExists(root) && !publishedBaseline()) {
              roundBackup = join(directory, `checkout-${randomUUID()}`);
              current.roundBackup = roundBackup;
              current.additionalPreservedAt = [...(current.additionalPreservedAt ?? []), roundBackup];
              durableReplace(receiptPath, JSON.stringify(current));
            }
            if (!checkoutPathExists(roundBackup) && checkoutPathExists(root)) {
              renameSync(root, roundBackup);
              syncDirectory(directory);
              syncDirectory(dirname(root));
            }
            if (!checkoutPathExists(root)) renameSync(stage, root);
            invariant(
              publishedBaseline(),
              'WORK_CONFLICT',
              'A recreated checkout obstructed baseline publication; recover again to preserve it.',
            );
            const previous = join(cacheRoot, 'previous');
            if (checkoutPathExists(previous)) {
              const firstBackup = current.priorPreservedAt ?? join(directory, 'prior-checkout');
              let priorBackup = firstBackup;
              if (checkoutPathExists(firstBackup)) {
                priorBackup = current.pendingPriorPreservedAt ?? join(directory, `checkout-${randomUUID()}`);
                if (checkoutPathExists(priorBackup))
                  priorBackup = join(directory, `checkout-${randomUUID()}`);
                current.pendingPriorPreservedAt = priorBackup;
                current.additionalPreservedAt = [
                  ...new Set([...(current.additionalPreservedAt ?? []), priorBackup]),
                ];
              }
              invariant(
                dirname(priorBackup) === directory,
                'UNSAFE_PATH',
                'Keep the prior checkout in its recovery directory.',
              );
              current.priorPreservedAt = firstBackup;
              durableReplace(receiptPath, JSON.stringify(current));
              renameSync(previous, priorBackup);
            }
            syncDirectory(cacheRoot);
            syncDirectory(directory);
            syncDirectory(join(root, '..'));
            current.restored = true;
            durableReplace(receiptPath, JSON.stringify(current));
            Object.assign(receipt, current);
          });
        } finally {
          if (checkoutPathExists(stage)) rmSync(stage, { recursive: true, force: true });
        }
      });
    }
    const applied = await applyHostedSync(root, request, transport);
    const next = saved.handoff
      ? { action: saved.handoff.action, ...saved.handoff.command }
      : { action: 'open', laneId: request.lane.laneId };
    const { action, ...command } = next;
    return {
      phase: 'local-apply',
      status: 'applied',
      applied,
      sourceCompleted: true,
      operationId: saved.handoff?.operationId ?? id,
      applyOperationId: id,
      preservedAt: backup,
      undo: receipt.undo,
      ...(receipt.additionalPreservedAt?.length
        ? { additionalPreservedAt: receipt.additionalPreservedAt }
        : {}),
      ...(checkoutPathExists(join(directory, 'prior-checkout'))
        ? {
            priorPreservedAt: join(directory, 'prior-checkout'),
            priorUndo: `Earlier installer backup preserved at ${join(directory, 'prior-checkout')}. Copy needed files back after apply.`,
          }
        : {}),
      next,
      command: hostedRecoveryCommand(root, action, command),
    };
  } catch (error) {
    if (error instanceof ForgeError && error.recovery?.phase === 'local-apply') throw error;
    const safe = hostedActionError(error, 'local apply recovery');
    throw localApplyBlocked(
      root,
      request,
      safe.code === 'HOSTED_ACTION_FAILED'
        ? new ForgeError('LOCAL_APPLY_INTERRUPTED', 'Local apply recovery was interrupted before completion.')
        : safe,
    );
  }
}
