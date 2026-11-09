// SPDX-License-Identifier: Apache-2.0
import { networkTimeout } from './network-fetch.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { z } from 'zod';
import { authFile, deploymentUrl, readAuth } from './auth-store.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostedAgentAddress } from './hosted-agent-cli.js';
import { hostedAgentDirectory } from './hosted-agent-journal.js';
import { workLocked } from './work-lock.js';
import { coordinationClient, type CoordinationTransport } from './coordination-client.js';
import { readHostState, updateHostState, retirePendingHost } from './host-binding.js';
import { WorkStore } from './work-store.js';
import { ForgeError, invariant } from './errors.js';
import { syncDirectory } from './native-durability.js';
import { deriveProjectPhase } from './project-phase.js';

type Project = {
  id: string;
  slug?: string;
  name: string;
  revision: number;
  currentBackup: string | null;
  removal?: 'trash' | 'deleting' | 'deleted';
  purgeBlocked?: 'R2_MAINTENANCE_DISABLED' | 'R2_PURGE_RETRY_EXHAUSTED' | 'R2_PURGE_UNAUTHORIZED';
  retention?: { purgeAt: number; revoking?: boolean };
  purge?: { completedAt?: number };
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

/** Where the delete journal lives and which local binding it may retire. A Git or native ROOT
 * keeps both in its Work store. A hosted clone or Lane keeps the journal in its client cache and has
 * no binding. Any other directory (an address given with --deployment) uses the user's Forge
 * config directory. Neither of the last two needs Git. */
type Local = {
  directory: string;
  deployment?: string | undefined;
  binding?: { projectId: string; deployment: string } | undefined;
  locked<T>(run: () => T): T;
  retire(projectId: string, deployment: string, operationId: string): boolean;
};
function storeLocal(store: WorkStore): Local {
  const initial = readHostState(store);
  return {
    directory: store.directory,
    deployment: initial.binding?.deployment ?? initial.hosting?.deployment,
    binding: initial.binding,
    locked: run => store.locked(run),
    retire: (projectId, deployment, operationId) =>
      !!updateHostState(store, state =>
        state.hosting?.projectId !== projectId || deploymentUrl(state.hosting.deployment) !== deployment
          ? null
          : retirePendingHost(state, 'project-deleted', operationId),
      ),
  };
}
function journalLocal(directory: string, deployment?: string): Local {
  return {
    directory,
    deployment,
    locked: run => workLocked(join(directory, 'host-delete.lock'), run),
    retire: () => false,
  };
}
function deleteLocal(root: string, options: DeleteProjectOptions): Local {
  const hosted = ['hosted-main.json', 'hosted-lane.json'].some(name =>
    existsSync(join(root, '.forge', name)),
  );
  if (hosted) return journalLocal(hostedAgentDirectory(root), hostedAgentAddress(root, {})?.url);
  try {
    return storeLocal(new WorkStore(root));
  } catch (error) {
    // A plain directory is an address: --deployment names the deployment, the project id the project.
    if (!(error instanceof ForgeError && ['GIT_FAILED', 'NOT_REPOSITORY_ROOT'].includes(error.code)))
      throw error;
    invariant(
      options.deployment,
      'BAD_ARGUMENT',
      'ROOT is neither a Forge clone nor a Git worktree: pass --deployment URL to delete by address.',
    );
    const directory = join(dirname(authFile()), 'host-delete');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    return journalLocal(directory);
  }
}

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
  const local = deleteLocal(root, options),
    binding = local.binding,
    selected =
      options.deployment ??
      local.deployment ??
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
  const signal = networkTimeout(90_000);
  const client =
      dependencies?.client ?? coordinationClient(deployment, process.env.FORGE_AUTH_TOKEN, { signal }),
    key = createHash('sha256')
      .update(JSON.stringify([deployment, options.projectId]))
      .digest('hex'),
    path = join(local.directory, `host-delete-${key}.json`);
  const saveRequest = (request: z.infer<typeof requestSchema>) => {
    const temporary = `${path}.${randomUUID()}`;
    writeFileSync(temporary, JSON.stringify(request) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    renameSync(temporary, path);
    syncDirectory(local.directory);
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
    // Once removal has begun the server may clear the slug. The saved request is then the proof: this
    // exact project, deployment and slug were confirmed before, so a retry reconciles instead of failing.
    const resumed =
      (project.removal === 'deleting' || project.removal === 'deleted') &&
      local.locked(() => {
        if (!existsSync(path)) return false;
        const saved = requestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
        return (
          saved.deployment === deployment &&
          saved.projectId === options.projectId &&
          saved.slug === options.confirm
        );
      });
    invariant(
      resumed || (project.slug && options.confirm === project.slug),
      'HOST_DELETE_CONFIRM_MISMATCH',
      `Use --confirm with the exact project slug${project.slug ? ` (here: ${project.slug})` : ''}: the last segment of the project URL, as nforge clone prints it.`,
    );
    const request = local.locked(() => {
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
      const finalPhase = deriveProjectPhase(project, Date.now());
      const retired = local.retire(options.projectId, deployment, request.operationId);
      return {
        projectId: options.projectId,
        deployment,
        operationId: request.operationId,
        expectedRevision: request.expectedRevision,
        purgeComplete: true,
        pendingHostCleared: retired,
        project,
        phase: { state: finalPhase.state, label: finalPhase.label, nextStep: finalPhase.nextStep },
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
        confirm: request.slug,
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
        local.locked(() => {
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
      const phase = deriveProjectPhase(project, Date.now());
      if (phase.state === 'purge-blocked')
        throw new ForgeError(
          project.purgeBlocked!,
          `${phase.reason} ${phase.nextStep} To resume operation ${request.operationId}, retry this command.`,
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
