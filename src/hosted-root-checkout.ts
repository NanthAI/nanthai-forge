// SPDX-License-Identifier: Apache-2.0
import { canonicalRoot, clientCacheRoot } from './root-paths.js';
import { basename, dirname, join } from 'node:path';
import { readSource } from './files.js';
import { hostedMainSchema } from './hosted-main.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { checkoutHostedLane } from './hosted-lane-checkout.js';
import { HostedCheckoutDownloads } from './hosted-checkout-downloads.js';
import { hostedLaneSelectionSchema } from './hosted-lane.js';
import { makeFunctionReference } from 'convex/server';
import { readAgentJson } from './hosted-agent-journal.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { touchNestedLane } from './client-cache-gc.js';
import { invariant } from './errors.js';
import type { z } from 'zod';
import type { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import type { HostedAgentAddress } from './hosted-agent-contract.js';
import type { HostedAgentExchange } from './hosted-agent-transport.js';
import { parseHostedResponse } from './hosted-response.js';
/** Main stays at ROOT; each editing directory and its receipt/lock lives beside it.
 * Single-Lane roots retain their original directory for that Lane. */
export function hostedRootLanePath(root: string, address: HostedAgentAddress): boolean;
export function hostedRootLanePath(root: string, address: HostedAgentAddress, laneId: string): string;
export function hostedRootLanePath(root: string, address: HostedAgentAddress, laneId?: string) {
  const bytes = readSource(root, '.forge/hosted-main.json', Number.MAX_SAFE_INTEGER);
  const main = bytes ? hostedMainSchema.parse(JSON.parse(bytes.toString()).selection) : null;
  const lane = main ? null : readHostedLaneCheckout(root);
  const bindingPath = join(clientCacheRoot(root), 'agent', 'address.json');
  if (main && checkoutPathExists(bindingPath)) {
    const binding = readAgentJson(bindingPath) as HostedAgentAddress;
    invariant(
      binding.url === address.url && binding.projectId === address.projectId,
      'WORK_OPERATION_CHANGED',
      'The address differs from this hosted main checkout.',
    );
  }
  if (main || lane)
    invariant(
      (main?.projectId ?? lane!.selection.projectId) === address.projectId &&
        (!lane || lane.url === address.url),
      'PROJECT_UNAVAILABLE',
      'Select this checkout’s hosted project.',
    );
  if (!laneId) return Boolean(main || lane);
  if (main) return join(clientCacheRoot(root), 'lanes', laneId);
  if (lane && lane.selection.laneId !== laneId) return laneSiblingPath(root, laneId);
  return root;
}
/** A Lane opened, started or resolved from another Lane's checkout is its sibling, never
 * nested in that checkout's own client directory (friction d184519f): beside it in the
 * clone's ROOT0.forge-client/lanes/ when it lives there; otherwise (a Lane folder at a
 * chosen path) a visible sibling folder `<folder>-<first 8 of laneId>`. */
export function laneSiblingPath(root: string, laneId: string) {
  const own = canonicalRoot(root),
    parent = dirname(own);
  return basename(parent) === 'lanes' && basename(dirname(parent)).endsWith('.forge-client')
    ? join(parent, laneId)
    : join(parent, `${basename(own)}-${laneId.slice(0, 8)}`);
}
export async function openHostedRootLane(
  root: string,
  address: HostedAgentAddress,
  exchange: HostedAgentExchange,
  command: z.infer<typeof hostedAgentCommandSchemas.open> & { operationId: string },
  /** Open here instead of the default placement; objects still come from ROOT's cache. */
  path = hostedRootLanePath(root, address, command.laneId),
) {
  const downloads = new HostedCheckoutDownloads(exchange);
  const opened = await checkoutHostedLane(
    path,
    { ...command, ...address },
    {
      ...downloads.transport(),
      select: async laneId => {
        const value = await exchange.client.query(
          makeFunctionReference<'query'>('projectHostedLanes:select'),
          {
            projectId: address.projectId,
            laneId,
          },
        );
        return parseHostedResponse(
          hostedLaneSelectionSchema,
          typeof value === 'string' ? JSON.parse(value) : value,
        );
      },
    },
    join(clientCacheRoot(root), 'objects'),
  );
  touchNestedLane(path);
  return opened;
}
