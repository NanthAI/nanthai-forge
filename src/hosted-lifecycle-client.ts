// SPDX-License-Identifier: Apache-2.0
import { lstatSync, realpathSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { saveHostedLane } from './hosted-save-client.js';
import { captureHostedSave } from './hosted-save-capture.js';
import { readHostedLaneCheckout, hostedLaneCheckoutMarkerSchema } from './hosted-lane-checkout-marker.js';
import { durableReplace } from './native-durability.js';
import { workLocked } from './work-lock.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { hostedLifecycleRequestSchema, hostedLifecycleResultSchema } from './hosted-lifecycle.js';
import { invariant } from './errors.js';
import type { HostedLaneCheckoutMarker } from './hosted-lane-checkout-marker.js';
import type { ConvexExchange } from './exchange-client.js';
const commandSchema = z
  .object({
    operationId: z.uuid(),
    action: z.enum(['abandon', 'reopen']),
    reason: z.string().trim().max(4000).default(''),
    saveFirst: z.boolean().default(false),
  })
  .strict();
/** Finite API-only compound drive. Saves use their original capture and child UUID;
 * pending/failed/unknown replies preserve both journals and all working files. */
export async function transitionHostedLane(
  root: string,
  command: z.input<typeof commandSchema>,
  exchange: Pick<ConvexExchange, 'client' | 'projectId' | 'uploadFile' | 'upload' | 'missing'>,
) {
  const parsed = commandSchema.parse(command);
  invariant(parsed.action !== 'abandon' || parsed.reason, 'BAD_ARGUMENT', 'Give a reason for abandoning.');
  invariant(!lstatSync(root).isSymbolicLink(), 'UNSAFE_PATH', 'Checkout directory must be real.');
  root = realpathSync(root);
  const cache = `${root}.forge-client`,
    directory = join(cache, 'lifecycle');
  for (const path of [cache, directory]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    invariant(
      lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
      'UNSAFE_PATH',
      'Lifecycle cache directory must be real.',
    );
  }
  const lock = join(cache, 'lock'),
    path = join(directory, `${parsed.operationId}.json`);
  const original = workLocked(lock, () => {
    const identity = { root, projectId: exchange.projectId, ...parsed };
    if (checkoutPathExists(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      invariant(
        canonicalPayload(saved.identity) === canonicalPayload(identity),
        'WORK_OPERATION_CHANGED',
        'Retry the original lifecycle command.',
      );
      return saved as {
        identity: typeof identity;
        saveOperationId: string;
        request: unknown | null;
        selection: HostedLaneCheckoutMarker['selection'];
      };
    }
    const marker = readHostedLaneCheckout(root);
    invariant(
      marker?.selection.projectId === exchange.projectId,
      'WORK_OPERATION_CHANGED',
      'Open this project’s Lane before changing its lifecycle.',
    );
    const saved = { identity, saveOperationId: randomUUID(), request: null, selection: marker.selection };
    durableReplace(path, canonicalPayload(saved));
    return saved;
  });
  for (const path of [join(cache, 'saves'), join(cache, 'saves', original.saveOperationId)]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    invariant(
      lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
      'UNSAFE_PATH',
      'Lifecycle save cache must be real.',
    );
  }
  let childProgress: Awaited<ReturnType<typeof saveHostedLane>> | null = null;
  if (original.request && parsed.action === 'abandon' && parsed.saveFirst)
    childProgress = await saveHostedLane(
      root,
      { operationId: original.saveOperationId, message: `Before abandon: ${parsed.reason}` },
      exchange,
    );
  if (!original.request) {
    const marker = readHostedLaneCheckout(root);
    invariant(
      marker?.selection.projectId === exchange.projectId,
      'WORK_OPERATION_CHANGED',
      'Open this project’s Lane before changing its lifecycle.',
    );
    const expected = {
      head: original.selection.head,
      version: original.selection.version,
      sourceVersion: original.selection.sourceVersion,
      lifecycleVersion: original.selection.lifecycleVersion,
    };
    let dirty = false;
    if (parsed.action === 'abandon') {
      const capture = await captureHostedSave(root, join(cache, 'saves', original.saveOperationId));
      invariant(
        canonicalPayload(capture.marker.selection) === canonicalPayload(original.selection),
        'WORK_STALE',
        'The retained lifecycle capture belongs to another Lane baseline.',
      );
      dirty = capture.changes.length > 0;
      invariant(
        !dirty || parsed.saveFirst,
        'LANE_DIRTY',
        'Lane has unsaved edits. Use saveFirst:true to save before abandoning.',
      );
      if (parsed.saveFirst) {
        childProgress = await saveHostedLane(
          root,
          { operationId: original.saveOperationId, message: `Before abandon: ${parsed.reason}` },
          exchange,
        );
        if ('outcome' in childProgress && childProgress.outcome.status === 'failed')
          return {
            phase: 'save' as const,
            operationId: parsed.operationId,
            saveOperationId: original.saveOperationId,
            progress: childProgress,
          };
      }
    }
    const request = hostedLifecycleRequestSchema.parse({
      operationId: parsed.operationId,
      action: parsed.action,
      reason: parsed.reason,
      authorityEpoch: original.selection.authority.epoch,
      target: {
        kind: 'lane',
        laneId: original.selection.laneId,
        expected,
        dirty,
        saveOperationId: parsed.action === 'abandon' && parsed.saveFirst ? original.saveOperationId : null,
      },
    });
    original.request = workLocked(lock, () => {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (saved.request) return saved.request;
      durableReplace(path, canonicalPayload({ ...original, request }));
      return request;
    });
  }
  const request = hostedLifecycleRequestSchema.parse(original.request);
  const result = hostedLifecycleResultSchema.parse(
    JSON.parse(
      await exchange.client.mutation(makeFunctionReference<'mutation'>('projectHostedLifecycle:transition'), {
        projectId: exchange.projectId,
        request: canonicalPayload(request),
      }),
    ),
  );
  // Only metadata advances. Dirty/newer local bytes and sparse materialization
  // stay untouched; a lost reply or old replay cannot rewind a later baseline.
  if (result.lane && request.target.kind === 'lane') {
    const target = request.target,
      lane = result.lane;
    workLocked(lock, () => {
      const marker = readHostedLaneCheckout(root);
      if (!marker || marker.selection.laneId !== target.laneId) return;
      const selection = marker.selection;
      if (
        selection.head !== lane.head ||
        selection.version !== lane.version - 1 ||
        selection.sourceVersion !== lane.sourceVersion ||
        selection.lifecycleVersion !== lane.lifecycleVersion - 1
      )
        return;
      const next = hostedLaneCheckoutMarkerSchema.parse({ ...marker, selection: { ...selection, ...lane } });
      durableReplace(join(root, '.forge/hosted-lane.json'), JSON.stringify(next));
    });
  }
  if (result.status === 'pending' && childProgress)
    return {
      phase: 'save' as const,
      operationId: parsed.operationId,
      saveOperationId: original.saveOperationId,
      progress: childProgress,
      lifecycle: result,
    };
  return { phase: 'lifecycle' as const, result };
}
