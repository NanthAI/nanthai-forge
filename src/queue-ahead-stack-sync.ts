// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { readHostState } from './host-binding.js';
import { sourceAuthority } from './hosted-source-authority.js';
import { HostedAgentTransport } from './hosted-agent-transport.js';
import { hostedLandingStateSchema } from './hosted-landing.js';
import { hostedMainV2Schema } from './hosted-main.js';
import { NativeSource } from './native-source.js';
import { HostedObjectStore, cacheHostedState } from './hosted-object-store.js';
import { agentSync, type SyncCommand } from './agent-sync.js';
import type { WorkStore } from './work-store.js';

/** Bound native caches keep the same child-delta sync, but a server-owned parent
 * outcome and main must be read from the server before choosing a new target. */
export async function queueAheadStackSync(
  store: WorkStore,
  command: SyncCommand,
  native: () => ReturnType<typeof agentSync>,
  supplied?: HostedAgentTransport,
) {
  const stack = store.select('lanes', command.laneId)?.stack;
  const binding = readHostState(store).binding;
  if (!stack?.entryId || stack.detached || !binding || sourceAuthority(binding).mode !== 'server')
    return native();
  const transport =
    supplied ??
    new HostedAgentTransport(store.root, { url: binding.deployment, projectId: binding.projectId });
  const observed = await transport.query<{ request: unknown }>('projectHostedLanding:status', {
    submissionId: stack.entryId,
  });
  const parent = hostedLandingStateSchema.parse(observed.request);
  if (!['terminal-failed', 'landed'].includes(parent.phase)) return native();
  const main = hostedMainV2Schema.parse(await transport.query('projectHostedChannels:current', {}));
  await cacheHostedState(
    new NativeSource(store.root),
    new HostedObjectStore(join(store.directory, 'hosted-objects'), transport.exchange),
    main.head,
  );
  return agentSync(store, { ...command, ontoMain: true }, { target: main.head });
}
