// SPDX-License-Identifier: Apache-2.0
// Disposable Plan pages share the planning partition; canonical Items and search roots stay exact.
import { deflateSync, inflateSync, strToU8, strFromU8 } from 'fflate';
import type { PlanRow } from '../src/planning-model';

export const PLAN_PAGE_SIZE = 128;
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
