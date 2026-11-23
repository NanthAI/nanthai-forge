// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { conversationSchema, type Conversation } from './agent-edit-types.js';
export { conversationSchema, type Conversation } from './agent-edit-types.js';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

function readContext(directory: string, laneId: string, kind: string): Conversation | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, kind, `${laneId}.json`), 'utf8'));
    return conversationSchema.parse(value);
  } catch {
    return undefined;
  }
}

export const readEditContext = (directory: string, laneId: string) =>
  readContext(directory, laneId, 'edit-context');
