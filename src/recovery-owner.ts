// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { deploymentUrl } from './auth-store.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { withQueueSlot } from './landing-queue.js';
import { WorkStore } from './work-store.js';
import { readHostState, updateHostState } from './host-binding.js';
import { restoreRecoverySource, type RecoveryTransport } from './recovery-source.js';
import { recoveryTransport } from './recovery-transport.js';
import { writeRecoveryState } from './recovery-state.js';
import {
  recoveryRequestSchema,
  recoverySelectionSchema,
  recoveryPreparationSchema,
  recoveryConnectionSchema,
  sameRecoveryPins,
  type RecoveryConnection,
  type RecoverySelection,
} from './recovery-protocol.js';
import { nativeReachable } from './native-reachable.js';
import { NativeSource } from './native-source.js';

type Coverage = Awaited<ReturnType<typeof restoreRecoverySource>>;
type State = {
  schema: 1;
  requestHash: string;
  selection: RecoverySelection;
  coverage?: Coverage;
  connection?: RecoveryConnection;
  workSha256?: string;
};
function normalize(input: unknown) {
  const request = recoveryRequestSchema.parse(input);
  return {
    ...request,
    url: deploymentUrl(request.url),
    ...(request.archivePath ? { archivePath: resolve(request.archivePath) } : {}),
    ...(request.cacheRoot ? { cacheRoot: resolve(request.cacheRoot) } : {}),
  };
}
function bind(root: string, connection: RecoveryConnection, deployment: string) {
  updateHostState(new WorkStore(root), state => {
    invariant(
      !state.binding ||
        (state.binding.projectId === connection.binding.projectId && state.binding.deployment === deployment),
      'HOST_ALREADY_BOUND',
      'Select this existing project’s recovered owner.',
    );
    state.binding = {
      ...state.binding,
      ...connection.binding,
      deployment,
      acceptanceOwner: connection.role === 'owner',
    };
  });
}
function checkedConnection(
  input: unknown,
  requestHash: string,
  role: 'owner' | 'client',
  operationId: string,
) {
  const receipt = recoveryConnectionSchema.parse(input);
  invariant(
    receipt.requestHash === requestHash && receipt.role === role && receipt.operationId === operationId,
    'WORK_OPERATION_CHANGED',
    'Replay the original recovery request and destination.',
  );
  return receipt;
}
function sameSelection(actual: RecoverySelection | null, expected: RecoverySelection) {
  invariant(
    actual && sameRecoveryPins(actual, expected),
    'WORK_STALE',
    'Hosted source, Work or authority changed. Original recovery pins and staged files are retained.',
  );
}

/** One explicit command restores saved work and reconnects this existing project.
 * Private staging and original pins survive interruption; no recorded command starts. */
export async function recoverOwner(target: string, input: unknown, supplied?: RecoveryTransport) {
  const request = normalize(input),
    parent = realpathSync(dirname(resolve(target))),
    root = join(parent, basename(resolve(target))),
    requestHash = digest(JSON.stringify({ root, request, role: 'owner' })),
    directory = join(parent, `.forge-recovery-${digest(root).slice(0, 12)}-${request.operationId}`),
    statePath = join(directory, 'state.json'),
    stage = join(directory, 'owner');
  invariant(
    !existsSync(root) || existsSync(statePath),
    'RESTORE_TARGET_EXISTS',
    'Choose a new recovery destination; existing work is preserved.',
  );
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  invariant(
    lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(),
    'INVALID_WORK_BACKUP',
    'Recovery staging must be a private real directory.',
  );
  const queued = await withQueueSlot(
    join(directory, 'queue'),
    async () => {
      const transport = supplied ?? recoveryTransport(request);
      let state: State | undefined = existsSync(statePath)
        ? JSON.parse(readFileSync(statePath, 'utf8'))
        : undefined;
      invariant(
        !state || (state.schema === 1 && state.requestHash === requestHash),
        'WORK_OPERATION_CHANGED',
        'Replay the original recovery request and destination.',
      );
      // Always recheck current authority before reading a cached receipt or using staged source.
      const prepared = recoveryPreparationSchema.parse(await transport.prepare());
      if (prepared.receipt) {
        const connection = checkedConnection(prepared.receipt, requestHash, 'owner', request.operationId);
        invariant(
          state?.coverage,
          'RECOVERY_STATE_UNAVAILABLE',
          'Keep the original recovery staging directory to resume.',
        );
        sameSelection(connection.selection, state.selection);
        state.connection = connection;
      } else {
        const selected = recoverySelectionSchema.parse(prepared.selection);
        invariant(
          selected.projectId === request.projectId,
          'INVALID_WORK_BACKUP',
          'Recovery selected another project.',
        );
        if (state) sameSelection(selected, state.selection);
        else {
          invariant(!existsSync(root), 'RESTORE_TARGET_EXISTS', 'Choose a fresh recovery destination.');
          state = { schema: 1, requestHash, selection: selected };
          writeRecoveryState(statePath, state);
        }
        if (!state.coverage) {
          state.coverage = await restoreRecoverySource(directory, stage, request, selected, transport);
          state.workSha256 = digest(new WorkStore(stage).snapshotBytes());
          writeRecoveryState(statePath, state);
        }
        const latest = recoveryPreparationSchema.parse(await transport.prepare());
        if (!latest.receipt) sameSelection(latest.selection, selected);
        state.connection = checkedConnection(
          await transport.reconnect(selected, requestHash, 'owner'),
          requestHash,
          'owner',
          request.operationId,
        );
      }
      writeRecoveryState(statePath, state);
      if (existsSync(root)) {
        const marker = join(new WorkStore(root).directory, 'recovery-owner.json');
        invariant(
          existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')).requestHash === requestHash,
          'RESTORE_TARGET_EXISTS',
          'The recovery destination now contains unrelated work; it remains unchanged.',
        );
      } else {
        const store = new WorkStore(stage);
        // Revalidate retained source and evidence after a lost reconnect reply;
        // the saved coverage report is an observation, never a validation cache.
        await restoreRecoverySource(directory, stage, request, state!.selection, transport);
        invariant(
          digest(store.snapshotBytes()) === state!.workSha256,
          'SOURCE_CHANGED',
          'Staged recovered Work changed; its files are retained.',
        );
        const source = new NativeSource(stage);
        for (const id of nativeReachable(store)) source.object(id);
        bind(stage, state!.connection!, request.url);
        writeRecoveryState(join(store.directory, 'recovery-owner.json'), state);
        // Reserve first, so a concurrent unrelated directory is never replaced.
        mkdirSync(root, { mode: 0o700 });
        try {
          renameSync(stage, root);
        } catch (error) {
          try {
            rmdirSync(root);
          } catch {
            /* Preserve concurrent files. */
          }
          throw error;
        }
      }
      return {
        restored: true,
        reconnected: true,
        root,
        operationId: request.operationId,
        connection: state!.connection,
        coverage: state!.coverage,
        staging: directory,
        message:
          'Recovered saved work and connected this directory as the existing project’s owner. No commands restarted.',
        undo: 'Use nforge recover ROOT client with a new operation to return this binding to an independent client role; all saved work is retained.',
      };
    },
    { anchor: directory },
  );
  return 'value' in queued ? queued.value : queued;
}

/** Explicitly reconnect an independent restore, or return the old machine as a
 * client. This only changes its local role; existing source/Work CAS still governs concurrent owners. */
export async function reconnectOwner(
  root: string,
  input: unknown,
  role: 'owner' | 'client',
  supplied?: RecoveryTransport,
) {
  const request = normalize(input),
    store = new WorkStore(root);
  invariant(store.native, 'BAD_ARGUMENT', 'Select an existing native owner directory.');
  const old = readHostState(store).binding;
  invariant(
    !old || (old.projectId === request.projectId && old.deployment === request.url),
    'HOST_ALREADY_BOUND',
    'Select this existing project’s owner directory.',
  );
  const requestHash = digest(JSON.stringify({ root: store.root, request, role })),
    transport = supplied ?? recoveryTransport(request),
    prepared = recoveryPreparationSchema.parse(await transport.prepare());
  const connection = prepared.receipt
    ? checkedConnection(prepared.receipt, requestHash, role, request.operationId)
    : checkedConnection(
        await transport.reconnect(recoverySelectionSchema.parse(prepared.selection), requestHash, role),
        requestHash,
        role,
        request.operationId,
      );
  bind(root, connection, request.url);
  return {
    reconnected: true,
    root: store.root,
    connection,
    message:
      role === 'client'
        ? 'This machine retains all saved work as an independent copy and no longer consumes canonical owner requests. Open current main with nforge exchange ROOT pull --target NEW_CLIENT_DIRECTORY.'
        : 'Connected this directory as the existing project’s owner. Concurrent source and Work remain subject to existing reconciliation and CAS.',
    undo: `Run nforge recover ROOT ${role === 'client' ? 'reconnect' : 'client'} with a new operation to change this local role.`,
  };
}
