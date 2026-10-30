// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { HostedObjectStore } from './hosted-object-store.js';
import { hostedRecordSchema } from './hosted-records.js';
import {
  composePageSchema,
  composeLaneSchema,
  composeDependencySchema,
  type ComposeEntry,
} from './hosted-compose.js';
import { composeAgentSource } from './hosted-agent-source.js';
import { hostedAgentCommandSchemas } from './hosted-agent-contract.js';
import { invariant } from './errors.js';
import type { HostedAgentSession } from './hosted-agent-transport.js';
import type { SyncResult } from './hosted-sync.js';
/** A conflict may precede an unmerged input/dependency suffix. Keep every exact
 * original selection; finishing only the conflict draft would lose that suffix. */
export async function resolutionFinishSelection(session: HostedAgentSession, source: SyncResult) {
  const candidateId = source.resolution?.candidateId;
  if (!candidateId) return { laneId: source.lane.laneId };
  const candidate = hostedRecordSchema.options[3].parse(
    await session.query('projectHostedCompose:candidate', { candidateId }),
  );
  invariant(
    candidate.intentId === source.lane.intentId && candidate.result.status === 'conflict',
    'WORK_OPERATION_CHANGED',
    'Continue the original conflicted selection.',
  );
  const objects = new HostedObjectStore(
    join(`${session.root}.forge-client`, 'conflict-objects'),
    session.exchange,
  );
  const read = async (root: { sha256: string; size: number }) => {
    const entries: ComposeEntry[] = [],
      seen = new Set<string>();
    let pin: typeof root | null = root;
    while (pin) {
      invariant(!seen.has(pin.sha256), 'SOURCE_HASH_MISMATCH', 'Compose pages must advance.');
      seen.add(pin.sha256);
      const bytes = await objects.get(pin.sha256);
      invariant(bytes.length === pin.size, 'SOURCE_HASH_MISMATCH', 'Compose page size changed.');
      const page = composePageSchema.parse(JSON.parse(bytes.toString('utf8')));
      entries.push(...page.entries);
      pin = page.next;
    }
    return entries;
  };
  const inputs = (await read(candidate.inputs)).map(value => {
    const { laneId, head, version, sourceVersion, lifecycleVersion } = composeLaneSchema.parse(value);
    return { laneId, expected: { head, version, sourceVersion, lifecycleVersion } };
  });
  const dependencies = (await read(candidate.dependencies)).map(value => {
    const { candidateId, head } = composeDependencySchema.parse(value);
    return { candidateId, head };
  });
  if (inputs.length === 1 && !dependencies.length) return { laneId: source.lane.laneId };
  const resolved = {
    laneId: source.lane.laneId,
    expected: {
      head: source.lane.head,
      version: source.lane.version,
      sourceVersion: source.lane.sourceVersion,
      lifecycleVersion: source.lane.lifecycleVersion,
    },
  };
  if (!dependencies.length)
    return { intentId: candidate.intentId, inputs: [resolved, ...inputs], dependencies };
  // Dependencies compose before inputs: prepend the resolved prefix as a clean
  // dependency so their original conflict cannot recur before the resolution.
  const operationId = await session.journal.id('resolution-prefix');
  let progress = await composeAgentSource(
    session,
    hostedAgentCommandSchemas.compose.parse({ inputs: [resolved], message: 'Compose resolved prefix' }),
    operationId,
  );
  progress = await session.waitSource(operationId, progress, 'Compose');
  const outcome = (progress as { outcome?: { status: string; result?: unknown } }).outcome;
  if (outcome?.status !== 'completed')
    return { pending: { phase: 'compose', composeOperationId: operationId, progress } };
  const prefix = hostedRecordSchema.options[3].parse(outcome.result);
  invariant(prefix.result.status === 'clean', 'VIEW_CONFLICT', 'The resolved prefix must compose cleanly.');
  return {
    intentId: candidate.intentId,
    inputs,
    dependencies: [{ candidateId: prefix.id, head: prefix.result.head }, ...dependencies],
  };
}
