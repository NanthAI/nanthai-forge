// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import type { WorkArchivePreview } from './work-archive';
export type IntentPin = {
  intentId: string;
  baseBackupId: Id<'projectBackups'>;
  baseArchiveSha256: string;
  baseState: string;
};
export type ProposalInput = IntentPin & {
  projectId: Id<'hostedProjects'>;
  operationId: string;
  head: string;
  viewId: string;
  digest: string;
  size: number;
  preview: WorkArchivePreview;
};
export type Proposal = ProposalInput & {
  _id: string;
  _creationTime: number;
  actor: string;
  status: 'uploading' | 'stored';
  transport?: 'objects';
};
export const proposals = {
  publishObjects: makeFunctionReference<'action', ProposalInput, Proposal>('projectProposalObjects:publish'),
  list: makeFunctionReference<
    'query',
    { projectId: Id<'hostedProjects'>; paginationOpts: { numItems: number; cursor: string | null } },
    { page: Proposal[]; isDone: boolean; continueCursor: string }
  >('projectProposals:list'),
  prepare: makeFunctionReference<
    'action',
    ProposalInput,
    {
      proposal: Proposal;
      uploadUrl?: string;
      target?: { kind: 'r2'; url: string; headers: Record<string, string> };
      contentType?: string;
    }
  >('projectProposalActions:prepare'),
  complete: makeFunctionReference<'action', { id: string; storageId?: Id<'_storage'> }, Proposal>(
    'projectProposalActions:complete',
  ),
  reconcile: makeFunctionReference<'action', { id: string }, Proposal>(
    'projectProposalActions:reconcileUpload',
  ),
  download: makeFunctionReference<
    'action',
    { id: string; offset: number; digest: string },
    { direct?: boolean; url?: string; data: ArrayBuffer; size: number; digest: string; filename: string }
  >('projectProposalActions:downloadPart'),
};
/** Display selection only. Server and native import validate the actual archive and source closure. */
export function proposalCandidates(work: unknown, pin: IntentPin): { id: string; head: string }[] {
  if (!work || typeof work !== 'object' || !('views' in work) || !Array.isArray(work.views)) return [];
  return work.views.flatMap(view =>
    view &&
    typeof view === 'object' &&
    view.intentId === pin.intentId &&
    view.base === pin.baseState &&
    view.status === 'clean' &&
    typeof view.id === 'string' &&
    typeof view.head === 'string'
      ? [{ id: view.id, head: view.head }]
      : [],
  );
}
