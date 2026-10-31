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
import { withLaneCommand } from './lane-registry.js';
import { markerIdentity } from './lane-prune.js';
import { landSummary } from './hosted-land-summary.js';
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
  signal?: AbortSignal,
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
      // A waiting agent is alive: show it as running in its Lane (local file write, no network).
      const emit = (event: unknown) => process.stdout.write(`${JSON.stringify(event)}\n`);
      const response = await withLaneCommand(markerIdentity(root)?.laneId ?? undefined, 'wait', async () =>
        selectedWait.runId
          ? await observeHostedRun(transport, command, controller.signal, emit)
          : await observeHostedSubmissions(transport, command, controller.signal, emit),
      );
      process.exitCode =
        response.result.status === 'timeout' ? 2 : response.result.status === 'cancelled' ? 130 : 0;
      // The NDJSON stream stays machine-readable; the outcome also prints as plain stderr lines.
      const { submissions, status } = response.result as {
        submissions?: { submission: unknown }[];
        status: string;
      };
      if (!selectedWait.runId && status === 'terminal')
        for (const entry of submissions ?? [])
          for (const line of landSummary({
            result: { phase: 'finish', submission: entry.submission },
          } as never))
            process.stderr.write(`${line}\n`);
      return response;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
  const controller = new AbortController(),
    stop = () => controller.abort();
  if (!signal) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  let result;
  try {
    result = await transport.dispatch(action, command, signal ?? controller.signal);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  // Retain only after an authorized successful response. An invalid/incomplete
  // address never silently turns into a local owner/listener dependency.
  durableReplace(join(hostedAgentDirectory(root), 'address.json'), JSON.stringify(address));
  return result;
}
