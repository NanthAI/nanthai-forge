// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { ConvexExchange } from './exchange-client.js';
import { receiveProposal } from './exchange-proposal.js';
import { migrateNativeArchive } from './native-exchange-migrate.js';
import { pullNativeExchange } from './native-exchange.js';
import { nativeOwner } from './native-source.js';
import { rememberSourceAuthorityError } from './source-authority-client.js';
import { hostedActionError } from './hosted-action-error.js';
import { WorkStore } from './work-store.js';

/** Native-owner exchange: restore (and the legacy backupId pull), proposals and older-archive
 * migration. Hosted checkout (open, open-lane, main pull) stays in exchange-cli.ts. */
const shared = { url: z.url(), projectId: z.string().min(1) };
export const exchangeMigrateSchema = z
  .object({
    ...shared,
    backupId: z.string(),
    operationId: z.uuid(),
    archivePath: z.string(),
    originalDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const exchangePullSchema = z
  .object({
    ...shared,
    backupId: z.string().min(1),
    cacheRoot: z.string().optional(),
    journalPath: z.string().optional(),
  })
  .strict();

export async function nativeExchangeCommand(root: string, action: string, input: unknown) {
  try {
    return await executeNativeExchange(root, action, input);
  } catch (error) {
    const owner = nativeOwner(root);
    if (
      owner &&
      input &&
      typeof input === 'object' &&
      'projectId' in input &&
      typeof input.projectId === 'string'
    )
      rememberSourceAuthorityError(new WorkStore(owner), error, input.projectId);
    throw hostedActionError(error, `exchange ${action}`);
  }
}
async function executeNativeExchange(root: string, action: string, input: unknown) {
  if (action === 'receive-proposal') return receiveProposal(root, input);
  if (action === 'pull-proposal') {
    const request = z
      .object({ ...shared, proposalId: z.string().min(1), cacheRoot: z.string().optional() })
      .strict()
      .parse(input);
    const transport = new ConvexExchange(
      request.url,
      process.env.FORGE_AUTH_TOKEN,
      request.projectId,
      '',
      null,
      false,
      request.proposalId,
    );
    return pullNativeExchange(request.proposalId, root, transport, {
      ...(request.cacheRoot ? { cacheRoot: request.cacheRoot } : {}),
      exportOnly: true,
    });
  }
  if (action === 'migrate-archive') {
    const request = exchangeMigrateSchema.parse(input),
      transport = new ConvexExchange(
        request.url,
        process.env.FORGE_AUTH_TOKEN,
        request.projectId,
        request.operationId,
        null,
      );
    return migrateNativeArchive(
      request.archivePath,
      request.originalDigest,
      transport,
      request.backupId,
      request.operationId,
    );
  }

  const request = exchangePullSchema.parse(input),
    transport = new ConvexExchange(request.url, process.env.FORGE_AUTH_TOKEN, request.projectId, '', null);
  return pullNativeExchange(request.backupId, root, transport, request);
}
