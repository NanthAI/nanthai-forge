// SPDX-License-Identifier: Apache-2.0
import { join, resolve } from 'node:path';
import { hostedAgentAddressSchema, type HostedAgentAddress } from './hosted-agent-contract.js';
import { hostedAgentDirectory, readAgentJson } from './hosted-agent-journal.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { durableReplace } from './native-durability.js';
import { observeHostedRun, hostedWaitSchema } from './hosted-agent-observe.js';
import { observeHostedSubmissions } from './hosted-agent-submission-wait.js';
import { invariant } from './errors.js';
import { HostedAgentTransport } from './hosted-agent-transport.js';
/** Address selection precedes construction of native WorkStore/owner services. */
export function hostedAgentAddress(
  root: string,
  selected: Record<string, unknown>,
): HostedAgentAddress | null {
  const explicit = selected.url !== undefined || selected.projectId !== undefined;
  const marker = checkoutPathExists(join(root, '.forge', 'hosted-lane.json'))
    ? readHostedLaneCheckout(root)
    : null;
  let address: HostedAgentAddress | null = null;
  if (explicit) {
    const parsed = hostedAgentAddressSchema.safeParse({ url: selected.url, projectId: selected.projectId });
    invariant(parsed.success, 'BAD_ARGUMENT', 'Hosted agent addressing requires both url and projectId.');
    address = parsed.data;
  } else if (marker) address = { url: marker.url, projectId: marker.selection.projectId };
  else {
    const path = join(`${resolve(root)}.forge-client`, 'agent', 'address.json');
    if (checkoutPathExists(path)) address = hostedAgentAddressSchema.parse(readAgentJson(path));
  }
  if (address && marker)
    invariant(
      address.url === marker.url && address.projectId === marker.selection.projectId,
      'WORK_OPERATION_CHANGED',
      'The address differs from this hosted Lane checkout.',
    );
  return address;
}
export async function hostedAgentCli(
  root: string,
  action: string,
  selected: Record<string, unknown>,
  address: HostedAgentAddress,
  transport = new HostedAgentTransport(root, address),
) {
  const command = Object.fromEntries(
    Object.entries(selected).filter(([key]) => !['url', 'projectId', 'action'].includes(key)),
  );
  if (action === 'wait') {
    const selectedWait = hostedWaitSchema.parse(command);
    invariant(
      Boolean(selectedWait.runId) !== Boolean(selectedWait.operationIds?.length),
      'BAD_ARGUMENT',
      'Choose one run or hosted landing operationIds.',
    );
    const controller = new AbortController(),
      stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const response = await (selectedWait.runId ? observeHostedRun : observeHostedSubmissions)(
        transport,
        command,
        controller.signal,
        event => process.stdout.write(`${JSON.stringify(event)}\n`),
      );
      process.exitCode =
        response.result.status === 'timeout' ? 2 : response.result.status === 'cancelled' ? 130 : 0;
      return response;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
  const result = await transport.dispatch(action, command);
  // Retain only after an authorized successful response. An invalid/incomplete
  // address never silently turns into a local owner/listener dependency.
  durableReplace(join(hostedAgentDirectory(root), 'address.json'), JSON.stringify(address));
  return result;
}
