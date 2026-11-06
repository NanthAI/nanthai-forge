// SPDX-License-Identifier: Apache-2.0
import { readdirSync } from 'node:fs';
import { hostedAgentDirectory } from './hosted-agent-journal.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const keys = ['operationId', 'composeOperationId', 'applyOperationId'] as const;

/** One spelling per operation id (52f2f894): `uuidgen` prints upper case, logs and JSON often lower
 * case, and the server compares ids exactly. Ids are accepted in any case and used as lower case,
 * except an operation this checkout already journaled under another spelling (an older CLI kept
 * the caller's), which keeps that stored spelling so its landing is still found. Local only. */
export function canonicalOperationId(root: string, id: string) {
  if (!uuid.test(id)) return id;
  // The directory listing is the authority on the stored spelling: a case-insensitive disk
  // answers an exists-check for either case, so the check cannot tell them apart.
  const lower = id.toLowerCase(),
    stored = readdirSync(hostedAgentDirectory(root)).find(name => name.toLowerCase() === `${lower}.json`);
  return stored ? stored.slice(0, -'.json'.length) : lower;
}

/** The command with its operation ids in their one spelling; other fields are untouched. */
export function canonicalOperationIds<T extends Record<string, unknown>>(root: string, command: T): T {
  let changed: Record<string, unknown> | undefined;
  const set = (key: string, value: unknown) => ((changed ??= { ...command })[key] = value);
  for (const key of keys) {
    const id = command[key];
    if (typeof id === 'string' && uuid.test(id)) {
      const canonical = canonicalOperationId(root, id);
      if (canonical !== id) set(key, canonical);
    }
  }
  const many = command.operationIds;
  if (Array.isArray(many) && many.some(id => typeof id === 'string' && uuid.test(id))) {
    const canonical = many.map(id => (typeof id === 'string' ? canonicalOperationId(root, id) : id));
    if (canonical.some((id, index) => id !== many[index])) set('operationIds', canonical);
  }
  return (changed ?? command) as T;
}
