// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { join } from 'node:path';
import { CoordinationJournal } from './agent-coordination-journal.js';
import { noticeParticipant, type ConflictNotice } from './agent-conflict-notice.js';
import { PeersSource } from './agent-peers-source.js';
import { PeersCache } from './agent-peers-cache.js';
import { checkEnvironment } from './check-environment.js';
import { nativeChannels } from './native-work.js';
import { channelStatus } from './work-channel.js';
import { workLocked } from './work-lock.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { PreviewChecks, previewChecks, type PreviewObservation } from './integration-preview-checks.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';

const inputSchema = z
  .object({
    action: z.literal('integrate').optional(),
    laneIds: z.array(z.string().uuid()).optional(),
  })
  .strict();
type Pair = { laneIds: string[]; heads: string[]; errors: string[]; noticeId: string };
type PreviewResult = {
  key: string;
  main: string;
  inputs: { laneId: string; head: string }[];
  checks: { name: string; executable: string; args: string[] }[];
  status: 'clean' | 'clash' | 'failed' | 'baseline-failed' | 'text-conflict' | 'no-lanes' | 'not-configured';
  combined?: PreviewObservation;
  baseline?: PreviewObservation;
  individual?: { laneId: string; result: PreviewObservation }[];
  pairs: Pair[];
  notices: ConflictNotice[];
  durationMs: number;
};

/** Explicit local speculation: no Candidate, check run, Channel move or remote call.
 * The per-owner lock serializes previews without holding the Work mutation lock. */
export function integrationPreview(store: WorkStore, input: unknown) {
  const parsed = inputSchema.safeParse(input);
  invariant(parsed.success, 'BAD_ARGUMENT', 'Select optional unique active checkpointed laneIds.');
  const command = parsed.data;
  invariant(
    !command.laneIds || new Set(command.laneIds).size === command.laneIds.length,
    'BAD_ARGUMENT',
    'Select each Lane once.',
  );
  return workLocked(
    join(store.directory, 'integration-preview.lock'),
    () => {
      const started = performance.now();
      const data = store.load(),
        lanes = data.lanes
          .filter(
            lane =>
              lane.state === 'active' &&
              lane.checkpoints.length &&
              (!command.laneIds || command.laneIds.includes(lane.id)),
          )
          .sort((a, b) => a.id.localeCompare(b.id));
      invariant(
        !command.laneIds || lanes.length === command.laneIds.length,
        'INTEGRATION_LANE_UNAVAILABLE',
        'Every selected Lane must be active with a saved checkpoint.',
      );
      const main = (store.native ? nativeChannels(data) : channelStatus(store, data)).find(
        channel => channel.name === 'main',
      )?.head;
      invariant(main, 'INTEGRATION_MAIN_UNAVAILABLE', 'Integration preview needs an accepted main Channel.');
      const source = new PeersSource(store, ''),
        checks = previewChecks(source, main, data.checks),
        inputs = lanes.map(lane => ({ laneId: lane.id, head: lane.head })),
        key = digest(
          JSON.stringify(['integration-v1', main, inputs, checks, checkEnvironment().fingerprint]),
        ),
        cache = new PeersCache(store.root),
        cached = cache.read<PreviewResult>(`integration:${key}`),
        journal = new CoordinationJournal(store);
      if (cached) {
        journal.record(cached.notices);
        return { revision: store.revision(), result: { ...cached, cached: true } };
      }
      const result: PreviewResult = {
        key,
        main,
        inputs,
        checks,
        status: lanes.length ? 'not-configured' : 'no-lanes',
        pairs: [],
        notices: [],
        durationMs: 0,
      };
      if (lanes.length && checks.length) {
        const runner = new PreviewChecks(store, source, lanes, checks);
        try {
          const observations = new Map<string, PreviewObservation>();
          const evaluate = (selected: Lane[]): PreviewObservation => {
            const id = selected.map(lane => lane.id).join(',');
            const known = observations.get(id);
            if (known) return known;
            let head = main;
            for (const lane of selected) {
              const merged = source.compose(head, lane.head, 'Integration preview', '');
              if (!merged.head) {
                const conflict: PreviewObservation = { status: 'text-conflict', errors: merged.conflicts };
                observations.set(id, conflict);
                return conflict;
              }
              head = merged.head;
            }
            const observed = runner.run(head);
            observations.set(id, observed);
            return observed;
          };
          result.combined = evaluate(lanes);
          result.status =
            result.combined.status === 'passed'
              ? 'clean'
              : result.combined.status === 'text-conflict'
                ? 'text-conflict'
                : 'failed';
          if (result.combined.status === 'failed') {
            result.baseline = evaluate([]);
            if (result.baseline.status !== 'passed') result.status = 'baseline-failed';
            else {
              result.individual = lanes.map(lane => ({ laneId: lane.id, result: evaluate([lane]) }));
              const passing = lanes.filter(lane => evaluate([lane]).status === 'passed');
              for (let i = 0; i < passing.length; i++)
                for (const right of passing.slice(i + 1)) {
                  const left = passing[i]!,
                    pair = [left, right],
                    observed = evaluate(pair);
                  if (observed.status !== 'failed') continue;
                  const noticeId = digest(JSON.stringify([key, left.id, right.id]));
                  result.pairs.push({
                    laneIds: pair.map(l => l.id),
                    heads: pair.map(l => l.head),
                    errors: observed.errors,
                    noticeId,
                  });
                  result.notices.push({
                    noticeId,
                    kind: 'conflict-notice',
                    granularity: 'symbol',
                    participants: pair.map(lane => noticeParticipant(store, source, lane)),
                    proposedOrder: [],
                    choices: [],
                    conflicts: [],
                    reason: `Integration preview: Lanes ${left.id} and ${right.id} pass alone on main ${main} but fail together. ${observed.errors.join('\n')}`,
                    integration: { main, key, errors: observed.errors },
                  });
                }
              if (result.pairs.length) result.status = 'clash';
            }
          }
        } finally {
          runner.dispose();
        }
      }
      result.durationMs = Math.round(performance.now() - started);
      journal.record(result.notices);
      // Advisory cache includes source, definitions, runtime; never passing landing evidence.
      cache.write(`integration:${key}`, result);
      return { revision: store.revision(), result: { ...result, cached: false } };
    },
    { operation: 'local integration preview' },
  );
}
