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
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkStore } from './work-store.js';
import { invariant } from './errors.js';
import { reportedTokensSchema } from './making-of.js';
const binding = z.object({
  projectId: z.string(),
  deployment: z.url(),
  projectUrl: z.url(),
  operationId: z.uuid(),
  name: z.string(),
  visibility: z.enum(['private', 'public']),
  backupId: z.string(),
  autoSync: z.boolean().optional(),
  acceptanceOwner: z.boolean().optional(),
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
  acceptancePublications: z.record(z.string(), z.string()).optional(),
  acceptanceReceipts: z.record(z.string(), z.string()).optional(),
  binding: binding.optional(),
  hosting: hosting.optional(),
  pulls: z.record(z.string(), z.uuid()).optional(),
  push: push.optional(),
  pendingPushes: z.array(push).optional(),
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
  agentSync: z
    .object({
      sequence: z.number().int().nonnegative(),
      observations: z.record(z.string(), z.string()).optional(),
      pending: z.array(
        z.object({
          operationId: z.uuid(),
          projectId: z.string(),
          deployment: z.string(),
          activity: z.unknown(),
          metadata: z.string(),
        }),
      ),
    })
    .optional(),
});
export type HostState = z.infer<typeof schema>;
export type HostedBinding = z.infer<typeof binding>;
export function readHostState(store: WorkStore): HostState {
  const path = join(store.directory, 'hosted-binding.json');
  return existsSync(path) ? schema.parse(JSON.parse(readFileSync(path, 'utf8'))) : { schema: 1 };
}
/** Transport metadata lives alongside Work, serialized by its owner lock without changing Work revision. */
export function updateHostState<T>(store: WorkStore, update: (state: HostState) => T): T {
  return store.locked(() => {
    const state = readHostState(store),
      result = update(state);
    const path = join(store.directory, 'hosted-binding.json'),
      temporary = `${path}.${randomUUID()}`;
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(schema.parse(state)) + '\n');
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
    return result;
  });
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
