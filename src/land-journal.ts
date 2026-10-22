import { landFrictionCounts } from './friction-auto.js';
// SPDX-License-Identifier: Apache-2.0
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  command: FinishAction;
  inputs: WorkView['inputs'];
  viewId?: string;
  queued?: boolean;
  single?: { attempt: number; viewId?: string; previous: string | null };
  result?: Record<string, unknown>;
};
type State = { schema: 1; request: string; entries: LandEntry[] };
/** Local parent-driver receipt. Saved source/check/acceptance evidence remains canonical Work. */
export class LandJournal {
  readonly path: string;
  readonly state: State;
  constructor(store: WorkStore, command: LandCommand) {
    const directory = join(store.directory, 'agent-land');
    mkdirBelow(store.directory, directory);
    this.path = join(directory, `${command.operationId}.json`);
    const request = digest(JSON.stringify(command));
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
    for (const laneId of command.laneIds) {
      const lane = data.lanes.find(item => item.id === laneId);
      invariant(lane, 'NOT_FOUND', 'Selected Lane not found.');
      const inputs = groups.get(lane.intentId) ?? [];
      inputs.push({ laneId, head: lane.head });
      groups.set(lane.intentId, inputs);
    }
    const entries: LandEntry[] = [];
    for (const [intentId, pins] of groups) {
      const intent = data.intents.find(item => item.id === intentId)!;
      // Preserve compose's existing eight-input boundary without restricting the selection.
      for (let offset = 0; offset < pins.length; offset += 8) {
        const inputs = pins.slice(offset, offset + 8),
          first = inputs[0]!;
        entries.push({
          inputs,
          command: {
            action: 'finish',
            operationId: finishChild(command.operationId, `land:${first.laneId}`),
            laneId: first.laneId,
            expectedHead: first.head,
            message: command.message ?? intent.outcome,
            with: inputs.slice(1).map(pin => pin.laneId),
            withInputs: inputs.slice(1),
            dependencies: intent.dependencies ?? [],
            checkId: check.id,
            expectedDefinition: check.definition,
            expectedEnvironment: checkEnvironment().fingerprint,
            accept: {
              channel: command.channel,
              expectedPrevious: currentChannelHead(store, command.channel),
            },
            ...(command.keepOpen === undefined ? {} : { keepOpen: command.keepOpen }),
          },
        });
      }
    }
    this.state = { schema: 1, request, entries };
    this.save();
  }
  save() {
    landFrictionCounts(this.state.entries);
    const temporary = `${this.path}.${randomUUID()}`,
      file = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(file, JSON.stringify(this.state) + '\n');
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, this.path);
    const directory = openSync(join(this.path, '..'), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}
