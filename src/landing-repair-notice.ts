// SPDX-License-Identifier: Apache-2.0
import { runDetails } from './work-detail-store.js';
import { digest } from './hash.js';
import { diagnosticCause } from './landing-observation.js';
import { noticeParticipant, type ConflictNotice } from './agent-conflict-notice.js';
import { PeersSource } from './agent-peers-source.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';
import type { ConflictEvidence } from './agent-repair-types.js';

/** Canonical retained diagnosis is the owner; inbox reads only project it. A lost
 * notification never loses evidence, and reading starts neither checks nor repair agents. */
export function landingRepairNotices(store: WorkStore, laneId?: string): ConflictNotice[] {
  if (!store.native) return [];
  const tx = store.readRecords();
  if (!tx) return [];
  const source = new PeersSource(store, '');
  const notices: ConflictNotice[] = [];
  const moves = Array.from({ length: tx.manifest.collections.channelMoves?.count ?? 0 }, (_, index) =>
    tx.at('channelMoves', index),
  );
  const currentMain = (channel: string) =>
    moves.filter(move => move.channel === channel && move.status === 'accepted').at(-1)?.head ?? null;
  const add = (
    run: CheckRun,
    main: string,
    evidence: Extract<ConflictEvidence, { kind: 'check' }>,
    current: boolean,
    repairIntentId?: string,
  ) => {
    if (laneId && !run.inputs.some(pin => pin.laneId === laneId)) return;
    const participants = run.inputs.flatMap(pin => {
      const lane = tx.fields('lanes', pin.laneId)?.record;
      return lane ? [noticeParticipant(store, source, { ...lane, head: pin.head })] : [];
    });
    if (!participants.length) return;
    notices.push({
      noticeId: digest(JSON.stringify(['landing-check-notice-v1', run.id])),
      kind: 'conflict-notice',
      granularity: 'symbol',
      participants,
      proposedOrder: [],
      choices: [],
      conflicts: [],
      evidence: [evidence],
      applicability:
        current &&
        tx.fields('checks', run.check.id)?.record.definition === run.check.definition &&
        participants.every(p => tx.fields('lanes', p.lane)?.record.head === p.head)
          ? 'current'
          : 'historical',
      ...(repairIntentId ? { repairIntentId } : {}),
      reason: `Recorded check ${run.check.name} ${run.status} on Candidate ${run.viewId}, base ${main}; run ${run.id}. Inspect retained output and repair in a Lane, then compose and check the new Candidate. This records the pinned execution outcome, not standalone or minimal blame; infrastructure or unknown outcomes do not establish source failure.`,
    });
  };
  const evidence = (run: CheckRun, main: string): Extract<ConflictEvidence, { kind: 'check' }> => ({
    kind: 'check',
    source: 'forge-recorded',
    main,
    inputs: run.inputs,
    head: run.head,
    viewId: run.viewId,
    runId: run.id,
    checkId: run.check.id,
    definition: run.check.definition,
    environment: run.environment.fingerprint,
    status: run.status,
    errors: [run.details, ...(run.error ? [run.error.message] : [])],
    selection: {
      known: !!run.checkSelection,
      ...(run.checkSelection
        ? { scope: run.checkSelection.scope, tests: runDetails(store, run).checkSelection!.tests }
        : {}),
      ...(run.backend?.pin ? { plan: run.backend.pin } : {}),
    },
    logs: { operationId: run.id, streams: ['stdout', 'stderr'] },
    minimization: 'incomplete',
  });
  for (const batch of Array.from({ length: tx.manifest.collections.landingBatches?.count ?? 0 }, (_, index) =>
    tx.at('landingBatches', index),
  )) {
    // A terminal solo admission retains repair evidence without starting a
    // prefix diagnosis or manufacturing a failing combination.
    if (batch.admission && batch.status === 'completed') {
      const entry = tx.find('landingEntries', batch.entryIds[0]!)?.record;
      const prefix = batch.prefixes[0];
      const run = prefix && entry?.runId === prefix.runId ? tx.find('runs', prefix.runId)?.record : undefined;
      if (
        run &&
        ['failed', 'interrupted'].includes(entry!.status) &&
        run.viewId === prefix!.viewId &&
        run.head === prefix!.head
      ) {
        const cause = diagnosticCause(run);
        add(
          run,
          batch.base,
          { ...evidence(run, batch.base), ...(cause ? { cause } : {}) },
          currentMain(batch.channel) === batch.previous,
        );
      }
    }
    for (const node of batch.diagnosis?.nodes ?? []) {
      if (!['failed', 'interrupted', 'runner-unavailable', 'runner-budget-exhausted'].includes(node.status))
        continue;
      const run = tx.find('runs', node.runId)?.record;
      if (!run || run.viewId !== node.viewId || run.head !== node.head) continue;
      add(
        run,
        batch.base,
        { ...evidence(run, batch.base), ...(node.cause ? { cause: node.cause } : {}) },
        batch.status === 'completed' && currentMain(batch.channel) === batch.previous,
      );
    }
  }
  for (const intent of Array.from({ length: tx.manifest.collections.intents?.count ?? 0 }, (_, index) =>
    tx.at('intents', index),
  )) {
    if (!intent.mainCheckFailure) continue;
    const failure = intent.mainCheckFailure;
    const run = tx.find('runs', failure.runId)?.record;
    if (run)
      add(run, run.base, evidence(run, run.base), currentMain(failure.channel) === failure.head, intent.id);
  }
  return [...new Map(notices.map(notice => [notice.noticeId, notice])).values()];
}
