import { observeWorkProgress } from './work-progress.js';
import { requireNewLandSelection } from './land-request-identity.js';
import {
  previewLanding,
  previewExclusionMessage,
  type LandingPreview,
} from './integration-preview-landing.js';
import { landingPins, type LandingPins } from './landing-environment.js';
import { wakeLandingWorker } from './landing-worker-wake.js';
import { landFrictionCounts } from './friction-auto.js';
// SPDX-License-Identifier: Apache-2.0
import { savedOverlapPlan, highOverlap, orderOverlapGroups } from './agent-overlap-plan.js';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirBelow } from './mkdir-below.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import { defaultCheck, currentChannelHead } from './agent-defaults.js';
import { finishChild } from './agent-finish-journal.js';
import { checkEnvironment } from './check-environment.js';
import type { WorkStore } from './work-store.js';
import type { FinishAction } from './agent-workflow-schema.js';
import type { LandCommand } from './land-schema.js';
import type { WorkView } from './work-types.js';
export type LandEntry = {
  submissionOperationId?: string;
  command: FinishAction;
  inputs: WorkView['inputs'];
  viewId?: string;
  queued?: boolean;
  single?: { attempt: number; viewId?: string; previous: string | null };
  infrastructureRetries?: { code: string; runId: string }[];
  result?: Record<string, unknown>;
};
export type LandSelection = { inputs: WorkView['inputs']; finish: FinishAction };
type State = {
  schema: 1;
  request: string;
  landingPins?: LandingPins;
  command?: LandCommand;
  selection?: LandSelection;
  entries: LandEntry[];
  pins?: WorkView['inputs'];
  preview?: LandingPreview | null;
};
/** Local parent-driver receipt. Saved source/check/acceptance evidence remains canonical Work. */
export class LandJournal {
  readonly path: string;
  readonly state: State;
  constructor(
    private readonly store: WorkStore,
    command: LandCommand,
    selection?: LandSelection,
  ) {
    const directory = join(store.directory, 'agent-land');
    mkdirBelow(store.directory, directory);
    this.path = join(directory, `${command.operationId}.json`);
    const request = digest(JSON.stringify(selection ? { command, selection } : command));
    if (existsSync(this.path)) {
      this.state = JSON.parse(readFileSync(this.path, 'utf8')) as State;
      invariant(
        this.state.schema === 1 && this.state.request === request,
        'WORK_OPERATION_CHANGED',
        'Replay the original land request.',
      );
      return;
    }
    const data = store.load(),
      check = command.checkId ? data.checks.find(item => item.id === command.checkId) : defaultCheck(store);
    invariant(check, 'CHECK_REQUIRED', 'Choose a defined check.');
    const groups = new Map<string, WorkView['inputs']>();
    const pinned: WorkView['inputs'] = [];
    for (const laneId of command.laneIds) {
      const lane = data.lanes.find(item => item.id === laneId);
      invariant(lane, 'NOT_FOUND', 'Selected Lane not found.');
      const inputs = groups.get(lane.intentId) ?? [];
      const head = selection?.inputs.find(pin => pin.laneId === laneId)?.head ?? lane.head;
      inputs.push({ laneId, head });
      pinned.push({ laneId, head });
      groups.set(lane.intentId, inputs);
    }
    const plan = savedOverlapPlan(
      store,
      data.lanes
        .filter(lane => command.laneIds.includes(lane.id))
        .map(lane => ({
          ...lane,
          head: selection?.inputs.find(pin => pin.laneId === lane.id)?.head ?? lane.head,
        })),
    );
    const entries: LandEntry[] = [];
    for (const [intentId, pins] of groups) {
      const intent = data.intents.find(item => item.id === intentId)!;
      const compatible: WorkView['inputs'][] = [];
      for (const pin of plan.pairs.length
        ? [...pins].sort((a, b) => plan.order.indexOf(a.laneId) - plan.order.indexOf(b.laneId))
        : pins) {
        if (plan.pairs.some(pair => pair.lanes.includes(pin.laneId))) {
          compatible.push([pin]);
          continue;
        }
        const group = compatible.find(
          group =>
            group.length < 8 &&
            !highOverlap(
              plan,
              group.map(p => p.laneId),
              [pin.laneId],
            ),
        );
        if (group) group.push(pin);
        else compatible.push([pin]);
      }
      for (const inputs of compatible) {
        const first = inputs[0]!;
        entries.push({
          ...(selection ? { submissionOperationId: selection.finish.operationId } : {}),
          inputs,
          command: {
            action: 'finish',
            ...(selection?.finish.actor ? { actor: selection.finish.actor } : {}),
            ...(selection?.finish.tool ? { tool: selection.finish.tool } : {}),
            ...(selection?.finish.priority ? { priority: selection.finish.priority } : {}),
            ...(command.preview ? { preview: command.preview } : {}),
            operationId: finishChild(command.operationId, `land:${first.laneId}`),
            laneId: first.laneId,
            expectedHead: first.head,
            message: command.message ?? intent.outcome,
            with: inputs.slice(1).map(pin => pin.laneId),
            withInputs: inputs.slice(1),
            dependencies: selection?.finish.dependencies ?? intent.dependencies ?? [],
            checkId: check.id,
            expectedDefinition: selection?.finish.expectedDefinition ?? check.definition,
            expectedEnvironment: selection?.finish.expectedEnvironment ?? checkEnvironment().fingerprint,
            accept: {
              ...(selection?.finish.accept ?? {}),
              channel: command.channel,
              expectedPrevious: currentChannelHead(store, command.channel),
            },
            ...(command.keepOpen === undefined ? {} : { keepOpen: command.keepOpen }),
          },
        });
      }
    }
    this.state = {
      schema: 1,
      request,
      landingPins: landingPins(),
      command,
      ...(selection ? { selection } : {}),
      entries: orderOverlapGroups(plan, entries, entry => entry.inputs.map(pin => pin.laneId)),
      pins: pinned,
    };
    store.locked(() => {
      requireNewLandSelection(store, command.operationId, command.channel, entries);
      this.save();
    });
  }
  preflight(store: WorkStore, command: LandCommand) {
    // Constructor saved these pins before any potentially long preview. Recovery
    // never reselects live Lane heads or changes an already submitted entry.
    if (
      this.state.preview !== undefined ||
      this.state.entries.some(entry => entry.viewId || entry.queued || entry.result)
    )
      return;
    const preview =
      command.channel === 'main'
        ? previewLanding(store, this.state.pins ?? this.state.entries.flatMap(entry => entry.inputs), {
            skip: command.preview === 'skip',
          })
        : undefined;
    this.state.preview = preview ?? null;
    if (preview?.excluded.length)
      this.state.entries = this.state.entries.flatMap(entry => {
        const safe = entry.inputs.filter(pin => !preview.excluded.some(item => item.laneId === pin.laneId));
        const rejected = entry.inputs.filter(pin =>
          preview.excluded.some(item => item.laneId === pin.laneId),
        );
        return [...(safe.length ? [safe] : []), ...rejected.map(pin => [pin])].map(inputs => {
          const first = inputs[0]!;
          return {
            inputs,
            command: {
              ...entry.command,
              operationId: finishChild(command.operationId, `land:${first.laneId}`),
              laneId: first.laneId,
              expectedHead: first.head,
              with: inputs.slice(1).map(pin => pin.laneId),
              withInputs: inputs.slice(1),
            },
            ...(rejected.some(pin => pin.laneId === first.laneId)
              ? {
                  result: {
                    status: 'preview-excluded',
                    code: 'INTEGRATION_PREVIEW_EXCLUDED',
                    message: previewExclusionMessage,
                    preview,
                  },
                }
              : {}),
          };
        });
      });
    this.save();
  }
  save() {
    saveLandJournal(this.store, this.path, this.state);
    observeWorkProgress();
  }
}

/** Retain and replay the original parent request, including its immutable input pins.
 * Older journals recover through their retained child commands and exact input pins. */
export function pendingLands(store: WorkStore) {
  const directory = join(store.directory, 'agent-land');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => /^[0-9a-f-]+\.json$/.test(name))
    .flatMap(name => {
      const state = JSON.parse(readFileSync(join(directory, name), 'utf8')) as State;
      invariant(state.schema === 1, 'INVALID_WORK_STORE', 'Invalid retained land journal.');
      return state.entries.some(entry => !entry.result || entry.result.status === 'waiting')
        ? [
            {
              operationId: name.slice(0, -5),
              command: state.command,
              selection: state.selection,
              state,
              path: join(directory, name),
            },
          ]
        : [];
    });
}

export function saveLandJournal(store: WorkStore, path: string, state: State) {
  landFrictionCounts(state.entries);
  const temporary = `${path}.${randomUUID()}`,
    file = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(file, JSON.stringify(state) + '\n');
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const directory = openSync(join(path, '..'), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  wakeLandingWorker(store);
}
