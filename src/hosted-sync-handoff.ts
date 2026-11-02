// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import { z } from 'zod';
import { makeFunctionReference } from 'convex/server';
import { syncResultSchema } from './hosted-sync.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { durableReplace } from './native-durability.js';
import { workLocked } from './work-lock.js';
import { applyHostedSync } from './hosted-sync-client.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';
import { hostedRecoveryCommand } from './hosted-agent-resolution.js';
import { invariant } from './errors.js';
import type { HostedAgentSession, HostedAgentExchange } from './hosted-agent-transport.js';

const handoffSchema = z.object({
  operationId: z.uuid(),
  applyOperationId: z.uuid(),
  action: z.enum(['sync', 'resolve']),
  command: z.record(z.string(), z.unknown()),
});
const pathFor = (root: string) => join(`${root}.forge-client`, 'sync-handoff.json');
const lockFor = (root: string) => join(`${root}.forge-client`, 'lock');
/** Retain installation ownership before submitting source IO. A deadline or lost
 * reply must not leave the next land using the old checkout pins. */
export async function retainSyncHandoff(
  session: HostedAgentSession,
  action: 'sync' | 'resolve',
  command: object,
) {
  const handoff = {
    operationId: session.journal.operationId,
    applyOperationId: await session.journal.id('sync-handoff-apply'),
    action,
    command: { ...command, operationId: session.journal.operationId },
  };
  workLocked(lockFor(session.root), () => {
    const path = pathFor(session.root);
    durableReplace(path, JSON.stringify(handoff));
  });
  return handoff;
}
export function clearSyncHandoff(root: string, operationId: string) {
  workLocked(lockFor(root), () => {
    const path = pathFor(root);
    if (checkoutPathExists(path) && JSON.parse(readFileSync(path, 'utf8')).operationId === operationId)
      rmSync(path);
  });
}
/** One exact progress read before a fresh land, only while an installation is
 * outstanding. No history scan, source substitution, observer or idle work. */
export async function reconcileHostedSync(root: string, exchange: HostedAgentExchange) {
  const path = pathFor(root);
  if (!checkoutPathExists(path)) return null;
  const handoff = handoffSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const progress = JSON.parse(
    await exchange.client.query(makeFunctionReference<'query'>('projectHostedSync:progress'), {
      projectId: exchange.projectId,
      operationId: handoff.operationId,
    }),
  );
  const outcome = progress.terminal?.outcome;
  const continuation = () => ({
    phase: 'sync',
    status: progress.status ?? progress.state?.status ?? 'pending',
    operationId: handoff.operationId,
    progress,
    next: { action: handoff.action, ...handoff.command },
    command: hostedRecoveryCommand(root, handoff.action, handoff.command),
  });
  if (outcome?.status === 'failed') {
    clearSyncHandoff(root, handoff.operationId);
    return { ...continuation(), source: progress.terminal };
  }
  if (outcome?.status !== 'completed') return continuation();
  const source = syncResultSchema.parse(outcome.result);
  // A sync conflict creates a sibling: its original sync continuation opens
  // that exact draft rather than trying to install it into the source Lane.
  if (source.status === 'conflict')
    return { phase: 'conflict', recovery: { ...continuation(), source: progress.terminal } };
  const marker = readHostedLaneCheckout(root);
  invariant(
    marker?.selection.laneId === source.lane.laneId,
    'WORK_OPERATION_CHANGED',
    'Apply source only in its original Lane.',
  );
  if (source.from)
    await applyHostedSync(
      root,
      {
        operationId: handoff.applyOperationId,
        url: marker.url,
        from: source.from,
        lane: source.lane,
        status: source.status,
      },
      new ConvexLaneTransport(exchange),
    );
  clearSyncHandoff(root, handoff.operationId);
  return null;
}
