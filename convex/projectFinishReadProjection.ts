// SPDX-License-Identifier: Apache-2.0
import { metricAttemptRow } from './projectMetricReadProjection';
import { digest } from '../src/state/hash';
import { canonicalPayload } from '../src/hosted-source-operation';
import { finishPendingForReader } from '../src/hosted-finish';
import type { Doc } from './_generated/dataModel';
/** Fields affecting the finite observer. In particular: no Work revision,
 * controller fences, wake identity, check progress, batch selection or restore bases. */
export const finishReadFields = {
  hostedProjects: ['owner', 'visibility', 'removal', 'sourceAuthority', 'name', 'key'],
  projectWorkGenerations: [
    'projectId',
    'backupId',
    'format',
    'status',
    'recordsGenerationId',
    'planningSearchVersion',
    'planRowsVersion',
    'planRowsOversized',
    'metadata',
  ],
  projectHostedLandingRequests: [
    'runnerAccounting',
    'hold',
    'requestBodyId',
    'capsule',
    'projectId',
    'submissionId',
    'operationId',
    'actor',
    'attemptId',
    'phase',
    'sequence',
    'channel',
    'value',
    'priority',
    'priorityReason',
    'priorityVersion',
    'wouldConflict',
    'runId',
    // A passed entry parked behind an older submission: the observe page names it (19328518).
    'orderWait',
    // ...and why: its hold reason and footprints, the waits so far (at most 8; written once per new
    // wait, so an unchanged wait re-sends nothing; ad80e037).
    'orderWaits',
  ],
  projectHostedFinishes: ['projectId', 'submissionId', 'value', 'composeOperationId', 'wake'],
  projectHostedLandingQueues: ['projectId', 'channel', 'status', 'lease', 'wake'],
  projectHostedLandingAttempts: [
    'projectId',
    'submissionId',
    'attemptId',
    'number',
    'sourceCreatedAt',
    'value',
  ],
  projectHostedCheckRuns: ['projectId', 'runId', 'value'],
  projectHostedChannels: ['projectId', 'name', 'selection'],
  projectHostedLandingDesired: [
    'runnerAccounting',
    'projectId',
    'submissionId',
    'operationId',
    'actor',
    'value',
  ],
} as const;
export type FinishReadKind = keyof typeof finishReadFields;
export function finishReadProjection(kind: FinishReadKind, row: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const key of finishReadFields[kind]) if (row[key] !== undefined) result[key] = row[key];
  if (kind === 'hostedProjects') {
    // A policy patch supplies the canonical value. Other patches carry the previous decision
    // forward, including its absence on a projection written before the decision was stored.
    if ('autonomyPolicy' in row) {
      const { autonomyPolicy } = row as Pick<Doc<'hostedProjects'>, 'autonomyPolicy'>;
      result.earlyResolutionEnabled = autonomyPolicy?.acceptance.earlyResolve !== 'off';
    } else if (typeof row.earlyResolutionEnabled === 'boolean') {
      result.earlyResolutionEnabled = row.earlyResolutionEnabled;
    }
  }
  if (kind === 'projectWorkGenerations' && typeof result.metadata === 'string') {
    try {
      // This Plan-only header selects a schema, never the Work metadata body.
      result.metadata = canonicalPayload({ schema: JSON.parse(result.metadata).schema ?? null });
    } catch {
      // Keep malformed legacy metadata exact; its existing reader handles it.
    }
  }
  if (kind === 'projectHostedLandingRequests' && row.capsule) {
    const { protocol, sha256, size, rawSize, version, tables } =
      row.capsule as import('../src/hosted-landing').LandingCapsulePointer;
    result.capsule = { protocol, sha256, size, rawSize, version, tables: '', tablesDigest: digest(tables) };
  }
  if (kind === 'projectHostedFinishes') {
    result.value = canonicalPayload({
      pending: finishPendingForReader(JSON.parse(row.value as string).pending),
    });
    delete result.wake;
    delete result.composeOperationId;
  }
  if (kind === 'projectHostedLandingQueues') {
    result.lease = row.lease ? { until: (row.lease as { until: number }).until } : null;
    result.wake = row.wake
      ? { taskId: (row.wake as { taskId: string }).taskId, at: (row.wake as { at: number }).at }
      : null;
  }
  if (kind === 'projectHostedLandingAttempts') {
    const attempt = JSON.parse(row.value as string);
    result.value = canonicalPayload({
      candidate: { head: attempt.candidate.head, inputs: attempt.candidate.inputs },
      metric: attempt.metric ?? metricAttemptRow(attempt),
    });
  }
  if (kind === 'projectHostedCheckRuns')
    result.value = canonicalPayload({ status: JSON.parse(row.value as string).status });
  if (kind === 'projectHostedChannels') {
    delete result.selection;
    result.head = row.selection === undefined ? row.head : JSON.parse(row.selection as string).head;
    result.channel = row.name ?? row.channel;
    delete result.name;
  }
  const selection: Omit<Doc<'projectFinishReadRows'>, '_id' | '_creationTime'> = {
    kind,
    sourceId: row._id as string,
    value: canonicalPayload(result),
  };
  for (const key of [
    'projectId',
    'submissionId',
    'operationId',
    'actor',
    'attemptId',
    'channel',
    'runId',
  ] as const)
    if (typeof row[key] === 'string') Object.assign(selection, { [key]: row[key] });
  if (kind === 'projectHostedLandingAttempts' && typeof row.sourceCreatedAt === 'number')
    selection.sourceCreatedAt = row.sourceCreatedAt;
  if (kind === 'projectHostedChannels') selection.channel = (row.name ?? row.channel) as string;
  return selection;
}

export function finishOwnerProjection(row: Record<string, unknown>) {
  return {
    kind: 'projectHostedFinishOwners',
    sourceId: row._id as string,
    projectId: row.projectId as Doc<'projectFinishReadRows'>['projectId'],
    submissionId: row.submissionId as string,
    value: canonicalPayload({
      composeOperationId: row.composeOperationId,
      wake: row.wake ? { at: (row.wake as { at: number }).at } : null,
    }),
  };
}

export function finishPeerProjection(row: Record<string, unknown>) {
  const state = JSON.parse(row.value as string);
  return {
    kind: 'projectHostedLandingPeers',
    sourceId: row._id as string,
    projectId: row.projectId as Doc<'projectFinishReadRows'>['projectId'],
    submissionId: row.submissionId as string,
    value: canonicalPayload({
      projectId: row.projectId,
      submissionId: row.submissionId,
      attemptId: row.attemptId,
      phase: row.phase,
      runId: row.runId ?? null,
      value: canonicalPayload({
        id: state.id,
        attemptId: state.attemptId,
        ...(state.batchId ? { batchId: state.batchId } : {}),
      }),
    }),
  };
}

export function finishAheadQueueProjection(row: Record<string, unknown>) {
  const status = row.status as { horizon: string[]; total: number } | undefined;
  return {
    kind: 'projectHostedAheadQueues',
    sourceId: row._id as string,
    projectId: row.projectId as Doc<'projectFinishReadRows'>['projectId'],
    channel: row.channel as string,
    value: canonicalPayload({ status: status ? { horizon: status.horizon, total: status.total } : null }),
  };
}

/** Plan needs the current Work pointer as well as the same transactional authority fields.
 * Keep that pointer out of the finite finish observer's dependency set. */
export function finishPlanProjectProjection(row: Record<string, unknown>) {
  const value: Record<string, unknown> = {};
  for (const key of [...finishReadFields.hostedProjects, 'work'])
    if (row[key] !== undefined) value[key] = row[key];
  if (value.work) {
    const { backupId, generationId, intentMigration } = value.work as NonNullable<
      Doc<'hostedProjects'>['work']
    >;
    value.work = {
      backupId,
      ...(generationId ? { generationId } : {}),
      ...(intentMigration ? { intentMigration } : {}),
    };
  }
  return {
    kind: 'projectPlanProjects',
    sourceId: row._id as string,
    projectId: row._id as Doc<'projectFinishReadRows'>['projectId'],
    value: canonicalPayload(value),
  };
}
