// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
export const feedKinds = [
  'landing.landed',
  'landing.failed',
  'landing.cancelled',
  'check.passed',
  'check.failed',
  'lane.attention',
  'lane.saved',
  'lane.closed',
  'queue.moved',
] as const;

export const feedAttentionReasons = ['conflict', 'revert', 'stack', 'approval', 'note'] as const;
export type FeedAttentionReason = (typeof feedAttentionReasons)[number];
type LandingKind = (typeof feedKinds)[0 | 1 | 2];
type CheckKind = (typeof feedKinds)[3 | 4];
type Identity = { projectId: string; laneId: string };
type Landing = { operationId: string; submissionId: string };
export type StoredFeedEvent = Identity &
  (
    | ({ kind: LandingKind; receiptId?: string; code?: string; runId?: string } & Landing)
    | { kind: CheckKind; operationId: string; runId: string }
    | { kind: 'lane.attention'; noteId: string; reason: FeedAttentionReason }
    | { kind: 'lane.saved'; sourceVersion: number }
    | { kind: 'lane.closed'; recordVersion?: number }
  );
type FeedEvent = StoredFeedEvent | (Identity & Landing & { kind: 'queue.moved'; position: number });

export function feedEventId(event: FeedEvent): string {
  const { kind, laneId } = event;
  switch (kind) {
    case 'landing.landed':
    case 'landing.failed':
    case 'landing.cancelled':
      return [kind, event.submissionId, laneId].join(':');
    case 'check.passed':
    case 'check.failed':
      return [kind, event.runId, laneId].join(':');
    case 'lane.attention':
      return [kind, event.noteId].join(':');
    case 'lane.saved':
      return [kind, laneId, event.sourceVersion].join(':');
    case 'lane.closed':
      return event.recordVersion === undefined
        ? [kind, laneId].join(':')
        : [kind, laneId, event.recordVersion].join(':');
    case 'queue.moved':
      return [kind, event.submissionId, event.position].join(':');
  }
}

export function feedEventView<Project extends string>(
  event: FeedEvent & { projectId: Project; id: string; at: number },
) {
  const { kind, id, at, laneId } = event;
  const projectId: Project = event.projectId;
  const base = { v: 1 as const, id, at, projectId, laneId };
  switch (kind) {
    case 'landing.landed':
    case 'landing.failed':
    case 'landing.cancelled':
    case 'queue.moved': {
      const { operationId, submissionId } = event;
      return {
        ...base,
        kind,
        operationId,
        submissionId,
        ...(kind === 'queue.moved'
          ? { position: event.position }
          : {
              ...(event.receiptId ? { receiptId: event.receiptId } : {}),
              ...(event.code ? { code: event.code } : {}),
              ...(event.runId ? { runId: event.runId } : {}),
            }),
        resume: {
          action: 'wait' as const,
          input: { operationIds: [operationId], until: 'acceptance' as const },
        },
      };
    }
    case 'check.passed':
    case 'check.failed':
      return {
        ...base,
        kind,
        operationId: event.operationId,
        runId: event.runId,
        resume: { action: 'wait' as const, input: { runId: event.runId } },
      };
    case 'lane.attention':
      return {
        ...base,
        kind,
        noteId: event.noteId,
        reason: event.reason,
        resume: { action: 'board' as const, input: { laneId } },
      };
    case 'lane.saved':
    case 'lane.closed':
      return {
        ...base,
        kind,
        ...(kind === 'lane.saved' ? { sourceVersion: event.sourceVersion } : {}),
        resume: { action: 'status' as const, input: { laneId } },
      };
  }
}
