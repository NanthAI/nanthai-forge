// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { durableReplace } from './native-durability.js';

/** Machine-local record of landing operations this client saw land, newest first per project
 * (edcb0fc8). The CLI canary's wait step uses only these: a landed `finish` operation is always
 * waitable and its wait is a pure read, unlike the operation id of a planning put. One small
 * local write per observed landing; no timers, no hosted call. */
const PER_PROJECT = 5;
const PROJECTS = 20;
type Record = { [projectId: string]: string[] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const landedOperationsPath = (stateHome?: string) =>
  join(
    stateHome || process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    'forge',
    'landed-operations.json',
  );
function read(path: string): Record {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
/** Never throws: advisory. Canary children and test processes without a selected state home
 * never write it. */
export function rememberLandedOperations(projectId: string, operationIds: readonly string[]) {
  if (process.env.FORGE_CLI_CANARY) return;
  if (process.env.NODE_TEST_CONTEXT && !process.env.XDG_STATE_HOME) return;
  const ids = operationIds.filter(id => uuid.test(id));
  if (!ids.length) return;
  try {
    const path = landedOperationsPath();
    const record = read(path);
    const next = [...new Set([...ids, ...(record[projectId] ?? [])])].slice(0, PER_PROJECT);
    if (JSON.stringify(next) === JSON.stringify(record[projectId])) return;
    const kept = Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== projectId)
        .slice(0, PROJECTS - 1),
    );
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    durableReplace(path, JSON.stringify({ [projectId]: next, ...kept }));
  } catch {
    /* advisory */
  }
}
export const landedOperations = (projectId: string, stateHome?: string) =>
  (read(landedOperationsPath(stateHome))[projectId] ?? []).filter(
    (id): id is string => typeof id === 'string' && uuid.test(id),
  );
