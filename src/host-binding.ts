// SPDX-License-Identifier: Apache-2.0
import {
  statSync,
  existsSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sourceAuthoritySchema } from './hosted-source-authority.js';
import { cutoverPinsSchema } from './source-cutover.js';
import { z } from 'zod';
import { pushProgressSchema } from './push-progress-state.js';
import { autoExchangeStateSchema } from './auto-exchange-state.js';
import { exchangeObservationSchema } from './exchange-observation.js';
import { wakeAutoExchange } from './auto-exchange-wake.js';
import { workLocked } from './work-lock.js';
import { WorkStore } from './work-store.js';
import { invariant } from './errors.js';
import { agentSyncSchema, compactAgentSync } from './agent-sync-state.js';
import { reportedTokensSchema } from './making-of.js';
const binding = z.object({
  projectId: z.string(),
  deployment: z.url(),
  projectUrl: z.url(),
  operationId: z.uuid(),
  name: z.string(),
  visibility: z.enum(['private', 'public']),
  backupId: z.string(),
  workIndexPreparation: z.uuid().optional(),
  autoSync: z.boolean().optional(),
  acceptanceOwner: z.boolean().optional(),
  sourceAuthority: sourceAuthoritySchema.optional(),
  /** Local executable; never imported from portable Work policy. */
  spendCommand: z.string().refine(isAbsolute).optional(),
});
const hosting = z.object({
  operationId: z.uuid(),
  deployment: z.url(),
  name: z.string(),
  visibility: z.enum(['private', 'public']),
  revision: z.number().safe().nonnegative(),
  pushId: z.uuid(),
  initializeId: z.uuid(),
  projectId: z.string().optional(),
  projectUrl: z.url().optional(),
  backupId: z.string().optional(),
  currentFirst: z.boolean().optional(),
  ready: z.boolean().optional(),
  progress: z
    .object({
      type: z.literal('host-progress'),
      updatedAt: z.number(),
      phase: z.string(),
      elapsedMs: z.number(),
      phaseElapsedMs: z.number(),
      objectsDone: z.number(),
      objectsTotal: z.number(),
      bytesDone: z.number(),
      bytesTotal: z.number(),
      bytesPerSecond: z.number(),
      etaSeconds: z.number().nullable(),
    })
    .optional(),
  errorCode: z.string().optional(),
});
const push = z.object({
  authorityEpoch: z.number().safe().nonnegative().optional(),
  operationId: z.uuid(),
  projectId: z.string(),
  deployment: z.url(),
  previous: z.string().nullable(),
  revision: z.number().safe().nonnegative(),
  reconcileId: z.uuid().optional(),
  captureId: z.uuid().optional(),
  captureRevision: z.number().safe().nonnegative().optional(),
  needsBaseline: z.boolean().optional(),
  // Automatic rebase attempts after a known hosted CAS mismatch; IDs derive from parentId.
  parentId: z.uuid().optional(),
  attempt: z.number().int().min(1).max(3).optional(),
  returnSource: z
    .object({
      expectedBackupId: z.string(),
      revision: z.number().safe().nonnegative(),
      operationId: z.uuid(),
    })
    .optional(),
});
const schema = z.object({
  schema: z.literal(1),
  autoExchange: autoExchangeStateSchema.optional(),
  pushProgress: pushProgressSchema.optional(),
  exchangeObservation: exchangeObservationSchema.optional(),
  acceptancePublications: z.record(z.string(), z.string()).optional(),
  acceptanceReceipts: z.record(z.string(), z.string()).optional(),
  binding: binding.optional(),
  authorityTransition: z
    .object({
      projectId: z.string(),
      deployment: z.url(),
      operationId: z.uuid(),
      expected: sourceAuthoritySchema,
      mode: sourceAuthoritySchema.shape.mode,
      cutover: cutoverPinsSchema.optional(),
      ownerDrain: z.object({ revision: z.number().int().nonnegative(), fingerprint: z.string() }).optional(),
    })
    .optional(),
  hosting: hosting.optional(),
  hostingReceipts: z
    .array(
      z.object({
        pending: hosting,
        reason: z.enum(['abandoned', 'project-deleted']),
        at: z.string(),
        deletionOperationId: z.string().optional(),
      }),
    )
    .optional(),
  pulls: z.record(z.string(), z.uuid()).optional(),
  push: push.optional(),
  pendingPushes: z.array(push).optional(),
  supersede: z.object({ original: push, replacementId: z.uuid() }).optional(),
  supersededPushes: z.array(z.object({ original: push, replacementId: z.uuid() })).optional(),
  presence: z
    .record(
      z.string(),
      z.object({
        sessionId: z.string(),
        name: z.string(),
        environment: z.string(),
        status: z.string(),
        summary: z.string(),
        fingerprint: z.string().optional(),
        lastSeen: z.number(),
        lastActivity: z.number(),
        activityKind: z.string(),
        context: z.object({ laneId: z.string(), intentId: z.string(), head: z.string() }),
      }),
    )
    .optional(),
  /** Advisory self-reported harness/model/token totals per Lane session; the latest report replaces earlier totals. */
  selfReports: z
    .record(
      z.string(),
      z.object({
        operations: z.array(z.string()),
        laneId: z.string(),
        intentId: z.string(),
        name: z.string(),
        sessionId: z.string().optional(),
        harness: z.string().optional(),
        model: z.string().optional(),
        tokens: reportedTokensSchema.optional(),
        reportedAt: z.string(),
      }),
    )
    .optional(),
  agentSync: agentSyncSchema.optional(),
});
export type HostState = z.infer<typeof schema>;
export type HostedBinding = z.infer<typeof binding>;
export function readHostState(store: WorkStore): HostState {
  const path = join(store.directory, 'hosted-binding.json');
  const state = existsSync(path)
    ? schema.parse(JSON.parse(readFileSync(path, 'utf8')))
    : { schema: 1 as const };
  const queuePath = join(store.directory, 'hosted-agent-sync.json');
  if (existsSync(queuePath))
    state.agentSync = agentSyncSchema.parse(JSON.parse(readFileSync(queuePath, 'utf8')));
  return state;
}
/** Transport metadata shares a local lock, without changing Work revision.
 * Lifecycle queueing can skip the owner lock; other callers retain their existing guard.
 * The queue sidecar is authoritative once present, including during legacy migration. */
export function updateHostState<T>(
  store: WorkStore,
  update: (state: HostState) => T,
  options: { ownerLock?: boolean } = {},
): T {
  const apply = () =>
    workLocked(
      join(store.directory, 'hosted-binding.lock'),
      () => {
        const state = readHostState(store),
          result = update(state);
        if (state.agentSync) compactAgentSync(state.agentSync);
        const validated = schema.parse(state);
        const { agentSync, ...bindingState } = validated;
        // Write the sidecar before removing legacy pending entries from the binding.
        if (agentSync) writeChanged(store, 'hosted-agent-sync.json', agentSync);
        writeChanged(store, 'hosted-binding.json', {
          ...bindingState,
          ...(agentSync ? { agentSync: { ...agentSync, pending: [] } } : {}),
        });
        if (!agentSync) rmSync(join(store.directory, 'hosted-agent-sync.json'), { force: true });
        return result;
      },
      { operation: 'host transport metadata' },
    );
  const result = options.ownerLock === false ? apply() : store.locked(apply);
  wakeAutoExchange(store);
  return result;
}
function writeChanged(store: WorkStore, name: string, value: unknown) {
  const path = join(store.directory, name),
    bytes = JSON.stringify(value) + '\n';
  if (existsSync(path) && readFileSync(path, 'utf8') === bytes) return;
  const temporary = `${path}.${randomUUID()}`,
    fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(store.directory, 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function requireHostedBinding(store: WorkStore): HostedBinding {
  const state = readHostState(store);
  if (state.binding) return state.binding;
  invariant(
    !state.hosting,
    'HOST_INCOMPLETE',
    'Run nforge host ROOT to finish the pending hosting operation.',
  );
  invariant(false, 'HOST_NOT_BOUND', 'Run nforge login, then nforge host ROOT first.');
}

/** Cheap polling pin; transport observations do not change the Work revision. */
export function presenceRevision(store: WorkStore) {
  try {
    const stat = statSync(join(store.directory, 'hosted-binding.json'));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '';
  }
}

/** Called only under updateHostState's binding lock. Retain the original pins
 * so discarding local resume state never erases evidence of remote creation. */
export function retirePendingHost(
  state: HostState,
  reason: 'abandoned' | 'project-deleted',
  deletionOperationId?: string,
) {
  invariant(state.hosting, 'HOST_NOT_PENDING', 'There is no pending hosting operation.');
  const receipt = {
    pending: structuredClone(state.hosting),
    reason,
    at: new Date().toISOString(),
    ...(deletionOperationId ? { deletionOperationId } : {}),
  };
  (state.hostingReceipts ??= []).push(receipt);
  delete state.hosting;
  return receipt;
}
export function abandonPendingHost(store: WorkStore, operationId: string, confirm: string) {
  invariant(
    operationId === confirm,
    'HOST_ABANDON_CONFIRM_MISMATCH',
    'Use --confirm with the pending operation UUID shown by nforge host ROOT --status.',
  );
  return updateHostState(store, state => {
    if (!state.hosting) {
      const prior = state.hostingReceipts?.find(
        r => r.reason === 'abandoned' && r.pending.operationId === operationId,
      );
      invariant(prior, 'HOST_NOT_PENDING', 'There is no matching pending hosting operation.');
      return {
        ...prior,
        abandoned: true,
        message: 'Pending hosting operation abandoned; no hosted project was deleted.',
      };
    }
    invariant(
      state.hosting.operationId === operationId,
      'WORK_OPERATION_CHANGED',
      'The pending hosting operation changed. Read nforge host ROOT --status.',
    );
    return {
      ...retirePendingHost(state, 'abandoned'),
      abandoned: true,
      message: 'Pending hosting operation abandoned; no hosted project was deleted.',
    };
  });
}
