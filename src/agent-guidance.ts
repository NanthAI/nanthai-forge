// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
  lstatSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { z } from 'zod';
import { invariant } from './errors.js';
import type { WorkStore } from './work-store.js';
import { guidanceInputSchema } from './agent-guidance-schema.js';
export { guidanceInputSchema } from './agent-guidance-schema.js';
const configSchema = z.object({
  project: z.string().max(4000).default(''),
  personal: z.record(z.string(), z.string().max(4000)).default({}),
  operations: z
    .array(
      z.object({
        operationId: z.string().uuid(),
        actor: z.string(),
        scope: z.enum(['project', 'personal']),
        agentGuidance: z.string().max(4000),
      }),
    )
    .default([]),
});
function read(store: WorkStore) {
  const path = join(store.directory, 'agent-guidance.json');
  if (!existsSync(path)) return configSchema.parse({});
  invariant(!lstatSync(path).isSymbolicLink(), 'UNSAFE_WORK_STORE', 'Guidance metadata must be a real file.');
  return configSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
export function localGuidance(store: WorkStore, actor = userInfo().username) {
  const config = read(store);
  return {
    project: config.project,
    personal: Object.hasOwn(config.personal, actor) ? config.personal[actor]! : '',
  };
}
export function setLocalGuidance(store: WorkStore, input: unknown, actor = userInfo().username) {
  const parsed = guidanceInputSchema.safeParse(input);
  invariant(
    parsed.success,
    'BAD_ARGUMENT',
    'Use an operation UUID, scope and agentGuidance of at most 4,000 characters.',
  );
  const command = parsed.data;
  return store.locked(() => {
    const config = read(store),
      original = config.operations.find(o => o.operationId === command.operationId);
    if (original) {
      invariant(
        original.actor === actor &&
          original.scope === command.scope &&
          original.agentGuidance === command.agentGuidance,
        'WORK_OPERATION_CHANGED',
        'Retry this guidance operation with its original values.',
      );
      return {
        operationId: original.operationId,
        scope: original.scope,
        agentGuidance: original.agentGuidance,
      };
    }
    if (command.scope === 'project') config.project = command.agentGuidance;
    else config.personal = { ...config.personal, [actor]: command.agentGuidance };
    config.operations.push({ ...command, actor });
    const path = join(store.directory, 'agent-guidance.json'),
      temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    const fd = openSync(temporary, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const dir = openSync(store.directory, 'r');
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
    return command;
  });
}
