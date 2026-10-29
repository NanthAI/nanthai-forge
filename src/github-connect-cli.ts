// SPDX-License-Identifier: Apache-2.0
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';
import { makeFunctionReference } from 'convex/server';
import { hostedAgentAddress } from './hosted-agent-cli.js';
import { HostedAgentTransport } from './hosted-agent-transport.js';
import { HostedAgentJournal } from './hosted-agent-journal.js';
import { hostedRunSubscription, type HostedRunSubscription } from './hosted-agent-observe.js';
import { ForgeError, invariant } from './errors.js';
const statusSchema = z.object({
  operationId: z.uuid(),
  status: z.enum(['waiting', 'processing', 'completed', 'failed']),
  repoId: z.number().nullable(),
  code: z.string().nullable(),
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
              const status = statusSchema.parse(typeof value === 'string' ? JSON.parse(value) : value);
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
export async function githubConnectCli(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      repo: { type: 'string' },
      'project-id': { type: 'string' },
      'operation-id': { type: 'string' },
      'repo-id': { type: 'string' },
      cursor: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help)
    return {
      usage:
        'nforge github connect|status|disconnect PROJECT [--url DEPLOYMENT] [--repo OWNER/NAME] [--operation-id UUID] [--repo-id ID] [--cursor CURSOR]',
    };
  const [command, project] = positionals;
  invariant(
    project && positionals.length === 2 && ['connect', 'status', 'disconnect'].includes(command!),
    'BAD_ARGUMENT',
    'Use nforge github connect|status|disconnect PROJECT.',
  );
  const root = resolve(project);
  const address = hostedAgentAddress(
    root,
    values.url ? { url: values.url, projectId: values['project-id'] ?? project } : {},
  );
  invariant(
    address,
    'BAD_ARGUMENT',
    'Pass --url DEPLOYMENT with the hosted project ID, or use a hosted checkout path.',
  );
  const transport = new HostedAgentTransport(root, address);
  if (command === 'status')
    return transport.query('githubBindingStore:list', { cursor: values.cursor ?? null });
  const capabilities = await transport.dispatch('capabilities', {});
  const actor = z.object({ actor: z.string() }).parse(capabilities.result).actor;
  if (command === 'disconnect') {
    const repoId = Number(values['repo-id']);
    invariant(
      Number.isSafeInteger(repoId) && repoId > 0,
      'BAD_ARGUMENT',
      'Pass --repo-id from github status.',
    );
    const journal = new HostedAgentJournal(
      root,
      address,
      actor,
      'github-disconnect',
      { repoId },
      values['operation-id'],
    );
    await transport.mutation('githubBindingStore:remove', { operationId: journal.operationId, repoId });
    return { operationId: journal.operationId, repoId, status: 'disconnected' };
  }
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
    root,
    address,
    actor,
    'github-connect',
    { repository },
    values['operation-id'],
  );
  const result = await transport.exchange.client.action(
    makeFunctionReference<'action'>('githubBindingOAuth:connect'),
    {
      projectId: address.projectId,
      operationId: journal.operationId,
      repository,
    },
  );
  const started = z
    .object({ authorizeUrl: z.url(), status: z.string() })
    .parse(typeof result === 'string' ? JSON.parse(result) : result);
  process.stdout.write(`${JSON.stringify({ operationId: journal.operationId, ...started })}\n`);
  const controller = new AbortController(),
    stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const completed = await waitForGithubConnection(address, journal.operationId, controller.signal);
    if (completed.status === 'failed')
      throw new ForgeError(
        'GITHUB_CONNECTION_FAILED',
        `GitHub connection failed (${completed.code}). Start a new operation to retry.`,
      );
    if (completed.status === 'cancelled') process.exitCode = 130;
    return completed;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
