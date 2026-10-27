// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { z } from 'zod';
import { deploymentUrl, readAuth } from './auth-store.js';
import { coordinationClient, type CoordinationTransport } from './coordination-client.js';
import { readHostState, updateHostState, retirePendingHost } from './host-binding.js';
import { WorkStore } from './work-store.js';
import { ForgeError, invariant } from './errors.js';

type Project = {
  id: string;
  slug?: string;
  name: string;
  revision: number;
  currentBackup: string | null;
  removal?: 'trash' | 'deleting' | 'deleted';
  purgeBlocked?: 'R2_MAINTENANCE_DISABLED' | 'R2_PURGE_RETRY_EXHAUSTED';
};
const requestSchema = z.object({
  deployment: z.string(),
  projectId: z.string(),
  slug: z.string(),
  operationId: z.uuid(),
  expectedRevision: z.number().safe(),
  rejected: z.literal('WORK_STALE').optional(),
});
export type DeleteProjectOptions = {
  projectId: string;
  confirm: string;
  deployment?: string;
  allowBoundProject?: boolean;
  onProgress?: (message: string) => void;
};

/** Uses the same owner-only list and permanent-removal mutation as the browser. */
export async function deleteHostedProject(
  root: string,
  options: DeleteProjectOptions,
  dependencies?: {
    client: CoordinationTransport;
    pollAttempts?: number;
    pollIntervalMs?: number;
    wait?: (delay: number, signal: AbortSignal) => Promise<void>;
  },
) {
  const store = new WorkStore(root),
    initial = readHostState(store),
    binding = initial.binding,
    selected =
      options.deployment ??
      binding?.deployment ??
      initial.hosting?.deployment ??
      process.env.FORGE_DEPLOYMENT_URL ??
      readAuth().defaultDeployment;
  invariant(selected, 'AUTH_REQUIRED', 'Run nforge login DEPLOYMENT_URL with cli scope first.');
  const deployment = deploymentUrl(selected);
  invariant(
    options.allowBoundProject ||
      binding?.projectId !== options.projectId ||
      deploymentUrl(binding.deployment) !== deployment,
    'HOST_DELETE_BOUND_PROJECT',
    'This ROOT is bound to that project. Add --allow-bound-project to explicitly delete it.',
  );
  const signal = AbortSignal.timeout(90_000);
  const client =
      dependencies?.client ?? coordinationClient(deployment, process.env.FORGE_AUTH_TOKEN, { signal }),
    key = createHash('sha256')
      .update(JSON.stringify([deployment, options.projectId]))
      .digest('hex'),
    path = join(store.directory, `host-delete-${key}.json`);
  const saveRequest = (request: z.infer<typeof requestSchema>) => {
    const temporary = `${path}.${randomUUID()}`;
    writeFileSync(temporary, JSON.stringify(request) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, path);
    const directory = openSync(store.directory, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  };
  const readProject = async (): Promise<Project> => {
    let cursor: string | null = null;
    do {
      signal.throwIfAborted();
      const result = (await client.query(makeFunctionReference<'query'>('projectBackups:list'), {
        paginationOpts: { cursor, numItems: 100 },
      })) as { page: Project[]; isDone: boolean; continueCursor: string };
      const project = result.page.find(item => item.id === options.projectId);
      if (project) return project;
      if (result.isDone) break;
      invariant(
        result.continueCursor !== cursor,
        'HOST_DELETE_STATUS_FAILED',
        'Project list did not advance. Retry this command.',
      );
      cursor = result.continueCursor;
    } while (true);
    throw new ForgeError(
      'PROJECT_UNAVAILABLE',
      'This Forge project is unavailable with the current account.',
    );
  };
  try {
    let project = await readProject();
    invariant(
      project.slug && options.confirm === project.slug,
      'HOST_DELETE_CONFIRM_MISMATCH',
      'Use --confirm with the exact project slug: the last segment of the project URL.',
    );
    const request = store.locked(() => {
      if (existsSync(path)) {
        const saved = requestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
        const superseded =
          project.removal !== 'deleting' &&
          project.removal !== 'deleted' &&
          project.revision > saved.expectedRevision;
        invariant(
          saved.deployment === deployment &&
            saved.projectId === options.projectId &&
            (saved.rejected || superseded || saved.slug === options.confirm),
          'WORK_OPERATION_CHANGED',
          'Reconcile removal with the original project, deployment and slug.',
        );
        // An active newer revision proves the old delete could not have committed
        // and fences any still-in-flight request. This explicit retry may use fresh pins.
        if (!saved.rejected && !superseded) return saved;
      }
      const saved = {
        deployment,
        projectId: options.projectId,
        slug: options.confirm,
        operationId: randomUUID(),
        expectedRevision: project.revision,
      };
      saveRequest(saved);
      return saved;
    });
    const result = () => {
      const retired = updateHostState(store, state => {
        if (
          state.hosting?.projectId !== options.projectId ||
          deploymentUrl(state.hosting.deployment) !== deployment
        )
          return null;
        return retirePendingHost(state, 'project-deleted', request.operationId);
      });
      return {
        projectId: options.projectId,
        deployment,
        operationId: request.operationId,
        expectedRevision: request.expectedRevision,
        purgeComplete: true,
        pendingHostCleared: !!retired,
        project,
        message:
          'Project removed permanently; hosted tombstone confirmed. The local owner and binding are retained.',
      };
    };
    if (project.removal === 'deleted') return result();
    options.onProgress?.(
      `Permanent removal ${request.operationId}: submitting; retry this command to reconcile an interrupted outcome.`,
    );
    try {
      await client.mutation(makeFunctionReference<'mutation'>('projectLifecycle:permanentlyDelete'), {
        projectId: options.projectId,
        operationId: request.operationId,
        expectedRevision: request.expectedRevision,
      });
    } catch (error) {
      const code =
        error instanceof ForgeError
          ? error.code
          : error instanceof ConvexError && error.data && typeof error.data === 'object'
            ? error.data.code
            : undefined;
      // This definite server rejection had no effect. A later explicit invocation
      // may refresh its pins, even when another owner request has begun removal.
      if (code === 'WORK_STALE')
        store.locked(() => {
          const saved = requestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
          if (saved.operationId === request.operationId) saveRequest({ ...saved, rejected: 'WORK_STALE' });
        });
      throw error;
    }
    options.onProgress?.(
      `Permanent removal ${request.operationId}: requested; waiting for purge completion.`,
    );
    const pollAttempts = dependencies?.pollAttempts ?? 10;
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      project = await readProject();
      if (project.removal === 'deleted') return result();
      if (project.purgeBlocked)
        throw new ForgeError(
          project.purgeBlocked,
          project.purgeBlocked === 'R2_MAINTENANCE_DISABLED'
            ? `Project purge is blocked: set FORGE_R2_MAINTENANCE=1 on the backend, then retry this command to resume operation ${request.operationId}.`
            : `R2 purge stopped after repeated storage errors. Resolve the R2 storage failure, then retry this command to resume operation ${request.operationId}.`,
        );
      if (attempt + 1 < pollAttempts) {
        const delay = Math.min((dependencies?.pollIntervalMs ?? 2000) * 2 ** attempt, 10_000);
        if (dependencies?.wait) await dependencies.wait(delay, signal);
        else await sleep(delay, undefined, { signal });
      }
    }
    throw new ForgeError(
      'HOST_DELETE_PENDING',
      `Purge completion is not yet confirmed (${project.removal ?? 'active'}). Retry this command to resume operation ${request.operationId}.`,
    );
  } catch (error) {
    if (error instanceof ConvexError && error.data && typeof error.data === 'object') {
      const data = error.data as { code?: unknown; message?: unknown };
      if (typeof data.code === 'string' && typeof data.message === 'string')
        throw new ForgeError(data.code, data.message);
    }
    if (error instanceof ForgeError) throw error;
    throw new ForgeError(
      'HOST_DELETE_INTERRUPTED',
      'Permanent removal is not confirmed. Retry this exact command with the same ROOT to reconcile the saved operation.',
    );
  }
}

export function parseDeleteProjectOptions(flags: string[]): DeleteProjectOptions {
  const options: Partial<DeleteProjectOptions> = {};
  const seen = new Set<string>();
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    invariant(!seen.has(flag), 'BAD_ARGUMENT', `Use ${flag} only once.`);
    seen.add(flag);
    if (flag === '--allow-bound-project') options.allowBoundProject = true;
    else {
      invariant(
        ['--delete-project', '--confirm', '--deployment'].includes(flag),
        'BAD_ARGUMENT',
        'Use --delete-project ID --confirm SLUG [--deployment URL] [--allow-bound-project].',
      );
      const value = flags[++i];
      invariant(value && !value.startsWith('--'), 'BAD_ARGUMENT', `Provide a value for ${flag}.`);
      if (flag === '--delete-project') options.projectId = value;
      else if (flag === '--confirm') options.confirm = value;
      else options.deployment = value;
    }
  }
  invariant(options.projectId && options.confirm, 'BAD_ARGUMENT', 'Use --delete-project ID --confirm SLUG.');
  return options as DeleteProjectOptions;
}
