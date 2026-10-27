// SPDX-License-Identifier: Apache-2.0
import { conversationSchema, type Conversation } from './agent-edit-types.js';
export { conversationSchema, overlapAnswerSchema, type Conversation } from './agent-edit-types.js';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeEditObservation } from './agent-edit-observation.js';
import { mkdirBelow } from './mkdir-below.js';

function readContext(directory: string, laneId: string, kind: string): Conversation | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, kind, `${laneId}.json`), 'utf8'));
    return conversationSchema.parse(value);
  } catch {
    return undefined;
  }
}
function recordContext(directory: string, laneId: string, context: Conversation, kind: string) {
  const target = join(directory, kind);
  mkdirBelow(directory, target);
  writeEditObservation(join(target, `${laneId}.json`), conversationSchema.parse(context));
}

export const readEditContext = (directory: string, laneId: string) =>
  readContext(directory, laneId, 'edit-context');
export const recordEditContext = (directory: string, laneId: string, context: Conversation) =>
  recordContext(directory, laneId, context, 'edit-context');
export const readAgentTurn = (directory: string, laneId: string) =>
  readContext(directory, laneId, 'agent-turn') ?? readEditContext(directory, laneId);
export const recordAgentTurn = (directory: string, laneId: string, context: Conversation) =>
  recordContext(directory, laneId, context, 'agent-turn');
