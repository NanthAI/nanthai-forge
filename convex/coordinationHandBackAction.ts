// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './server';
import { mayTakeLane } from './accessPolicy';
import { laneSession } from './projectLaneHolder';
import { readHostedRecord, requireWriteEpoch, writeHostedRecord } from './projectHostedRecords';
import { transitionLifecycle } from './projectHostedLifecycle';
import { sessionIdentity } from './projectSessionIdentity';
import { effectivePolicy } from '../src/autonomy-policy';
import { DECLINE_HAND_BACK, HAND_TO_AGENT, SET_IT_ASIDE } from '../src/coordination-hand-back';
import type { CoordinationCommand } from '../src/coordination-types';
import { invariant } from '../src/errors';
import { hostedLaneSchema } from '../src/hosted-lane';
import { sourceAuthority } from '../src/hosted-source-authority';
import { saveExpectedSchema } from '../src/hosted-save';

/** A hand-back releases the holder. A choice pins the handed-back save and cannot replace a later holder. */
export async function applyHandBackChoice(
  ctx: MutationCtx & { forgeDevice?: Doc<'cliCredentials'> | null },
  project: Doc<'hostedProjects'>,
  actor: string,
  handoff: Extract<CoordinationCommand, { kind: 'handoff' }>,
  operationId: string,
  choice: string,
  reason: string,
  at: number,
) {
  if (choice === DECLINE_HAND_BACK) return;
  const projectId = project._id;
  invariant(handoff.laneId, 'BAD_ARGUMENT', 'This hand-back has no Lane.');
  const record = await readHostedRecord(ctx, { projectId, actor, kind: 'lane', key: handoff.laneId });
  invariant(record, 'WORK_STALE', 'This hand-back’s Lane is no longer available.');
  const lane = hostedLaneSchema.parse(JSON.parse(record.value));
  invariant(
    mayTakeLane(actor, lane.actor, project.owner),
    'PROJECT_UNAVAILABLE',
    'Only this Lane’s person or the project owner may take it.',
  );
  const sessionId = await laneSession(ctx);
  const ownHolder = lane.holder?.actor === actor && lane.holder?.sessionId === sessionId;
  invariant(
    lane.state === 'active' && lane.head === handoff.head && (!lane.holder || ownHolder),
    'WORK_STALE',
    'This Lane changed after it was handed back. Open the Lane to see its current holder and saves.',
  );
  if (choice === HAND_TO_AGENT) return;
  invariant(
    ctx.forgeDevice?.scope !== 'coordination',
    'AUTH_SCOPE_DENIED',
    'This credential grants coordination only.',
  );
  const { epoch } = sourceAuthority(project);
  requireWriteEpoch(project, epoch);
  if (choice === SET_IT_ASIDE) {
    await transitionLifecycle(ctx, { projectId }, actor, {
      operationId,
      authorityEpoch: epoch,
      action: 'abandon',
      reason: reason || 'Set aside after hand-back',
      target: {
        kind: 'lane',
        laneId: lane.id,
        expected: saveExpectedSchema.parse(lane),
        dirty: false,
        saveOperationId: null,
      },
    });
    return;
  }
  if (ownHolder || effectivePolicy(project).accessIdentities?.laneHolders !== true) return;
  invariant(
    sessionId,
    'BAD_ARGUMENT',
    'Open the Lane with takeover:true or take it from a signed-in browser.',
  );
  await writeHostedRecord(ctx, {
    projectId,
    actor,
    authorityEpoch: epoch,
    expectedVersion: lane.version,
    record: {
      ...lane,
      version: lane.version + 1,
      holder: {
        actor,
        sessionId,
        since: at,
        lastSeen: at,
        change: {
          operationId,
          kind: 'takeover',
          by: actor,
          previous: null,
          ...(reason ? { reason } : {}),
          savedHead: lane.head,
        },
      },
    },
    overlap: { holderChanged: true, agent: null, session: sessionIdentity(sessionId, undefined, at) },
  });
}
