// SPDX-License-Identifier: Apache-2.0
import { readSource } from './files.js';
import { clientCacheRoot } from './root-paths.js';
import { isNetworkPending } from './network-continuation.js';
import { join, resolve } from 'node:path';
import { hostedAgentAddressSchema, type HostedAgentAddress } from './hosted-agent-contract.js';
import { hostedAgentRoot, hostedAgentDirectory, readAgentJson } from './hosted-agent-journal.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';
import { durableReplace } from './native-durability.js';
import { observeHostedRun, hostedWaitSchema } from './hosted-agent-observe.js';
import { observeHostedSubmissions } from './hosted-agent-submission-wait.js';
import { invariant } from './errors.js';
import { withLaneCommand } from './lane-registry.js';
import { markerIdentity } from './lane-prune.js';
import { landSummary } from './hosted-land-summary.js';
import { AGENT_WAIT_SECONDS, operationWait } from './agent-operation-wait.js';
import { recordTurnWait, settleTurnWork } from './agent-turn-work.js';
import { HostedAgentTransport } from './hosted-agent-transport.js';
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
    const parsed = hostedAgentAddressSchema.safeParse({ url: selected.url, projectId: selected.projectId });
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
export async function hostedAgentCli(
  root: string,
  action: string,
  selected: Record<string, unknown>,
  address: HostedAgentAddress,
  transport = new HostedAgentTransport(root, address),
  signal?: AbortSignal,
) {
  root = hostedAgentRoot(root);
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
      // The resume command repeats the caller's own selection (and budget, if chosen).
      const continuation = operationWait(root, { ...selectedWait, ...address });
      const budgetSeconds = selectedWait.timeoutSeconds ?? AGENT_WAIT_SECONDS;
      const observed = { ...command, timeoutSeconds: budgetSeconds };
      // This session now waits on this work: its turn-end hook sees a live observer.
      recordTurnWait(root, continuation.next, process.pid);
      // Events stay internal: the caller gets one line when the budget or outcome returns.
      const response = await withLaneCommand(markerIdentity(root)?.laneId ?? undefined, 'wait', async () =>
        selectedWait.runId
          ? await observeHostedRun(transport, observed, controller.signal)
          : await observeHostedSubmissions(transport, observed, controller.signal),
      );
      const { submissions, status, run } = response.result as {
        submissions?: { submission: { phase?: string }; recovery?: unknown; conflict?: unknown }[];
        status: string;
        run?: { status?: string } | null;
      };
      if (status === 'timeout' || status === 'cancelled') {
        process.exitCode = status === 'timeout' ? 3 : 130;
        recordTurnWait(root, continuation.next, null);
        const { next, waitCommand, inProgress } = continuation;
        const resume = { next, command: waitCommand, waitCommand, inProgress };
        return {
          ...response,
          result: {
            status: 'IN_PROGRESS',
            reason: status === 'timeout' ? 'budget' : 'cancelled',
            budgetSeconds,
            ...(selectedWait.runId
              ? { runId: selectedWait.runId, phase: run?.status ?? 'unknown' }
              : {
                  operationIds: selectedWait.operationIds,
                  phase:
                    submissions?.length === 1 ? (submissions[0]!.submission.phase ?? 'unknown') : 'pending',
                }),
            ...resume,
          },
        };
      }
      process.exitCode = 0;
      settleTurnWork(selectedWait.runId ? [selectedWait.runId] : (selectedWait.operationIds ?? []));
      // A single-target wait exposes the same observed outcome as finish, while
      // retaining the complete selection below. Continuation consumers can follow
      // finish -> wait -> outcome without another read or a finish replay.
      const selected = submissions?.length === 1 ? submissions[0] : undefined;
      if (!selectedWait.runId && status === 'terminal')
        for (const entry of submissions ?? [])
          for (const line of landSummary({
            result: { phase: 'finish', ...entry },
          } as never))
            process.stderr.write(`${line}\n`);
      return { ...response, result: { ...response.result, ...selected } };
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
    if (isNetworkPending(result)) {
      const pending = result.result as { command: string };
      process.stderr.write(`IN PROGRESS; network response unavailable. Continue: ${pending.command}\n`);
      process.exitCode = 3;
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
  // Retain only after an authorized successful response. An invalid/incomplete
  // address never silently turns into a local owner/listener dependency.
  durableReplace(join(hostedAgentDirectory(root), 'address.json'), JSON.stringify(address));
  return result;
}
