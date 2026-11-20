// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import { ForgeError } from './errors.js';
import { listLanes } from './lane-registry.js';

const uuidShape = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
const fullIdHint = (field: string) =>
  /lane/i.test(field)
    ? `nforge agent ROOT lanes '{}' lists your live Lanes with full ids`
    : /operation/i.test(field)
      ? `copy the operationId from the receipt`
      : /^(id|planningItemId|parentId|initiativeId)$/.test(field.split('.')[0]!)
        ? `planning '{"search":"words"}' returns full planning ids`
        : `copy it from the receipt or listing that showed it`;
/** A wrong value is echoed only when short and plain, so a secret pasted into the wrong field is
 * never repeated back; otherwise its type and length. */
function gotValue(value: unknown) {
  if (value === undefined) return '';
  if (typeof value === 'string')
    return /^[\w.:-]{1,24}$/.test(value) ? ` (got "${value}")` : ` (got a ${value.length}-character string)`;
  return typeof value === 'number' || typeof value === 'boolean' || value === null
    ? ` (got ${String(value)})`
    : ` (got ${Array.isArray(value) ? 'an array' : 'an object'})`;
}

/** One shared argument-error text: each bad field by name with its expected shape,
 * and for a short id where to find the full one. Local only; no hosted call. */
export function describeIssues(issues: readonly z.core.$ZodIssue[], input: unknown): string {
  return issues
    .map(issue => {
      const field = issue.path.map(String).join('.') || 'parameters';
      const value = issue.path.reduce<unknown>(
        (item, key) =>
          item && typeof item === 'object' ? (item as Record<PropertyKey, unknown>)[key] : undefined,
        input,
      );
      // The allowed values right after the field, so a cut line still says what to send (593fc2d7).
      if (issue.code === 'invalid_value' && issue.values.length)
        return `${field}: one of ${issue.values.map(String).join('|')}${gotValue(value)}`;
      if (issue.code === 'invalid_format' && issue.format === 'uuid') {
        const short = typeof value === 'string' && /^[0-9a-f][0-9a-f-]{0,34}$/i.test(value);
        return `${field}: expected the full 36-character UUID (${uuidShape})${short ? `, got the short id "${value}"; pass the full id (${fullIdHint(field)})` : ''}`;
      }
      return `${field}: ${issue.message.replace(/\.+$/, '')}`;
    })
    .join('; ');
}

/** A unique short laneId prefix (8+ hex characters) of a Lane this machine opened
 * resolves to its full id from the local registry; anything else is left for the
 * schema to name. No network. */
/** 8 to 35 hex characters (dashes allowed after the first 8): a Lane id prefix, not a full id. */
export const isShortLaneId = (laneId: unknown): laneId is string =>
  typeof laneId === 'string' && /^[0-9a-f]{8}[0-9a-f-]{0,27}$/i.test(laneId) && laneId.length !== 36;
export function resolveShortLaneId(selected: Record<string, unknown>, projectId?: string) {
  const laneId = selected.laneId;
  if (!isShortLaneId(laneId)) return { selected };
  const prefix = laneId.toLowerCase();
  const matches = listLanes().filter(
    entry =>
      entry.laneId.startsWith(prefix) && (!projectId || !entry.projectId || entry.projectId === projectId),
  );
  return matches.length === 1
    ? { selected: { ...selected, laneId: matches[0]!.laneId }, resolved: matches[0]!.laneId }
    : { selected };
}

const idKeys = ['laneId', 'operationId', 'operationIds', 'runId', 'id', 'planningItemId', 'intentId'];
/** NOT_FOUND names what was looked up and the next command, never only "not found".
 * Applied once at the CLI boundary for every hosted action; formatting only. */
export function actionableNotFound(error: unknown, action: string, command: Record<string, unknown>) {
  if (!(error instanceof ForgeError) || error.code !== 'NOT_FOUND' || /\bnforge /.test(error.message))
    return error;
  const sent = idKeys.flatMap(key =>
    command[key] === undefined ? [] : [`${key} ${JSON.stringify(command[key]).slice(0, 120)}`],
  );
  return new ForgeError(
    'NOT_FOUND',
    `${error.message.replace(/\.?$/, '.')} Action ${action}${sent.length ? ` sent ${sent.join(', ')}` : ' sent no id; it selected from this folder'}. Next: run from the Lane root that start printed or pass full ids; nforge agent ROOT lanes '{}' lists your live Lanes with full ids.`,
    error.retryAt,
    error.recovery,
  );
}
