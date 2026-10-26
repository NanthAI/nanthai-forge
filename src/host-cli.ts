// SPDX-License-Identifier: Apache-2.0
import { rememberSourceAuthorityError } from './source-authority-client.js';
import { markAgentSyncPrepared, startAgentSyncWorker } from './agent-sync-worker.js';
import { hostProgress, type ProgressSink } from './host-progress.js';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeFunctionReference, type FunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { WorkStore } from './work-store.js';
import { deploymentUrl, readAuth, resolveAuthToken, savedCredential } from './auth-store.js';
import { coordinationClient } from './coordination-client.js';
import { ConvexExchange } from './exchange-client.js';
import type { ExchangeTransport } from './native-exchange.js';
import { prepareHostedSeed, seedHostedProject } from './hosted-seed.js';
import { readHostState, updateHostState, type HostState } from './host-binding.js';
import { ForgeError, invariant } from './errors.js';
export const HOST_HELP = `nforge host ROOT [--deployment URL] [--name NAME] [--visibility private|public] [--new] [--json] [--wait]
nforge host ROOT --delete-project PROJECT_ID --confirm SLUG [--deployment URL] [--allow-bound-project] [--json]
nforge host ROOT --listen
nforge host ROOT --status
nforge host ROOT --cutover-file REQUEST.json --dry-run|--apply
nforge host ROOT --cutover-pins
nforge host ROOT --source-authority '{"operationId":"UUID","expected":{"mode":"native-owner","epoch":0},"mode":"server"}'
nforge host ROOT --no-auto-sync | --auto-sync
nforge host ROOT --spend-command /absolute/executable | --no-spend-command
--listen consumes hosted acceptance requests every five seconds while running.
Run nforge login first (cli scope). Only missing source/Work objects are uploaded.
Source and records are seeded in bounded pages, then main is validated and selected.
--json streams progress and result events as JSON lines; --wait remains accepted for compatibility. Interrupted hosting resumes its original operation. An already bound owner needs --new to create another project.
`;
export interface HostingClient {
  mutation(ref: FunctionReference<'mutation'>, args: Record<string, unknown>): Promise<unknown>;
  action(ref: FunctionReference<'action'>, args: Record<string, unknown>): Promise<unknown>;
}
export type HostOptions = {
  deployment?: string;
  name?: string;
  visibility?: 'private' | 'public';
  new?: boolean;
  onProgress?: ProgressSink;
  deferBackfill?: boolean;
};
export async function hostProject(
  root: string,
  options: HostOptions,
  dependencies?: {
    client: HostingClient;
    exchange: (projectId: string, operationId: string) => ExchangeTransport;
  },
) {
  invariant(
    options.name === undefined || options.name.trim(),
    'BAD_ARGUMENT',
    'Use a non-empty hosted project name.',
  );
  const store = new WorkStore(root),
    original = readHostState(store);
  const selected =
    options.deployment ??
    original.hosting?.deployment ??
    original.binding?.deployment ??
    process.env.FORGE_DEPLOYMENT_URL ??
    readAuth().defaultDeployment;
  invariant(selected, 'AUTH_REQUIRED', 'Run nforge login DEPLOYMENT_URL with cli scope before hosting.');
  const deployment = deploymentUrl(selected);
  if (!dependencies) {
    invariant(
      resolveAuthToken(deployment),
      'AUTH_REQUIRED',
      'Run nforge login with cli scope before hosting.',
    );
    const saved = savedCredential(deployment);
    invariant(
      process.env.FORGE_AUTH_TOKEN !== undefined || !saved || saved.scope === 'cli',
      'AUTH_SCOPE_DENIED',
      'Run nforge login with --scope cli; this credential grants coordination only.',
    );
  }
  const pending = updateHostState<NonNullable<HostState['hosting']>>(store, state => {
    if (state.hosting) {
      const current = state.hosting;
      invariant(
        current.deployment === deployment &&
          (!options.name || options.name.trim() === current.name) &&
          (!options.visibility || options.visibility === current.visibility),
        'WORK_OPERATION_CHANGED',
        'Resume hosting with its original deployment, name and visibility.',
      );
      return structuredClone(current);
    }
    invariant(
      !state.binding || options.new,
      'HOST_ALREADY_BOUND',
      'This owner is already hosted. Use nforge host ROOT --status, or --new to create another project.',
    );
    const current = {
      operationId: randomUUID(),
      pushId: randomUUID(),
      initializeId: randomUUID(),
      deployment,
      name: options.name?.trim() ?? basename(store.root),
      visibility: options.visibility ?? ('private' as const),
      revision: store.revision(),
      currentFirst: false,
    };
    state.hosting = current;
    return structuredClone(current);
  });
  const save = () =>
    updateHostState(store, state => {
      if (!state.hosting && state.binding?.operationId === pending.operationId) return;
      invariant(
        state.hosting?.operationId === pending.operationId,
        'WORK_OPERATION_CHANGED',
        'Hosting operation changed.',
      );
      state.hosting = { ...pending };
    });
  let lastSaved = 0,
    lastPhase = '';
  const progress = hostProgress(event => {
    options.onProgress?.(event);
    if (
      event.phase !== lastPhase ||
      performance.now() - lastSaved >= 1000 ||
      event.objectsDone === event.objectsTotal
    ) {
      if (event.phase !== 'complete') {
        pending.progress = event;
        delete pending.errorCode;
        try {
          save();
        } catch (error) {
          // Counters are advisory; a concurrent Work transaction must not kill a
          // background transfer. Durable operation/source pins were saved first.
          if (!(error instanceof ForgeError && error.code === 'WORK_BUSY')) throw error;
        }
      }
      lastSaved = performance.now();
      lastPhase = event.phase;
    }
  });
  const heartbeat = setInterval(progress.emit, 2000);
  heartbeat.unref();
  try {
    progress.phase('preparing source and Work');
    // Pin before the first creation call; a lost creation reply can then resume
    // even if concurrent local work advances this owner in the meantime.
    await prepareHostedSeed(store, pending.revision, pending.pushId);
    const client = dependencies?.client ?? coordinationClient(deployment, process.env.FORGE_AUTH_TOKEN);
    progress.phase('creating hosted project');
    const created = (await client.mutation(makeFunctionReference<'mutation'>('projectHosting:create'), {
      operationId: pending.operationId,
      name: pending.name,
      visibility: pending.visibility,
    })) as { projectId: string; projectUrl: string };
    invariant(
      !pending.projectId || pending.projectId === created.projectId,
      'WORK_OPERATION_CHANGED',
      'Hosting account changed. Resume with the original nforge login account.',
    );
    pending.projectId = created.projectId;
    pending.projectUrl = created.projectUrl;
    save();
    const transport =
      dependencies?.exchange(created.projectId, pending.pushId) ??
      new ConvexExchange(deployment, process.env.FORGE_AUTH_TOKEN, created.projectId, pending.pushId, null);
    if (transport instanceof ConvexExchange) transport.uploadBatchSize = 100;
    const pushed = await seedHostedProject(
      store,
      {
        projectId: created.projectId,
        operationId: pending.pushId,
        revision: pending.revision,
      },
      client,
      transport,
      progress,
    );
    pending.backupId = pushed.backupId;
    save();
    progress.phase('initializing Work');
    await client.action(makeFunctionReference<'action'>('projectWorkActions:initialize'), {
      projectId: created.projectId,
      backupId: pushed.backupId,
      operationId: pending.initializeId,
    });
    progress.phase('building Work index');
    await client.action(makeFunctionReference<'action'>('projectWorkIndexActions:ensure'), {
      projectId: created.projectId,
    });
    const binding = {
      projectId: created.projectId,
      deployment,
      projectUrl: created.projectUrl,
      operationId: pending.operationId,
      name: pending.name,
      visibility: pending.visibility,
      backupId: pushed.backupId,
      ...(store.native ? { acceptanceOwner: true } : {}),
    };
    updateHostState(store, state => {
      invariant(
        state.hosting?.operationId === pending.operationId,
        'WORK_OPERATION_CHANGED',
        'Hosting operation changed.',
      );
      state.binding = binding;
      markAgentSyncPrepared(state, binding);
      delete state.hosting;
    });
    startAgentSyncWorker(store);
    progress.phase('complete');
    return {
      ...binding,
      hosted: true,
      uploadedObjects: pushed.uploadedObjects,
      uploadedBytes: pushed.uploadedBytes,
      message: `Hosted ${binding.name}: ${binding.projectUrl}`,
      nextSteps: [
        'nforge host ROOT --status',
        'nforge exchange ROOT push',
        'nforge coordination ROOT \'{"action":"sessions"}\'',
      ],
    };
  } catch (error) {
    if (pending.projectId) rememberSourceAuthorityError(store, error, pending.projectId);
    updateHostState(store, state => {
      if (state.hosting?.operationId === pending.operationId)
        state.hosting.errorCode = error instanceof ForgeError ? error.code : 'HOST_INTERRUPTED';
    });
    if (error instanceof ForgeError && error.code === 'WORK_STALE' && !pending.projectId)
      updateHostState(store, state => {
        if (state.hosting?.operationId === pending.operationId) delete state.hosting;
      });
    if (error instanceof ConvexError && error.data && typeof error.data === 'object') {
      const data = error.data as { code?: unknown; message?: unknown };
      if (typeof data.code === 'string' && typeof data.message === 'string')
        throw new ForgeError(data.code, data.message);
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
export { hostCli } from './host-command.js';
