import { randomUUID } from 'node:crypto';
import { localCost } from './check-cost.js';
import { retainPreviewMeasurement } from './preview-accounting.js';
import { publishedOverlap } from './agent-coordination-events.js';
// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { join } from 'node:path';
import { CoordinationJournal } from './agent-coordination-journal.js';
import { type ConflictNotice } from './agent-conflict-notice.js';
import { PeersCache } from './agent-peers-cache.js';
import { previewTuple, previewCurrent } from './integration-preview-inputs.js';
import { diagnosePreview } from './integration-preview-diagnosis.js';
import { nativeChannels } from './native-work.js';
import { channelStatus } from './work-channel.js';
import { workLocked } from './work-lock.js';
import { invariant } from './errors.js';
import { PreviewChecks, type PreviewObservation, type PreviewCheck } from './integration-preview-checks.js';
import type { WorkStore } from './work-store.js';
import type { Lane } from './work-types.js';

const inputSchema = z
  .object({
    action: z.literal('integrate').optional(),
    laneIds: z.array(z.string().uuid()).optional(),
  })
  .strict();
type Pair = { laneIds: string[]; heads: string[]; errors: string[]; noticeId: string };
export type PreviewResult = {
  key: string;
  main: string;
  inputs: { laneId: string; head: string }[];
  checks: PreviewCheck[];
  configuration: string;
  environment: string;
  dependencies: { laneId: string; heads: string[]; errors: string[]; pins: string[] }[];
  applicability: 'current' | 'historical';
  coverage: { omittedLaneIds: string[]; gaps: string[] };
  historical?: { key: string; status: string };
  observations: { laneIds: string[]; result: PreviewObservation }[];
  interactions: (Pair & { minimization: 'incomplete' })[];
  status:
    | 'clean'
    | 'clash'
    | 'failed'
    | 'baseline-failed'
    | 'text-conflict'
    | 'no-lanes'
    | 'not-configured'
    | 'inconclusive';
  combined?: PreviewObservation;
  baseline?: PreviewObservation;
  individual?: { laneId: string; result: PreviewObservation }[];
  pairs: Pair[];
  notices: ConflictNotice[];
  durationMs: number;
  accounting?: { status: 'recorded' | 'unavailable'; executionId: string; code?: string };
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
  return previewPinned(store, command.laneIds);
}

/** Internal landing path: saved request pins, never reselect mutable Lane heads. */
export function previewPinned(
  store: WorkStore,
  laneIds?: string[],
  pins?: { laneId: string; head: string }[],
  base?: string,
) {
  return workLocked(
    join(store.directory, 'integration-preview.lock'),
    () => {
      const started = performance.now(),
        startedAt = new Date().toISOString();
      const data = store.load(),
        selected = data.lanes
          .filter(
            lane =>
              lane.state === 'active' && lane.checkpoints.length && (!laneIds || laneIds.includes(lane.id)),
          )
          .sort((a, b) => a.id.localeCompare(b.id)),
        lanes = pins
          ? pins
              .map(pin => {
                const lane = data.lanes.find(lane => lane.id === pin.laneId);
                invariant(lane, 'INTEGRATION_LANE_UNAVAILABLE', 'Pinned Lane is unavailable.');
                return { ...lane, head: pin.head };
              })
              .sort((a, b) => a.id.localeCompare(b.id))
          : selected;
      invariant(
        !laneIds || lanes.length === laneIds.length,
        'INTEGRATION_LANE_UNAVAILABLE',
        'Every selected Lane must be active with a saved checkpoint.',
      );
      const main =
        base ??
        (store.native ? nativeChannels(data) : channelStatus(store, data)).find(
          channel => channel.name === 'main',
        )?.head;
      invariant(main, 'INTEGRATION_MAIN_UNAVAILABLE', 'Integration preview needs an accepted main Channel.');
      const { source, checks, inputs, key, configuration, dependencies, environment } = previewTuple(
          store,
          data,
          lanes,
          main,
        ),
        cache = new PeersCache(store.root),
        cached = cache.read<PreviewResult>(`integration:${key}`),
        journal = new CoordinationJournal(store);
      // Repository commands can read external files/tools and passthrough values.
      // Retained verdicts are historical unless there were no external commands.
      if (cached && !checks.length && cached.status !== 'inconclusive') {
        const current = previewCurrent(store, cached);
        if (current) {
          journal.record(cached.notices);
          if (cached.notices.length) publishedOverlap(store);
        }
        return {
          revision: store.revision(),
          result: {
            ...cached,
            applicability: current ? ('current' as const) : ('historical' as const),
            cached: true,
          },
        };
      }
      const result: PreviewResult = {
        key,
        main,
        inputs,
        checks,
        configuration,
        environment: environment.fingerprint,
        dependencies,
        applicability: 'current',
        coverage: {
          omittedLaneIds: data.lanes
            .filter(lane => lane.state === 'active' && lane.checkpoints.length)
            .filter(lane => !lanes.some(item => item.id === lane.id))
            .map(lane => lane.id),
          gaps: ['Only saved source is checked; unsaved files and runtime behavior are excluded.'],
        },
        ...(cached ? { historical: { key: cached.key, status: cached.status } } : {}),
        observations: [],
        interactions: [],
        status: lanes.length ? 'not-configured' : 'no-lanes',
        pairs: [],
        notices: [],
        durationMs: 0,
      };
      const hasStaticInput = () => {
        if (checks.length || dependencies.some(item => item.errors.length)) return true;
        try {
          return [main, ...dependencies.flatMap(item => item.heads)].some(head =>
            source.state(head).files.some(file => file.path === 'convex/schema.ts'),
          );
        } catch {
          return true;
        }
      };
      if (lanes.length && hasStaticInput()) {
        const runner = new PreviewChecks(store, source, lanes, checks, environment);
        try {
          const observations = new Map<string, PreviewObservation>();
          const evaluate = (selected: Lane[]): PreviewObservation => {
            const id = selected.map(lane => lane.id).join(',');
            const known = observations.get(id);
            if (known) return known;
            const closures = selected.map(lane => dependencies.find(item => item.laneId === lane.id)!);
            const errors = closures.flatMap(item => item.errors);
            if (errors.length) {
              const unavailable: PreviewObservation = {
                status: 'inconclusive',
                errors,
                code: 'INTEGRATION_DEPENDENCY_UNAVAILABLE',
              };
              observations.set(id, unavailable);
              return unavailable;
            }
            let head = main;
            try {
              for (const dependency of [...new Set(closures.flatMap(item => item.heads))]) {
                const merged = source.compose(head, dependency, 'Integration preview', '');
                if (!merged.head) {
                  const conflict: PreviewObservation = { status: 'text-conflict', errors: merged.conflicts };
                  observations.set(id, conflict);
                  return conflict;
                }
                head = merged.head;
              }
            } catch {
              const unavailable: PreviewObservation = {
                status: 'inconclusive',
                errors: ['Pinned source unavailable.'],
                code: 'INTEGRATION_SOURCE_UNAVAILABLE',
              };
              observations.set(id, unavailable);
              return unavailable;
            }
            const observed = { ...runner.run(head), head };
            observations.set(id, observed);
            return observed;
          };
          diagnosePreview(result, lanes, evaluate, store, source);
          result.observations = [...observations].map(([id, result]) => ({
            laneIds: id ? id.split(',') : [],
            result,
          }));
        } finally {
          runner.dispose();
        }
      }
      result.durationMs = Math.round(performance.now() - started);
      if (result.observations.length) {
        const executionId = randomUUID();
        try {
          retainPreviewMeasurement(store, {
            executionId,
            startedAt,
            durationMs: result.durationMs,
            inputs,
            cost: localCost(executionId),
          });
          result.accounting = { status: 'recorded', executionId };
        } catch {
          // Missing advisory accounting must never become an integration/landing gate.
          result.accounting = { status: 'unavailable', executionId, code: 'PREVIEW_COST_UNAVAILABLE' };
        }
      }
      result.applicability = previewCurrent(store, result) ? 'current' : 'historical';
      // Retain advisory history only; never passing landing evidence.
      cache.write(`integration:${key}`, result);
      // Publish after the exact observation is readable: inbox applicability uses
      // that observation, including a later clean result for the same tuple.
      if (result.applicability === 'current') {
        journal.record(result.notices);
        if (result.notices.length) publishedOverlap(store);
      }
      return { revision: store.revision(), result: { ...result, cached: false } };
    },
    { operation: 'local integration preview' },
  );
}
