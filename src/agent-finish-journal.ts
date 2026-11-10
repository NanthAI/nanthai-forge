// SPDX-License-Identifier: Apache-2.0
import { landingPinsSchema } from './landing-environment.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { finishChild } from './finish-child.js';
export { finishChild } from './finish-child.js';
import { join } from 'node:path';
import { z } from 'zod';
import { interactionRequestSchema } from './work-types.js';
import type { FinishAction } from './agent-workflow-schema.js';
import type { WorkStore } from './work-store.js';

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
  landingPins: landingPinsSchema.optional(),
  command: fields.optional(),
  dependencyWait: z.boolean().optional(),
  submitted: z.boolean().optional(),
  attempts: z.array(attemptSchema),
  landing: z.array(z.object({ status: z.enum(['waiting to land', 'landing']), position: z.number() })),
  result: fields.optional(),
});
export type FinishAttempt = z.infer<typeof attemptSchema>;
/** Initial child IDs preserve the existing finish protocol. Every retry has its
 * own deterministic children; a lost reply never substitutes new phase inputs. */
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

/** Read retained driver context for an explicit Lane handover; never resumes a driver. */
export function laneFinishes(store: WorkStore, laneId?: string, operationId?: string) {
  const directory = join(store.directory, 'agent-finish');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(name => (operationId ? name === `${operationId}.json` : /^[0-9a-f-]+\.json$/.test(name)))
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
