// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import { ConvexExchange } from './exchange-client.js';
import { CUTOVER_CLI_VERSION } from './cutover-version.js';
import { hostedContractFeatures } from './hosted-contract-features.js';
import { hostedAgentPlanningActions, type HostedAgentAddress } from './hosted-agent-contract.js';
import { backgroundSaveOperation } from './hosted-save-pending.js';
import { readHostedMainSelection } from './hosted-main-marker.js';
import { noteEarlyCapabilities } from './hosted-capabilities-carried-main.js';

/** The capability discovery request of an agent command (one read). `settling` names this
 * checkout's save that returned before its settle (fea47345 C); the reply carries its outcome. */
export function capabilityOptions(root: string): Record<string, unknown> {
  const settling = backgroundSaveOperation(root);
  return {
    // Named contract features (a83b6fd5): the reply lists the ones this server implements.
    features: [...hostedContractFeatures],
    noticeVersion: 1,
    resolveVersion: 1,
    overlapVersion: 1,
    overlapEvidenceVersion: 1,
    mirrorVersion: 1,
    metricReceiptVersion: 1,
    planningVersion: 1,
    defaultsVersion: 1,
    landingMessageVersion: 1,
    openLanesVersion: 1,
    ...(settling ? { settling } : {}),
  };
}

/** Actions whose first server call is capability discovery. Others (lists, board, policy, a clone's
 * own freshness status, landings) make their own first call, so nothing is read early for them. */
const discoveryFirst = new Set<string>([
  'start',
  'checkpoint',
  'sync',
  'status',
  'observe',
  'complete',
  'abandon',
  'compose',
  'resolve',
  ...hostedAgentPlanningActions,
]);
export function discoversCapabilitiesFirst(root: string, action: string, input: Record<string, unknown>) {
  if (!discoveryFirst.has(action)) return false;
  const parameters = Object.keys(input).filter(key => !['url', 'projectId', 'action'].includes(key));
  // A clone's bare status is answered from its own freshness read, with no discovery.
  return !(action === 'status' && parameters.length === 0 && readHostedMainSelection(root));
}

const key = (address: HostedAgentAddress, args: Record<string, unknown>) =>
  JSON.stringify([address.url, address.projectId, args]);
const started = new Map<string, Promise<unknown>>();

/** Lead decision (fea47345 round 3): after the command's arguments are valid, its capability read
 * runs alongside the installed CLI's release check instead of after it. It is the same read the
 * dispatch makes; that dispatch takes the reply (`takeEarlyCapabilities`), so a command makes no
 * extra call. A command that stops at the release gate (its child process on the new build runs it)
 * leaves one unused read. Nothing else reads the reply, and nothing is written before the gate. */
export function startEarlyCapabilities(root: string, address: HostedAgentAddress) {
  let exchange: ConvexExchange;
  try {
    exchange = new ConvexExchange(address.url, process.env.FORGE_AUTH_TOKEN, address.projectId, '', null);
  } catch {
    return; // No credential: the dispatch reports it in its own words.
  }
  const args = { clientVersion: CUTOVER_CLI_VERSION, ...capabilityOptions(root) };
  // Each command reads afresh: an earlier command's untaken read (it stopped at its gate) is replaced.
  const call = exchange.client
    .query(makeFunctionReference<'query'>('projectHostedAgent:capabilities'), {
      ...args,
      projectId: address.projectId,
    })
    .then(value => (typeof value === 'string' ? JSON.parse(value) : value));
  call.catch(() => undefined);
  started.set(key(address, args), call);
  // The release check reads main from this reply when it checks the same project (capabilities-main).
  noteEarlyCapabilities(address.url, address.projectId, call);
}

/** The early read of exactly this request, at most once. */
export function takeEarlyCapabilities(address: HostedAgentAddress, args: Record<string, unknown>) {
  const id = key(address, args);
  const call = started.get(id);
  started.delete(id);
  return call;
}
