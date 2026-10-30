import { checkoutHostedLane } from './hosted-lane-checkout.js';
import { hostedLaneCheckoutSchema } from './hosted-lane-checkout-marker.js';
import { ConvexLaneTransport } from './hosted-lane-transport.js';

import { checkoutHostedMain } from './hosted-main-checkout.js';
import { mainExpectationSchema } from './hosted-main.js';
// SPDX-License-Identifier: Apache-2.0
import { rememberSourceAuthorityError } from './source-authority-client.js';
import { nativeOwner } from './native-source.js';
import { hostedActionError } from './hosted-action-error.js';

import { receiveProposal } from './exchange-proposal.js';

import { readFileSync } from 'node:fs';
import { migrateNativeArchive } from './native-exchange-migrate.js';
import { z } from 'zod';
import { ConvexExchange } from './exchange-client.js';
import { pullNativeExchange } from './native-exchange.js';
import { WorkStore } from './work-store.js';
import { ForgeError, invariant } from './errors.js';
import { CUTOVER_UPGRADE } from './cutover-version.js';
import { boundMainCheckout } from './bound-main-checkout.js';
export const mainPullSchema = z
  .object({
    url: z.url(),
    projectId: z.string().min(1),
    operationId: z.uuid(),
    expected: mainExpectationSchema.optional(),
  })
  .strict();
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
export const EXCHANGE_HELP = `nforge exchange ROOT pull [--target NEW_DIRECTORY]
Bound owners use stored deployment/project IDs.
Bound pull checks out selected hosted main into a client directory (or --target).
nforge exchange NEW_DIRECTORY open --command-file REQUEST.json
nforge exchange NEW_DIRECTORY open-lane --command-file REQUEST.json
nforge exchange NEW_DIRECTORY restore --command-file REQUEST.json
nforge exchange NEW_DIRECTORY pull --command-file REQUEST.json
nforge exchange ROOT receive-proposal --command-file REQUEST.json
nforge exchange NEW_DIRECTORY pull-proposal --command-file REQUEST.json
nforge exchange ROOT migrate-archive --command-file REQUEST.json
Run nforge login or set FORGE_AUTH_TOKEN to your current Forge sign-in JWT. Never put it in the request file.
Open/pull main: {url,projectId,operationId,expected?:{head,receiptId}}
Open-lane: {url,projectId,laneId,operationId,expected?:{head,sourceVersion,version},paths?:["path/or/directory"]}
Lane checkout is full by default; paths expands a sparse editing directory. Its marker retains the complete baseline. Dirty files are preserved.
Restore (legacy pull with backupId): {url,projectId,backupId,cacheRoot?,journalPath?}
Receive-proposal: {url,projectId,proposalId,operationId}
Pull-proposal: {url,projectId,proposalId,cacheRoot?}
Migrate-archive: {url,projectId,backupId,operationId,archivePath,originalDigest}
Migration preserves exact logical source/Work/artifact bytes and historical archive receipts, then retires exclusively owned compressed archive bytes after exact logical-byte and source-closure verification.
Restore creates an independent owner; cacheRoot reuses verified local source and journalPath overlays its journal.
History/source are preserved. No automatic deletion, archive generation, execution or Channel acceptance occurs.
`;
export async function exchangeCli(args: string[]) {
  if (args.includes('--help') || args[0] === 'help') {
    process.stdout.write(EXCHANGE_HELP);
    return;
  }
  const [root, action, option, file] = args;
  if (root && action === 'push') throw new ForgeError('CLI_UPGRADE_REQUIRED', CUTOVER_UPGRADE);
  if (
    root &&
    action === 'pull' &&
    (args.length === 2 || (args.length === 4 && option === '--target' && file))
  )
    return boundMainCheckout(root, file);
  invariant(
    root &&
      [
        'pull',
        'open',
        'open-lane',
        'restore',
        'pull-proposal',
        'receive-proposal',
        'migrate-archive',
      ].includes(action ?? '') &&
      option === '--command-file' &&
      file &&
      args.length === 4,
    'BAD_ARGUMENT',
    EXCHANGE_HELP,
  );
  return exchangeCommand(root, action!, JSON.parse(readFileSync(file, 'utf8')));
}
export async function exchangeCommand(root: string, action: string, input: unknown) {
  if (action === 'push') throw new ForgeError('CLI_UPGRADE_REQUIRED', CUTOVER_UPGRADE);
  try {
    return await executeExchangeCommand(root, action, input);
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
async function executeExchangeCommand(root: string, action: string, input: unknown) {
  if (action === 'open-lane') {
    const request = hostedLaneCheckoutSchema.parse(input);
    const exchange = new ConvexExchange(
      request.url,
      process.env.FORGE_AUTH_TOKEN,
      request.projectId,
      request.operationId,
      null,
    );
    return checkoutHostedLane(root, request, new ConvexLaneTransport(exchange));
  }
  if (action === 'open' || (action === 'pull' && mainPullSchema.safeParse(input).success)) {
    const request = mainPullSchema.parse(input);
    const transport = new ConvexExchange(
      request.url,
      process.env.FORGE_AUTH_TOKEN,
      request.projectId,
      request.operationId,
      null,
    );
    return checkoutHostedMain(root, request, transport);
  }
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
