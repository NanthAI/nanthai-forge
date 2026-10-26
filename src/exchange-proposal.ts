// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeFunctionReference } from 'convex/server';
import { z } from 'zod';
import { ConvexExchange } from './exchange-client.js';
import { pullNativeExchange } from './native-exchange.js';
import { WorkService } from './work.js';
import { invariant } from './errors.js';
const requestSchema = z
  .object({
    url: z.url(),
    projectId: z.string().min(1),
    proposalId: z.string().min(1),
    operationId: z.uuid(),
  })
  .strict();
export async function receiveProposal(root: string, input: unknown) {
  const request = requestSchema.parse(input);
  const transport = new ConvexExchange(
    request.url,
    process.env.FORGE_AUTH_TOKEN,
    request.projectId,
    '',
    null,
    false,
    request.proposalId,
  );
  const selected = (await transport.client.action(
    makeFunctionReference<'action'>('projectProposalObjects:details'),
    { proposalId: request.proposalId },
  )) as {
    projectKey: string;
    proposal: {
      projectId: string;
      operationId: string;
      intentId: string;
      baseState: string;
      head: string;
      viewId: string;
      digest: string;
      actor: string;
    };
  };
  invariant(
    selected.proposal.projectId === request.projectId,
    'PROJECT_CHANGED',
    'Select this project’s proposal.',
  );
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'forge-receive-proposal-')));
  try {
    const directory = join(scratch, 'proposal');
    await pullNativeExchange(request.proposalId, directory, transport, { exportOnly: true });
    const work = new WorkService(root);
    return await work.dispatch(
      {
        action: 'import-native-contribution',
        operationId: request.operationId,
        intentId: selected.proposal.intentId,
        expectedBase: selected.proposal.baseState,
        expectedHead: selected.proposal.head,
        archivePath: directory,
        archiveSha256: selected.proposal.digest,
        name: 'Contributor proposal',
        claim: {
          actor: selected.proposal.actor,
          projectKey: selected.projectKey,
          proposalId: request.proposalId,
          viewId: selected.proposal.viewId,
        },
      },
      work.store.revision(),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
