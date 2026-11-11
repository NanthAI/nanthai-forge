// SPDX-License-Identifier: Apache-2.0
import { rememberSourceAuthorityError } from './source-authority-client.js';
import { hostProgress, type ProgressSink } from './host-progress.js';
import { basename, join } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { initNative } from './native-work.js';
import { nativeOwner } from './native-source.js';
import { shellQuote } from './shell-quote.js';
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
  (ROOT: a Git worktree, an nforge clone or Lane, or any directory with --deployment; Git is not needed. SLUG is printed by nforge clone.)
nforge host ROOT --abandon-pending OPERATION_UUID --confirm OPERATION_UUID
nforge host ROOT --status
nforge host ROOT --abort-seed
nforge host ROOT --resume [--json]
nforge host ROOT --cutover-file REQUEST.json --dry-run|--apply
nforge host ROOT --cutover-pins
nforge host ROOT --source-authority '{"operationId":"UUID","expected":{"mode":"native-owner","epoch":0},"mode":"server"}'
Run nforge login first (cli scope). Only missing source/Work objects are uploaded.
Source and records are seeded in bounded pages, then main is validated and selected.
Plain directories get a local Forge-native bootstrap; Git is never invoked for them. New native hosts select server authority with their verified main in the final seed transaction; existing projects and interrupted older seeds keep their authority. Clone the printed project to start Lanes. Source capture uses the normal ignore rules and preserves file bytes and executable modes.
--json streams progress and result events as JSON lines; --wait remains accepted for compatibility. With no action, --json reads status only. --resume explicitly resumes interrupted hosting with its original operation. An already bound owner needs --new to create another project. --abort-seed discards a started seed's server-side progress (source bytes stay) so --resume seeds again from page 0.
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
  if (!existsSync(join(root, '.git')) && !nativeOwner(realpathSync(root))) initNative(root);
  const store = WorkStore.open<
      | 'commitRecords'
      | 'directory'
      | 'laneLocked'
      | 'load'
      | 'locked'
      | 'lockedAsync'
      | 'native'
      | 'observing'
      | 'page'
      | 'path'
      | 'pinnedBytes'
      | 'pinnedData'
      | 'pointer'
      | 'prepareCommitRecords'
      | 'prepareSave'
      | 'preparing'
      | 'publishSave'
      | 'readRecords'
      | 'records'
      | 'revision'
      | 'root'
      | 'save'
      | 'select'
      | 'snapshotBytes'
    >(root),
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
      Boolean(process.env.FORGE_AUTH_TOKEN) || !saved || saved.scope === 'cli',
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
      ...(store.native ? { serverAuthority: true as const } : {}),
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
    if (event.phase !== 'complete') {
      pending.progress = event;
      delete pending.errorCode;
    }
    if (
      event.phase !== lastPhase ||
      performance.now() - lastSaved >= 1000 ||
      event.objectsDone === event.objectsTotal
    ) {
      if (event.phase !== 'complete') {
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
  try {
    progress.phase('preparing source and Work');
    // Pin before the first creation call; a lost creation reply can then resume
    // even if concurrent local work advances this owner in the meantime.
    await prepareHostedSeed(store, pending.revision, pending.pushId, pending.serverAuthority);
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
        ...(pending.serverAuthority ? { serverAuthority: true } : {}),
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
    const binding = {
      projectId: created.projectId,
      deployment,
      projectUrl: created.projectUrl,
      operationId: pending.operationId,
      name: pending.name,
      visibility: pending.visibility,
      backupId: pushed.backupId,
      ...(store.native ? { acceptanceOwner: !pending.serverAuthority } : {}),
      ...(pending.serverAuthority ? { sourceAuthority: { mode: 'server' as const, epoch: 1 } } : {}),
    };
    updateHostState(store, state => {
      invariant(
        state.hosting?.operationId === pending.operationId,
        'WORK_OPERATION_CHANGED',
        'Hosting operation changed.',
      );
      state.binding = binding;
      delete state.hosting;
    });
    progress.phase('complete');
    return {
      ...binding,
      hosted: true,
      uploadedObjects: pushed.uploadedObjects,
      uploadedBytes: pushed.uploadedBytes,
      message: `Hosted ${binding.name}: ${binding.projectUrl}`,
      ...(pending.serverAuthority
        ? {
            changes: ['Forge-native source seeded; hosted main and project use server authority.'],
            undo: 'The original directory is preserved. Recover an independent owner from the hosted backup if needed.',
          }
        : {}),
      nextSteps: pending.serverAuthority
        ? [
            'nforge host ROOT --status',
            `nforge clone ${shellQuote(binding.projectUrl)} DIR --deployment ${shellQuote(deployment)}`,
            'nforge agent DIR start',
            'nforge coordination DIR \'{"action":"sessions"}\'',
          ]
        : [
            'nforge host ROOT --status',
            'nforge agent ROOT start',
            'nforge coordination ROOT \'{"action":"sessions"}\'',
          ],
    };
  } catch (error) {
    // Normalize before retaining the failure so status and stderr agree. Convex
    // application errors carry the useful code/message in data, not Error.message.
    if (error instanceof ConvexError && error.data && typeof error.data === 'object') {
      const data = error.data as { code?: unknown; message?: unknown };
      if (typeof data.code === 'string' && typeof data.message === 'string')
        error = new ForgeError(data.code, data.message);
    }
    if (!(error instanceof ForgeError) && error instanceof Error)
      error = new ForgeError(
        typeof (error as Error & { code?: unknown }).code === 'string'
          ? (error as Error & { code: string }).code
          : 'HOST_INTERRUPTED',
        `${lastPhase}: ${error.message || 'The server returned an error without a diagnostic message.'}`,
      );
    if (pending.projectId) rememberSourceAuthorityError(store, error, pending.projectId);
    updateHostState(store, state => {
      if (state.hosting?.operationId === pending.operationId) {
        state.hosting.errorCode = error instanceof ForgeError ? error.code : 'HOST_INTERRUPTED';
        if (pending.progress) state.hosting.progress = pending.progress;
      }
    });
    if (error instanceof ForgeError && error.code === 'WORK_STALE' && !pending.projectId)
      updateHostState(store, state => {
        if (state.hosting?.operationId === pending.operationId) delete state.hosting;
      });
    throw error;
  }
}
export { hostCli } from './host-command.js';
