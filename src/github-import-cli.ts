// SPDX-License-Identifier: Apache-2.0
// `nforge import`: start or resume a pinned GitHub source import into a new hosted
// project and report the project and its readiness. The local journal keeps the
// original operation UUID and request, so a lost reply or a stopped worker is
// resumed with `--resume UUID`; the server re-checks the caller's current access
// on every start, resume and worker run.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { deploymentUrl, readAuth, resolveAuthToken } from './auth-store.js';
import { deadlineConvexClient, deadlineConvexSubscription } from './network-convex-client.js';
import { hostedActionError } from './hosted-action-error.js';
import { durableReplace } from './state/durability.js';
import { ForgeError, invariant } from './errors.js';

export const IMPORT_HELP = `nforge import <github-url|OWNER/NAME> [--ref BRANCH|TAG|SHA] [--name NAME] [--deployment URL] [--operation-id UUID] [--no-wait]
nforge import --resume OPERATION_UUID [--no-wait]

Imports one GitHub commit into a new hosted Forge project whose main is ready for Lanes.
The ref resolves once to a commit; resuming keeps that commit. Prints the project ID,
commit, readiness and the GitHub REST requests the import made, by who paid them.
`;
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const requestsSchema = z.object({
  user: z.number(),
  app: z.number(),
  server: z.number(),
  anonymous: z.number(),
  userWindow: z.object({ reset: z.number(), used: z.number(), limit: z.number() }).optional(),
});
const errorSchema = z.object({ code: z.string(), message: z.string(), retryAt: z.number().optional() });
const statusSchema = z.object({
  projectId: z.string(),
  commit: z.string(),
  phase: z.string(),
  completed: z.number(),
  total: z.number(),
  totalKnown: z.boolean(),
  bytes: z.number(),
  totalBytes: z.number(),
  submodules: z.number(),
  report: z.string(),
  error: errorSchema.nullable(),
  githubRequests: requestsSchema.nullable().optional(),
});
const progressSchema = z.object({
  projectId: z.string(),
  phase: z.string(),
  completed: z.number(),
  total: z.number(),
  error: errorSchema.nullable(),
});
const journalSchema = z.object({
  deployment: z.string(),
  url: z.string(),
  ref: z.string().nullable(),
  name: z.string().nullable(),
  operationId: z.string().regex(uuid),
  jobId: z.string().nullable(),
  startedAt: z.string(),
});
export type ImportJournal = z.infer<typeof journalSchema>;
type Status = z.infer<typeof statusSchema>;
type Progress = z.infer<typeof progressSchema>;
/** Finite RPCs plus one live subscription, closed when the wait ends. */
export type ImportClient = {
  action(name: string, args: Record<string, unknown>): Promise<unknown>;
  watch(
    id: string,
    onUpdate: (value: unknown) => void,
    onError: (error: Error) => void,
  ): { close(): Promise<void> };
};

export function importJournalDirectory() {
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'forge', 'imports');
}
function journalPath(directory: string, operationId: string) {
  invariant(uuid.test(operationId), 'BAD_ARGUMENT', 'Use an original operation UUID.');
  return join(directory, `${operationId.toLowerCase()}.json`);
}
export function readImportJournal(directory: string, operationId: string): ImportJournal | null {
  const path = journalPath(directory, operationId);
  if (!existsSync(path)) return null;
  return journalSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
function writeJournal(directory: string, journal: ImportJournal) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  durableReplace(journalPath(directory, journal.operationId), JSON.stringify(journal) + '\n');
}

/** The selected journal: a resume reads the original request; a new request with
 * a known operation UUID must repeat it exactly. */
export function selectImport(
  directory: string,
  input: {
    resume?: string;
    url?: string;
    ref?: string;
    name?: string;
    deployment?: string | undefined;
    operationId?: string;
  },
  now = () => new Date(),
): ImportJournal {
  if (input.resume) {
    const journal = readImportJournal(directory, input.resume);
    invariant(
      journal,
      'IMPORT_UNKNOWN',
      `No import ${input.resume} was started from this machine. Repeat the original nforge import with --operation-id ${input.resume}.`,
    );
    return journal;
  }
  invariant(input.url, 'BAD_ARGUMENT', IMPORT_HELP);
  invariant(
    input.deployment,
    'AUTH_REQUIRED',
    'Run nforge login DEPLOYMENT_URL first, or pass --deployment.',
  );
  const request = {
    deployment: deploymentUrl(input.deployment),
    url: input.url.trim(),
    ref: input.ref?.trim() || null,
    name: input.name?.trim() || null,
  };
  const operationId = (input.operationId ?? randomUUID()).toLowerCase();
  const previous = readImportJournal(directory, operationId);
  if (previous) {
    invariant(
      previous.deployment === request.deployment &&
        previous.url === request.url &&
        previous.ref === request.ref &&
        previous.name === request.name,
      'WORK_OPERATION_CHANGED',
      `Operation ${operationId} imported another request. Resume it with nforge import --resume ${operationId}, or start a new import without --operation-id.`,
    );
    return previous;
  }
  const journal = { ...request, operationId, jobId: null, startedAt: now().toISOString() };
  writeJournal(directory, journal);
  return journal;
}

const terminal = (phase: string) => phase === 'ready' || phase === 'error';
/** Waits on the owner's progress subscription (server writes push updates; no
 * timer, no polling) until the import is ready or failed, or `signal` aborts. */
export async function waitForImport(
  client: ImportClient,
  jobId: string,
  signal: AbortSignal,
  progress: (value: Progress) => void = () => {},
): Promise<Progress | null> {
  let subscription: { close(): Promise<void> } | undefined;
  let stop: (() => void) | undefined;
  try {
    return await new Promise<Progress | null>((resolve, reject) => {
      stop = () => resolve(null);
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) return stop();
      subscription = client.watch(
        jobId,
        value => {
          const parsed = progressSchema.safeParse(value);
          if (!parsed.success)
            return reject(new ForgeError('HOSTED_PROTOCOL_INVALID', 'Import progress changed shape.'));
          progress(parsed.data);
          if (terminal(parsed.data.phase)) resolve(parsed.data);
        },
        reject,
      );
    });
  } finally {
    if (stop) signal.removeEventListener('abort', stop);
    await subscription?.close();
  }
}

export function importReport(journal: ImportJournal, status: Status) {
  const ready = status.phase === 'ready';
  return {
    operationId: journal.operationId,
    importId: journal.jobId,
    deployment: journal.deployment,
    repository: journal.url,
    ref: journal.ref,
    projectId: status.projectId,
    commit: status.commit,
    phase: status.phase,
    ready,
    files: status.total,
    completed: status.completed,
    bytes: status.totalBytes,
    submodules: status.submodules,
    githubRequests: status.githubRequests ?? null,
    error: status.error,
    next: ready
      ? `nforge clone ${status.projectId} DIR --deployment ${journal.deployment}`
      : `nforge import --resume ${journal.operationId}`,
  };
}

/** Start (or replay) the import, then wait for readiness unless `wait` is false. */
export async function runGithubImport(
  client: ImportClient,
  directory: string,
  journal: ImportJournal,
  options: { wait: boolean; signal?: AbortSignal; log?: (line: string) => void },
) {
  const log = options.log ?? (() => {});
  let jobId: string;
  try {
    jobId = z.string().parse(
      await client.action('projectGithubImport:start', {
        operationId: journal.operationId,
        url: journal.url,
        ...(journal.ref ? { ref: journal.ref } : {}),
        ...(journal.name ? { name: journal.name } : {}),
      }),
    );
  } catch (error) {
    const failure = hostedActionError(error, 'import start');
    throw new ForgeError(failure.code, failure.message, failure.retryAt, {
      resume: `nforge import --resume ${journal.operationId}`,
      ...(failure.retryAt ? { retryAt: new Date(failure.retryAt).toISOString() } : {}),
    });
  }
  if (journal.jobId !== jobId) {
    journal = { ...journal, jobId };
    writeJournal(directory, journal);
  }
  log(
    JSON.stringify({
      operationId: journal.operationId,
      importId: jobId,
      resume: `nforge import --resume ${journal.operationId}`,
    }),
  );
  if (options.wait) {
    let last = '';
    await waitForImport(client, jobId, options.signal ?? new AbortController().signal, value => {
      const line = `${value.phase} ${value.completed}/${value.total}`;
      if (line !== last)
        log(
          JSON.stringify({
            at: new Date().toISOString(),
            phase: value.phase,
            completed: value.completed,
            total: value.total,
          }),
        );
      last = line;
    });
  }
  const status = statusSchema.parse(await client.action('projectGithubImport:status', { id: jobId }));
  return importReport(journal, status);
}

function convexImportClient(deployment: string): ImportClient {
  const token = resolveAuthToken(deployment);
  invariant(token, 'AUTH_REQUIRED', `Run nforge login ${deployment} first, or set FORGE_AUTH_TOKEN.`);
  const http = deadlineConvexClient(deployment, { logger: false });
  http.setAuth(token);
  return {
    action: (name, args) => http.action(makeFunctionReference<'action'>(name), args),
    watch(id, onUpdate, onError) {
      const live = deadlineConvexSubscription(deployment, { logger: false, unsavedChangesWarning: false });
      live.setAuth(async () => token);
      const unsubscribe = live.onUpdate(
        makeFunctionReference<'query'>('projectGithubImportProgress:current'),
        { id },
        onUpdate,
        onError,
      );
      return {
        async close() {
          try {
            unsubscribe();
          } finally {
            await live.close();
          }
        },
      };
    },
  };
}

export async function githubImportCli(
  args: string[],
  dependencies: { client?: (deployment: string) => ImportClient; directory?: string } = {},
) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      ref: { type: 'string' },
      name: { type: 'string' },
      deployment: { type: 'string' },
      'operation-id': { type: 'string' },
      resume: { type: 'string' },
      'no-wait': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(IMPORT_HELP);
    return undefined;
  }
  invariant(
    values.resume
      ? positionals.length === 0 && !values.ref && !values.name && !values['operation-id']
      : positionals.length === 1,
    'BAD_ARGUMENT',
    IMPORT_HELP,
  );
  const directory = dependencies.directory ?? importJournalDirectory();
  const journal = selectImport(directory, {
    ...(values.resume ? { resume: values.resume } : {}),
    ...(positionals[0] ? { url: positionals[0] } : {}),
    ...(values.ref ? { ref: values.ref } : {}),
    ...(values.name ? { name: values.name } : {}),
    ...(values['operation-id'] ? { operationId: values['operation-id'] } : {}),
    deployment: values.deployment ?? process.env.FORGE_DEPLOYMENT_URL ?? readAuth().defaultDeployment,
  });
  invariant(
    !values.resume || !values.deployment || deploymentUrl(values.deployment) === journal.deployment,
    'WORK_OPERATION_CHANGED',
    `Import ${journal.operationId} runs on ${journal.deployment}.`,
  );
  const client = (dependencies.client ?? convexImportClient)(journal.deployment);
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const report = await runGithubImport(client, directory, journal, {
      wait: !values['no-wait'],
      signal: controller.signal,
      log: line => process.stderr.write(line + '\n'),
    });
    if (report.error || (!values['no-wait'] && !report.ready)) process.exitCode = 1;
    return report;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
