// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { makeFunctionReference } from 'convex/server';
import { canonicalRoot, clientCacheRoot } from './root-paths.js';
import { checkoutHostedMain, type MainTransport } from './hosted-main-checkout.js';
import { readHostedMainSelection } from './hosted-main-marker.js';
import { hostedMainSchema } from './hosted-main.js';
import { HostedCheckoutDownloads } from './hosted-checkout-downloads.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { hostedAgentDirectory, readAgentJson } from './hosted-agent-journal.js';
import { durableReplace } from './state/durability.js';
import { workLocked } from './work-lock.js';
import { ForgeError, invariant } from './errors.js';
import { shellQuote } from './shell-quote.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import type { HostedAgentExchange } from './hosted-agent-transport.js';
import { parseHostedResponse } from './hosted-response.js';

/** The marker chooses the protocol, never authorizes access. The selected API
 * checks current authority on every read; no discovery call or silent fallback. */
export function mainCheckoutTransport(
  root: string,
  address: HostedAgentAddress,
  exchange: HostedAgentExchange,
): MainTransport {
  const baseline =
    readHostedMainSelection(root) ?? readHostedMainSelection(join(clientCacheRoot(root), 'previous'));
  invariant(baseline, 'WORK_CONFLICT', 'Pull requires a Forge clone root; use nforge clone PROJECT DIR.');
  invariant(baseline.projectId === address.projectId, 'PROJECT_UNAVAILABLE', 'Select this clone’s project.');
  const api = baseline.schema === 2 ? 'projectHostedChannels:current' : 'projectMain:current';
  const calls = { queries: 0, mutations: 0, actions: 0 };
  const client = new Proxy(exchange.client, {
    get(target, key) {
      const counter =
        key === 'query' ? 'queries' : key === 'mutation' ? 'mutations' : key === 'action' ? 'actions' : null;
      if (!counter) return Reflect.get(target, key);
      return (...args: unknown[]) => {
        calls[counter]++;
        return (Reflect.get(target, key) as (...values: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const downloads = new HostedCheckoutDownloads({ ...exchange, client });
  return {
    current: async () => {
      const value = await client.query(makeFunctionReference<'query'>(api), {
        projectId: address.projectId,
        ...(baseline.schema === 1 ? { maxSchema: 2 } : {}),
      });
      return hostedMainSchema.parse(typeof value === 'string' ? JSON.parse(value) : value);
    },
    calls: () => ({ ...calls }),
    ...downloads.transport({ sourcePack: false }),
  };
}
const pendingSchema = z
  .object({
    url: z.url(),
    projectId: z.string(),
    operationId: z.uuid(),
    refresh: z.literal(true),
    complete: z.boolean(),
  })
  .strict();
/** A plain repeat resumes the same pinned installation after an interruption.
 * The address/operation journals live beside ROOT, outside the in-place publication. */
export async function pullHostedProject(
  root: string,
  address: HostedAgentAddress,
  transport: MainTransport,
  operationId?: string,
) {
  root = canonicalRoot(root);
  const directory = hostedAgentDirectory(root),
    path = join(directory, 'pull.json');
  const request = workLocked(join(directory, 'pull.lock'), () => {
    const pending = checkoutPathExists(path) ? pendingSchema.parse(readAgentJson(path)) : null;
    invariant(
      !pending || (pending.url === address.url && pending.projectId === address.projectId),
      'WORK_OPERATION_CHANGED',
      'Use this clone’s original address.',
    );
    if (pending && !pending.complete) {
      invariant(
        !operationId || operationId === pending.operationId,
        'WORK_OPERATION_CHANGED',
        'Re-run nforge pull with the pending operationId.',
      );
      return pending;
    }
    const next = {
      ...address,
      operationId: operationId ?? randomUUID(),
      refresh: true as const,
      complete: false,
    };
    durableReplace(path, JSON.stringify(next));
    return next;
  });
  try {
    const input = {
      url: request.url,
      projectId: request.projectId,
      operationId: request.operationId,
      refresh: true,
    };
    const result = await checkoutHostedMain(root, input, transport);
    workLocked(join(directory, 'pull.lock'), () => {
      if (pendingSchema.parse(readAgentJson(path)).operationId === request.operationId)
        durableReplace(path, JSON.stringify({ ...request, complete: true }));
    });
    return {
      ...result,
      operationId: request.operationId,
      transport: 'hosted' as const,
      cost: {
        convex: transport.calls?.() ?? null,
        downloadedBytes: result.downloadedBytes,
        downloadedObjects: result.downloadedObjects,
        fullSourcePack: false,
        budget:
          'Current: 1 query, 0 R2 GETs. Changed: 2 head queries + missing-object metadata in pages of 100; R2 GETs only for missing manifest/changed blobs (recipe chunks add pages/GETs). Idle: 0.',
      },
    };
  } catch (error) {
    if (error instanceof ForgeError && error.code === 'WORK_CONFLICT')
      throw new ForgeError(
        error.code,
        `${error.message} Move your local edits into a Lane created with nforge agent ${shellQuote(root)} start '{"outcome":"Keep local edits"}', then re-run nforge pull ${shellQuote(root)}.`,
        undefined,
        error.recovery,
      );
    throw error;
  }
}
export async function cloneFreshness(root: string, transport: Pick<MainTransport, 'current'>) {
  const marker = readHostedMainSelection(root);
  invariant(marker, 'WORK_CONFLICT', 'Status requires a Forge clone root.');
  const main = parseHostedResponse(hostedMainSchema, await transport.current());
  invariant(main.projectId === marker.projectId, 'PROJECT_UNAVAILABLE', 'Select this clone’s project.');
  const current = marker.head === main.head && marker.receipt.id === main.receipt.id;
  return {
    clone: {
      head: marker.head,
      receiptId: marker.receipt.id,
      mainHead: main.head,
      mainReceiptId: main.receipt.id,
      status: current ? 'current' : 'behind',
      // This is a source revision distance, not a count of accepted commits.
      sourceRevisionsBehind:
        marker.schema === 2 && main.schema === 2 && marker.authority.epoch === main.authority.epoch
          ? Math.max(0, main.sourceRevision - marker.sourceRevision)
          : null,
      next: current ? null : `nforge pull ${shellQuote(canonicalRoot(root))}`,
    },
  };
}
