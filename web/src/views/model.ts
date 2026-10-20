// SPDX-License-Identifier: Apache-2.0
import type { ViewReadModel } from '../../../src/view-read-model';
import type { FileProvenancePlan } from '../../../src/view-provenance-plan';
import type { readFileProvenance } from '../../../src/view-provenance';
import type { Tone } from '../ui/status';
export type ViewModel = ViewReadModel & {
  files: {
    items: FileRow[];
    total: number;
    nextOffset?: number | null;
    nextCursor?: string | null;
    unavailable?: string;
  };
  runs?: { id: string; status: string; startedAt?: string; check?: { name?: string }; checkName?: string }[];
};
export type FileRow = Partial<FileProvenancePlan> & {
  additions?: number | null;
  deletions?: number | null;
  lines?: Extract<Awaited<ReturnType<typeof readFileProvenance>>, { lines: unknown }>['lines'];
  path: string;
  status: FileProvenancePlan['status'];
  why?: {
    intentId: string;
    outcome: string | null;
    notes: { id: string; kind: string; excerpt: string; at: string }[];
  }[];
};
export type ReadRequest = {
  action: 'view' | 'provenance' | 'views';
  viewId?: string;
  laneId?: string;
  file?: string;
  lines?: boolean;
  cursor?: string | null;
  offset?: number;
};
export type ReadSource = (
  request: ReadRequest,
) => Promise<ViewModel & { items?: ViewReadModel[]; nextCursor?: string | null; nextOffset?: number | null }>;
export function viewStatus(
  view: Pick<ViewReadModel, 'status'>,
  check?: string,
  behind = false,
): [Tone, string] {
  if (view.status === 'accepted') return ['passed', 'Accepted'];
  if (view.status === 'superseded') return ['stale', 'Superseded'];
  if (view.status === 'conflict') return ['conflict', 'Conflict'];
  if (check === 'passed') return ['passed', 'Check passed'];
  if (check === 'failed') return ['failed', 'Check failed'];
  if (check === 'cancelled' || check === 'interrupted')
    return ['stale', check === 'cancelled' ? 'Cancelled' : 'Interrupted'];
  if (check && ['queued', 'preparing', 'running'].includes(check)) return ['running', `Check ${check}`];
  return ['plain', behind ? 'Check result not synced' : 'Not checked'];
}
