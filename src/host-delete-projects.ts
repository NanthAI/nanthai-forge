// SPDX-License-Identifier: Apache-2.0
// `nforge host ROOT --delete-projects …` (Item 7456856f): prepare one bulk permanent-delete request, print the exact
// list and the owner's approval link, and exit. Nothing is deleted here: only the owner person approves, signed in on
// the web. `--wait ID` holds one subscription to the request until it is decided and every purge has ended (no polling);
// `--withdraw ID` ends an open request. Loaded only for this command, so other commands do not pay for it.
import { randomUUID } from 'node:crypto';
import { makeFunctionReference } from 'convex/server';
import { ConvexError } from 'convex/values';
import { deploymentUrl, readAuth } from './auth-store.js';
import { hostedAgentAddress } from './hosted-agent-address.js';
import { coordinationClient, coordinationCredentials } from './coordination-client.js';
import { deadlineConvexSubscription } from './network-convex-client.js';
import { networkTimeout } from './network-fetch.js';
import { shellQuote } from './shell-quote.js';
import { ForgeError, invariant } from './errors.js';

export type DeleteRequestProject = {
  projectId: string;
  slug: string;
  bytes: number;
  trash: boolean;
  lastLandingAt: number | null;
  outcome: 'started' | 'deleted' | 'failed' | 'changed' | 'refused' | 'kept' | null;
};
export type DeleteRequest = {
  id: string;
  status: 'requested' | 'approved' | 'declined' | 'withdrawn' | 'expired';
  selector: string;
  at: string;
  expiresAt: string;
  projects: DeleteRequestProject[];
  url: string | null;
  next: string;
  reason?: string;
};
type Selection = { glob: string } | { ids: string[] } | { trash: true };
type Parsed =
  | { kind: 'prepare'; select: Selection; deployment?: string }
  | { kind: 'wait' | 'withdraw'; id: string; deployment?: string };

export const DELETE_PROJECTS_HELP = `nforge host ROOT --delete-projects 'PATTERN' | --ids ID,ID… | --trash [--deployment URL] [--json]
nforge host ROOT --delete-projects --wait REQUEST_ID | --withdraw REQUEST_ID
  Prepares one request to delete many projects for good (at most 100): prints the exact list and the owner's approval
  link, and exits. Nothing is deleted until the owner person approves it once, signed in on the web; a project that
  changes after the list is made is skipped. --wait holds one subscription until the request is decided and every
  purge has ended.
`;

export function parseDeleteProjects(flags: string[]): Parsed {
  const rest = flags.filter(flag => flag !== '--delete-projects');
  const deploymentAt = rest.indexOf('--deployment');
  const deployment = deploymentAt >= 0 ? rest[deploymentAt + 1] : undefined;
  if (deploymentAt >= 0) {
    invariant(
      deployment && !deployment.startsWith('--'),
      'BAD_ARGUMENT',
      'Provide a value for --deployment.',
    );
    rest.splice(deploymentAt, 2);
  }
  const at = (flag: string) => rest.indexOf(flag);
  const value = (flag: string) => {
    const next = rest[at(flag) + 1];
    invariant(next && !next.startsWith('--') && rest.length === 2, 'BAD_ARGUMENT', DELETE_PROJECTS_HELP);
    return next;
  };
  const extra = deployment ? { deployment } : {};
  if (at('--wait') >= 0) return { kind: 'wait', id: value('--wait'), ...extra };
  if (at('--withdraw') >= 0) return { kind: 'withdraw', id: value('--withdraw'), ...extra };
  if (at('--trash') >= 0) {
    invariant(rest.length === 1, 'BAD_ARGUMENT', DELETE_PROJECTS_HELP);
    return { kind: 'prepare', select: { trash: true }, ...extra };
  }
  if (at('--ids') >= 0) {
    const ids = value('--ids')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);
    return { kind: 'prepare', select: { ids }, ...extra };
  }
  invariant(rest.length === 1 && !rest[0]!.startsWith('--'), 'BAD_ARGUMENT', DELETE_PROJECTS_HELP);
  return { kind: 'prepare', select: { glob: rest[0]! }, ...extra };
}

const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${Math.round(bytes / 1024)} KB`;
/** The request as a person reads it in a terminal: one line of totals, one per project, then the next steps. */
export function formatDeleteRequest(request: DeleteRequest, root: string) {
  const total = request.projects.reduce((sum, project) => sum + project.bytes, 0);
  const time = (iso: string) => iso.slice(11, 16);
  const lines = [
    `request ${request.id}  ${request.projects.length} ${request.projects.length === 1 ? 'project' : 'projects'}  ${size(total)}  ${request.status}  list frozen at ${time(request.at)} UTC, expires ${time(request.expiresAt)} UTC`,
    ...request.projects.map(
      project =>
        `  ${project.slug}  ${project.trash ? 'in the trash' : 'not in the trash'}  ${size(project.bytes)}  last landing ${project.lastLandingAt ? new Date(project.lastLandingAt).toISOString().slice(0, 10) : 'never'}${project.outcome ? `  ${project.outcome}` : ''}`,
    ),
  ];
  if (request.status === 'requested') {
    const command = `nforge host ${shellQuote(root)} --delete-projects`;
    lines.push(
      `approve   ${request.url ?? 'open Forge on the web, signed in as the owner'} (only the owner person, signed in on the web)`,
      `wait      ${command} --wait ${request.id}  (one subscription, no polling)`,
      `withdraw  ${command} --withdraw ${request.id}`,
    );
  } else lines.push(request.next);
  return `${lines.join('\n')}\n`;
}

const terminal = (request: DeleteRequest) =>
  request.status !== 'requested' &&
  (request.status !== 'approved' || request.projects.every(project => project.outcome !== 'started'));

function forgeError(error: unknown): never {
  if (error instanceof ConvexError && error.data && typeof error.data === 'object') {
    const data = error.data as { code?: unknown; message?: unknown };
    if (typeof data.code === 'string' && typeof data.message === 'string')
      throw new ForgeError(data.code, data.message);
  }
  throw error;
}

export async function deleteProjects(root: string, flags: string[], json: boolean) {
  const parsed = parseDeleteProjects(flags);
  const selected =
    parsed.deployment ??
    hostedAgentAddress(root, {})?.url ??
    process.env.FORGE_DEPLOYMENT_URL ??
    readAuth().defaultDeployment;
  invariant(selected, 'AUTH_REQUIRED', 'Run nforge login DEPLOYMENT_URL with cli scope first.');
  const deployment = deploymentUrl(selected);
  const done = (request: DeleteRequest) => {
    if (json) return { type: 'host-delete-request', ...request };
    process.stdout.write(formatDeleteRequest(request, root));
    return undefined;
  };
  try {
    if (parsed.kind === 'wait') return done(await waitForRequest(deployment, parsed.id));
    const client = coordinationClient(deployment, process.env.FORGE_AUTH_TOKEN, {
      signal: networkTimeout(90_000),
    });
    const text =
      parsed.kind === 'prepare'
        ? await client.mutation(makeFunctionReference<'mutation'>('projectDeleteRequests:prepare'), {
            operationId: randomUUID(),
            select: parsed.select,
          })
        : await client.mutation(makeFunctionReference<'mutation'>('projectDeleteRequests:withdraw'), {
            requestId: parsed.id,
          });
    return done(JSON.parse(text as string) as DeleteRequest);
  } catch (error) {
    return forgeError(error);
  }
}

/** One subscription until the request is decided and no purge is still running, or it expires. */
async function waitForRequest(deployment: string, id: string) {
  const credentials = coordinationCredentials(deployment, process.env.FORGE_AUTH_TOKEN);
  const live = deadlineConvexSubscription(credentials.url, { logger: false, unsavedChangesWarning: false });
  live.setAuth(async () => credentials.token);
  let unsubscribe: (() => void) | undefined;
  let expiry: NodeJS.Timeout | undefined;
  try {
    return await new Promise<DeleteRequest>((resolve, reject) => {
      let last: DeleteRequest | undefined;
      unsubscribe = live.onUpdate(
        makeFunctionReference<'query'>('projectDeleteRequests:read'),
        { requestId: id },
        value => {
          try {
            last = JSON.parse(value as string) as DeleteRequest;
            if (terminal(last)) return resolve(last);
            if (last.status === 'requested' && !expiry)
              // An open request ends at its expiry without a write; one local timer says so (no polling).
              expiry = setTimeout(
                () =>
                  resolve({
                    ...last!,
                    status: 'expired',
                    next: 'This request expired. Nothing was deleted.',
                  }),
                Math.max(0, Date.parse(last.expiresAt) - Date.now()),
              );
            else if (last.status !== 'requested' && expiry) clearTimeout(expiry);
          } catch (error) {
            reject(error);
          }
        },
        reject,
      );
    });
  } finally {
    if (expiry) clearTimeout(expiry);
    unsubscribe?.();
    await live.close();
  }
}
