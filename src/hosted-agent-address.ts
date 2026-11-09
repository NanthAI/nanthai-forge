// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from 'node:path';
import { readSource } from './files.js';
import { clientCacheRoot } from './root-paths.js';
import { hostedAgentAddressSchema, type HostedAgentAddress } from './hosted-agent-contract.js';
import { hostedAgentRoot, readAgentJson } from './hosted-agent-journal.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { invariant } from './errors.js';

/** Address selection precedes construction of native WorkStore/owner services. */
export function hostedAgentAddress(
  root: string,
  selected: Record<string, unknown>,
): HostedAgentAddress | null {
  root = hostedAgentRoot(root);
  const explicit = selected.url !== undefined || selected.projectId !== undefined;
  const marker = checkoutPathExists(join(root, '.forge', 'hosted-lane.json'))
    ? readHostedLaneCheckout(root)
    : null;
  let address: HostedAgentAddress | null = null;
  if (explicit) {
    const parsed = hostedAgentAddressSchema.safeParse({
      url: selected.url,
      projectId: selected.projectId,
    });
    invariant(parsed.success, 'BAD_ARGUMENT', 'Hosted agent addressing requires both url and projectId.');
    address = parsed.data;
  } else if (marker) address = { url: marker.url, projectId: marker.selection.projectId };
  else {
    const path = join(clientCacheRoot(resolve(root)), 'agent', 'address.json');
    if (checkoutPathExists(path)) address = hostedAgentAddressSchema.parse(readAgentJson(path));
  }
  const mainBytes = !marker ? readSource(root, '.forge/hosted-main.json', Number.MAX_SAFE_INTEGER) : null;
  if (address && mainBytes)
    invariant(
      JSON.parse(mainBytes.toString()).selection.projectId === address.projectId,
      'PROJECT_UNAVAILABLE',
      'The address differs from this hosted main checkout.',
    );
  if (address && marker)
    invariant(
      address.url === marker.url && address.projectId === marker.selection.projectId,
      'WORK_OPERATION_CHANGED',
      'The address differs from this hosted Lane checkout.',
    );
  return address;
}
