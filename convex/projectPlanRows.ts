// SPDX-License-Identifier: Apache-2.0
// Disposable Plan pages share the Work data partition; canonical Items and search roots stay exact.
import { deflateSync, inflateSync, strToU8, strFromU8 } from 'fflate';
import type { PlanRow } from '../src/planning-model';

export const PLAN_PAGE_SIZE = 512;
export const PLAN_ROWS = '_workStorePlan';
export const planParent = (kind: string, status: string, initiativeId = '') =>
  `${kind}:${status}${kind === 'issue' && ['closed', 'abandoned'].includes(status) ? `:${initiativeId}` : ''}`;
export const planPageKey = (parent: string, position: number) =>
  `${parent}:${Math.floor(position / PLAN_PAGE_SIZE)}`;

/** Portable DEFLATE stays on the backend; neither CLI/MCP nor the web imports this module. */
export function encodePlanPage(rows: PlanRow[]): string {
  const settled =
    rows.length && rows[0]!.kind === 'issue' && ['closed', 'abandoned'].includes(rows[0]!.status);
  const value = settled ? rows.map(row => row.position) : rows;
  const bytes = deflateSync(strToU8(JSON.stringify(value)), { level: 3 });
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
export function planViewRow(value: Record<string, unknown>, position: number): PlanRow | null {
  const { id, kind, title, status } = value;
  if (typeof id !== 'string' || (kind !== 'issue' && kind !== 'initiative') || typeof title !== 'string')
    return null;
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
  };
}
