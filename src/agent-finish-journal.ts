// SPDX-License-Identifier: Apache-2.0
import { mkdirBelow } from './mkdir-below.js';
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
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { interactionRequestSchema } from './work-types.js';
import { digest } from './hash.js';
import { invariant } from './errors.js';
import type { FinishAction } from './agent-workflow-schema.js';
import type { WorkStore } from './work-store.js';
import type { LandingPosition } from './landing-queue.js';

const fields = z.record(z.string(), z.unknown());
const attemptSchema = z.object({
  number: z.number().int().nonnegative(),
  operationId: z.uuid(),
  head: z.string(),
  previous: z.string().nullable(),
  operations: z.object({ sync: z.uuid(), compose: z.uuid(), run: z.uuid(), accept: z.uuid() }),
  interaction: interactionRequestSchema.nullable().optional(),
  sync: fields.optional(),
  view: fields.optional(),
  run: fields.optional(),
  acceptance: fields.optional(),
  status: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
const schema = z.object({
  schema: z.literal(1),
  request: z.string(),
  command: fields.optional(),
  dependencyWait: z.boolean().optional(),
  attempts: z.array(attemptSchema),
  landing: z.array(z.object({ status: z.enum(['waiting to land', 'landing']), position: z.number() })),
  result: fields.optional(),
});
export type FinishAttempt = z.infer<typeof attemptSchema>;
/** Initial child IDs preserve the existing finish protocol. Every retry has its
 * own deterministic children; a lost reply never substitutes new phase inputs. */
export function finishChild(operationId: string, phase: string, attempt = 0) {
  const bytes = createHash('sha256')
    .update(`forge-agent-finish:${operationId}:${attempt ? `attempt:${attempt}:${phase}` : phase}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function finishAttempt(
  command: FinishAction,
  number: number,
  head: string,
  previous: string | null,
): FinishAttempt {
  return {
    number,
    operationId: finishChild(command.operationId, 'attempt', number),
    head,
    previous,
    operations: {
      sync: finishChild(command.operationId, 'sync', number),
      compose: finishChild(command.operationId, 'compose', number),
      run: finishChild(command.operationId, 'run', number),
      accept: finishChild(command.operationId, 'accept', number),
    },
  };
}
/** Local driver state beside Work (like hosting transport state). Canonical
 * checkpoints, Views, runs and acceptances remain in Work. The per-parent queue
 * serializes writers; sync+rename+directory sync publish each pinned attempt. */
export class FinishJournal {
  readonly path: string;
  readonly state: z.infer<typeof schema>;
  constructor(store: WorkStore, command: FinishAction, head: string) {
    const directory = join(store.directory, 'agent-finish');
    mkdirBelow(store.directory, directory);
    this.path = join(directory, `${command.operationId}.json`);
    const request = digest(JSON.stringify(command));
    this.state = existsSync(this.path)
      ? schema.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      : {
          schema: 1,
          request,
          command: JSON.parse(JSON.stringify(command)) as Record<string, unknown>,
          attempts: [finishAttempt(command, 0, head, command.accept?.expectedPrevious ?? null)],
          landing: [],
        };
    invariant(
      this.state.request === request,
      'WORK_OPERATION_CHANGED',
      'Reconcile the original finish request.',
    );
    this.save();
  }
  position(position: LandingPosition) {
    const last = this.state.landing.at(-1);
    if (last?.status === position.status && last.position === position.position) return;
    this.state.landing.push(position);
    this.save();
  }
  save() {
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

/** Resume only explicit dependency waits; terminal failures retain their result. */
export function waitingFinishes(store: WorkStore) {
  const directory = join(store.directory, 'agent-finish');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => /^[0-9a-f-]+\.json$/.test(name))
    .flatMap(name => {
      const state = schema.parse(JSON.parse(readFileSync(join(directory, name), 'utf8')));
      return !state.result &&
        (state.dependencyWait ||
          ['waiting-for-dependency', 'waiting to land'].includes(state.attempts.at(-1)?.status ?? '')) &&
        state.command
        ? [state.command]
        : [];
    });
}

/** Reuse the original pinned finish command for CLI aliases after an unknown reply. */
export function retainedFinishCommand(store: WorkStore, operationId: string) {
  invariant(z.uuid().safeParse(operationId).success, 'BAD_ARGUMENT', 'Use a UUID operation id.');
  const path = join(store.directory, 'agent-finish', `${operationId}.json`);
  if (!existsSync(path)) return undefined;
  return schema.parse(JSON.parse(readFileSync(path, 'utf8'))).command;
}

/** Read retained driver context for an explicit Lane handover; never resumes a driver. */
export function laneFinishes(store: WorkStore, laneId?: string) {
  const directory = join(store.directory, 'agent-finish');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => /^[0-9a-f-]+\.json$/.test(name))
    .flatMap(name => {
      const state = schema.parse(JSON.parse(readFileSync(join(directory, name), 'utf8')));
      return state.command &&
        (!laneId ||
          state.command.laneId === laneId ||
          (state.command.withInputs as { laneId: string }[] | undefined)?.some(pin => pin.laneId === laneId))
        ? [
            {
              operationId: name.slice(0, -5),
              command: state.command,
              attempts: state.attempts,
              landing: state.landing,
              result: state.result ?? null,
            },
          ]
        : [];
    });
}
