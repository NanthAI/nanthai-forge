// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from 'node:util';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { digest } from './hash.js';
import { browserApproval } from './browser-approval.js';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { makeFunctionReference } from 'convex/server';
import { hostedAgentAddress } from './hosted-agent-address.js';
import { hostedAgentAddressSchema } from './hosted-address.js';
import { HostedAgentTransport } from './hosted-agent-transport.js';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import { hostedRunSubscription, type HostedRunSubscription } from './hosted-agent-observe.js';
import { ForgeError, invariant } from './errors.js';
import { parseHostedResponse } from './hosted-response.js';
const statusSchema = z.object({
  operationId: z.uuid(),
  status: z.enum(['waiting', 'processing', 'completed', 'failed']),
  repoId: z.number().nullable(),
  code: z.string().nullable(),
  /** What connect did about the mirror (absent from older servers). */
  mirror: z.enum(['enabled', 'kept']).nullable().optional(),
  /** Which way a mirror connect turned on (absent from older servers). */
  direction: z.enum(['one-way', 'two-way']).nullable().optional(),
});
/** `projectGithubMirrorRead:read`: the mirror in one sentence, the same words as the web Mirror screen. */
const mirrorReadSchema = z.object({
  repository: z.string().nullable(),
  direction: z.enum(['off', 'one-way', 'two-way']),
  state: z.string(),
  sentence: z.string(),
  next: z.string().nullable(),
});
/** One reactive observation of the existing connection operation, no polling or
 * scheduler. Closing the command closes the subscription and its connection. */
export async function waitForGithubConnection(
  address: HostedAgentTransport['address'],
  operationId: string,
  signal?: AbortSignal,
  subscribe: () => HostedRunSubscription = () => hostedRunSubscription(address),
) {
  const client = subscribe();
  let unsubscribe: (() => void) | undefined;
  let stop: (() => void) | undefined;
  try {
    return await new Promise<z.infer<typeof statusSchema> | { status: 'cancelled'; operationId: string }>(
      (resolve, reject) => {
        stop = () => resolve({ status: 'cancelled', operationId });
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) {
          stop();
          return;
        }
        unsubscribe = client.onUpdate(
          makeFunctionReference<'query'>('githubBindingStore:status'),
          { projectId: address.projectId, operationId },
          value => {
            try {
              const status = parseHostedResponse(
                statusSchema,
                typeof value === 'string' ? JSON.parse(value) : value,
              );
              invariant(
                status.operationId === operationId,
                'HOSTED_PROTOCOL_INVALID',
                'GitHub connection operation changed.',
              );
              if (status.status === 'completed' || status.status === 'failed') resolve(status);
            } catch (error) {
              reject(error);
            }
          },
          reject,
        );
      },
    );
  } finally {
    if (stop) signal?.removeEventListener('abort', stop);
    try {
      unsubscribe?.();
    } finally {
      await client.close();
    }
  }
}
type ProtectionTransport = Pick<HostedAgentTransport, 'action'>;
/** Two-way sync protection (A1): what GitHub enforces on main and, when a rule is missing, the
 * ruleset to import once. Read-only; a failed read is reported in the result, never hidden. */
export async function githubProtection(transport: ProtectionTransport, repository: string) {
  try {
    return await transport.action<Record<string, unknown>>('githubProtection:check', { repository });
  } catch (error) {
    const code = error instanceof ForgeError ? error.code : 'GITHUB_PROTECTION_UNAVAILABLE';
    return {
      repository,
      protected: null,
      error: code,
      advice: `Forge could not read the rules on ${repository} main (${code}${error instanceof Error ? `: ${error.message}` : ''}). Run nforge github status again; until it reads them, Forge cannot say whether GitHub merges wait for forge/verify.`,
    };
  }
}
/** Connection recovery belongs to CLI state, including when PROJECT is an opaque id. */
export function githubJournalRoot(address: { url: string; projectId: string }) {
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    'forge',
    'github',
    digest(JSON.stringify([address.url, address.projectId])),
  );
}
export async function githubConnectCli(
  args: string[],
  dependencies: {
    transport?: (root: string, address: HostedAgentTransport['address']) => HostedAgentTransport;
    subscribe?: () => HostedRunSubscription;
    approve?: typeof browserApproval;
  } = {},
) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      'one-way': { type: 'boolean' },
      repo: { type: 'string' },
      'project-id': { type: 'string' },
      'operation-id': { type: 'string' },
      'repo-id': { type: 'string' },
      cursor: { type: 'string' },
      'no-mirror': { type: 'boolean' },
      'no-browser': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help)
    return {
      usage:
        'nforge github connect|status|disconnect|resume PROJECT [--url DEPLOYMENT] [--repo OWNER/NAME] [--operation-id UUID] [--cursor CURSOR] [--no-mirror] [--no-browser]',
    };
  const [command, project] = positionals;
  invariant(
    project && positionals.length === 2 && ['connect', 'status', 'disconnect', 'resume'].includes(command!),
    'BAD_ARGUMENT',
    'Use nforge github connect|status|disconnect|resume PROJECT.',
  );
  if (command === 'disconnect')
    return {
      status: 'open-settings',
      next: 'Open this project in Forge → Settings → GitHub mirror → Disconnect. Only the owner person can confirm it there; this command changed nothing.',
    };
  const root = resolve(project);
  const address = values.url
    ? hostedAgentAddressSchema.parse({ url: values.url, projectId: values['project-id'] ?? project })
    : hostedAgentAddress(root, {});
  invariant(
    address,
    'BAD_ARGUMENT',
    'Pass --url DEPLOYMENT with the hosted project ID, or use a hosted checkout path.',
  );
  const journalRoot = githubJournalRoot(address);
  const transport =
    dependencies.transport?.(journalRoot, address) ?? new HostedAgentTransport(journalRoot, address);
  // Owner only: restarts a stopped mirror job (same cursor and State), re-points a mirror whose
  // repository changed, and posts a failed forge/verify status again. Safe to repeat.
  if (command === 'resume') return transport.mutation('projectGithubMirrorResume:resume', {});
  if (command === 'status') {
    const listed = await transport.query<unknown>('githubBindingStore:list', {
      cursor: values.cursor ?? null,
    });
    const bindings = typeof listed === 'string' ? JSON.parse(listed) : listed;
    const mirror = mirrorReadSchema.parse(await transport.query<unknown>('projectGithubMirrorRead:read', {}));
    const summary = {
      summary: mirror.sentence,
      mirror: {
        state: mirror.state,
        direction: mirror.direction,
        repository: mirror.repository,
        next: mirror.next?.replace(/ \. /, ` ${project} `) ?? null,
      },
    };
    // Two-way sync only: one read-only protection check of the mirrored repository.
    return mirror.direction === 'two-way' && mirror.repository
      ? { ...summary, ...bindings, protection: await githubProtection(transport, mirror.repository) }
      : { ...summary, ...bindings };
  }
  const capabilities = await transport.dispatch('capabilities', {});
  const actor = z.object({ actor: z.string() }).parse(capabilities.result).actor;
  let repository = values.repo;
  if (!repository) {
    const settings = await transport.query<{ configuration: { repository?: string } | null }>(
      'projectHostedCheckDefinitions:current',
      { checkId: '' },
    );
    const policy = await transport.query<{ githubMirror?: { repo: string } }>('projectAutonomy:read', {});
    repository = settings.configuration?.repository ?? policy.githubMirror?.repo;
  }
  if (!repository && process.stdin.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    try {
      repository = await prompt.question('GitHub repository (OWNER/NAME): ');
    } finally {
      prompt.close();
    }
  }
  invariant(repository, 'BAD_ARGUMENT', 'Pass --repo OWNER/NAME for the repository to connect.');
  const journal = new HostedAgentJournal(
    journalRoot,
    address,
    actor,
    'github-connect',
    { repository, ...(values['no-mirror'] ? { mirror: false } : {}) },
    values['operation-id'],
  );
  const result = await transport.exchange.client.action(
    makeFunctionReference<'action'>('githubBindingOAuth:connect'),
    {
      projectId: address.projectId,
      operationId: journal.operationId,
      repository,
      ...(values['no-mirror'] ? { mirror: false } : {}),
      ...(values['one-way'] && !values['no-mirror'] ? { oneWay: true } : {}),
    },
  );
  const started = z
    .object({ authorizeUrl: z.url(), status: z.string() })
    .parse(typeof result === 'string' ? JSON.parse(result) : result);
  process.stdout.write(`${JSON.stringify({ operationId: journal.operationId, ...started })}\n`);
  if (started.status === 'waiting')
    (dependencies.approve ?? browserApproval)(started.authorizeUrl, values['no-browser']);
  else process.stderr.write(`GitHub connection: ${started.status}; waiting for its result.\n`);
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const completed = await waitForGithubConnection(
      address,
      journal.operationId,
      controller.signal,
      dependencies.subscribe,
    );
    if (completed.status === 'failed')
      throw new ForgeError(
        'GITHUB_CONNECTION_FAILED',
        `GitHub connection failed (${completed.code}). Start a new operation to retry.`,
      );
    if (completed.status === 'cancelled') {
      process.exitCode = 130;
      return completed;
    }
    // The owner's authorization also turned the mirror on unless --no-mirror; say so, and how to undo.
    const mirror =
      completed.mirror === 'enabled'
        ? {
            mirror: `on: Forge publishes accepted main to ${repository}${completed.direction === 'one-way' ? '; pushes made on GitHub are not taken in (one-way)' : ' and brings GitHub pushes and pull requests back in'}. Pause or Disconnect in Forge → Settings → GitHub mirror (owner person).`,
          }
        : completed.mirror === 'kept'
          ? {
              mirror: 'unchanged: this project already has a GitHub mirror setting, connect did not touch it',
            }
          : { mirror: 'off: connected without the mirror (--no-mirror or an older server)' };
    // A1: the ruleset two-way sync relies on, checked at connect (read-only, Metadata read).
    return { ...completed, ...mirror, protection: await githubProtection(transport, repository) };
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
