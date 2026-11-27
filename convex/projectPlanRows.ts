// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Disposable Plan pages share the Work data partition; canonical Items and search roots stay exact.
import { deflateSync, inflateSync, strToU8, strFromU8 } from 'fflate';
import type { PlanRow } from '../src/planning-model';

export const PLAN_PAGE_SIZE = 128;
export const PLAN_ROWS = '_workStorePlan';
export const PLAN_PAGE_PREFIX = '2';
export const PLAN_OVERSIZED_PREFIX = 'x';
export const planParent = (kind: string, status: string, initiativeId = '') =>
  `${kind}:${status}${kind === 'issue' && ['closed', 'abandoned'].includes(status) ? `:${initiativeId}` : ''}`;
export const planPageKey = (parent: string, start: number, end = Number.MAX_SAFE_INTEGER) => {
  const [kind, status, ...rest] = parent.split(':');
  const states: Record<string, string> = {
    proposed: 'p',
    open: 'o',
    'in-progress': 'w',
    closed: 'c',
    abandoned: 'a',
  };
  const scope =
    (kind === 'issue' || kind === 'initiative') && states[status!]
      ? [(kind === 'issue' ? 'i' : 'n') + states[status!], ...rest].join(':')
      : parent;
  return `${PLAN_PAGE_PREFIX}${scope}:${start.toString(36)}:${end === Number.MAX_SAFE_INTEGER ? '~' : end.toString(36)}`;
};

/** The stored payload, also used to size the exact bytes before compression. */
export function planPagePayload(rows: PlanRow[]) {
  const settled =
    rows.length && rows[0]!.kind === 'issue' && ['closed', 'abandoned'].includes(rows[0]!.status);
  return settled ? rows.map(row => row.position) : rows;
}
/** Portable DEFLATE stays on the backend; neither CLI/MCP nor the web imports this module. */
export function encodePlanPage(rows: PlanRow[]): string {
  const bytes = deflateSync(strToU8(JSON.stringify(planPagePayload(rows))), { level: 6 });
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
}
export function decodePlanPage(value: string, parent: string): PlanRow[] {
  const bytes = Uint8Array.from(atob(value), byte => byte.charCodeAt(0));
  const rows = JSON.parse(strFromU8(inflateSync(bytes)));
  const [kind, status, initiativeId] = parent.split(':');
  if (kind === 'issue' && ['closed', 'abandoned'].includes(status!))
    return (rows as number[]).map(position => ({
      kind,
      status: status as PlanRow['status'],
      position,
      id: '',
      title: '',
      ...(initiativeId ? { initiativeId } : {}),
    }));
  return rows as PlanRow[];
}

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
/** A planning search root's value as the screen's row: the model fields and counts, never the body. */
export function planViewRow(value: Record<string, unknown>, position: number, shelf = false): PlanRow | null {
  const { id, kind, title, status } = value;
  if (typeof id !== 'string' || (kind !== 'issue' && kind !== 'initiative') || typeof title !== 'string')
    return null;
  // Archived and Deleted Items are out of every plan page, settled list and count (Item 4c9e961e); only the Archive
  // and Deleted lists ask for them, with the status each left and when.
  const shelved = status === 'archived' || status === 'deleted';
  if (shelved !== shelf) return null;
  const relations = Array.isArray(value.relations) ? (value.relations as PlanRow['relations']) : undefined;
  const doneWhen =
    Array.isArray(value.doneWhen) && value.doneWhen.length === 2
      ? (value.doneWhen as [number, number])
      : undefined;
  return {
    id,
    kind,
    title,
    status: status as PlanRow['status'],
    position,
    ...(typeof value.version === 'number' ? { version: value.version } : {}),
    ...(text(value.initiativeId) ? { initiativeId: text(value.initiativeId) } : {}),
    ...(text(value.parentId) ? { parentId: text(value.parentId) } : {}),
    ...(text(value.order) ? { order: text(value.order) } : {}),
    ...(text(value.type) ? { type: text(value.type) } : {}),
    ...(text(value.owner) ? { owner: text(value.owner) } : {}),
    ...(relations?.length ? { relations } : {}),
    ...(value.hidden === true ? { hidden: true } : {}),
    ...(value.inLane === true ? { inLane: true } : {}),
    ...(doneWhen ? { doneWhen } : {}),
    ...(shelved && text(value.was) ? { was: text(value.was) as PlanRow['was'] } : {}),
    ...(shelved && text(value.at) ? { at: text(value.at) } : {}),
    ...(shelved && text(value.by) ? { by: text(value.by) } : {}),
  };
}
