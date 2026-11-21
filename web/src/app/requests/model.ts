// SPDX-License-Identifier: Apache-2.0
// A bulk permanent-delete request as the owner reads it (Item 7456856f), as data: the page sentence, the rows with their
// state, what goes for good and whether the typed count confirms. Pure; the page supplies the live read
// (projectDeleteRequests:read) and the owner's choices (projects kept out, the number typed).

export type RequestOutcome = 'started' | 'deleted' | 'failed' | 'changed' | 'refused' | 'kept' | null;
export type RequestProject = {
  projectId: string;
  slug: string;
  bytes: number;
  trash: boolean;
  lastLandingAt: number | null;
  outcome: RequestOutcome;
};
export type DeleteRequestRead = {
  id: string;
  status: 'requested' | 'approved' | 'declined' | 'withdrawn' | 'expired';
  selector: string;
  byDevice: boolean;
  at: string;
  expiresAt: string;
  projects: RequestProject[];
  reason?: string;
};
export type RowState = { word: string; tone: 'passed' | 'failed' | 'stale' | 'active' | 'waiting' | null };

export function bytesText(bytes: number) {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes > 0) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return '0 MB';
}
const n = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString('en')} ${count === 1 ? one : many}`;

const ROW: Record<Exclude<RequestOutcome, null>, RowState> = {
  started: { word: 'Deleting', tone: 'active' },
  deleted: { word: 'Deleted', tone: 'passed' },
  failed: { word: 'Could not delete', tone: 'failed' },
  changed: { word: 'Skipped, it changed', tone: 'stale' },
  refused: { word: 'Not yours, left alone', tone: 'stale' },
  kept: { word: 'Kept', tone: 'stale' },
};
export const rowState = (project: RequestProject, kept: ReadonlySet<string>): RowState | null =>
  project.outcome ? ROW[project.outcome] : kept.has(project.projectId) ? ROW.kept : null;

export function requestView(read: DeleteRequestRead, kept: ReadonlySet<string>, typed: string) {
  const open = read.status === 'requested';
  const go = read.projects.filter(project =>
    open ? !kept.has(project.projectId) : project.outcome !== 'kept' && project.outcome !== null,
  );
  const bytes = go.reduce((sum, project) => sum + project.bytes, 0);
  const notInTrash = go.filter(project => !project.trash).length;
  const count = go.length;
  const done = read.projects.filter(project => project.outcome === 'deleted').length;
  const failed = read.projects.filter(project => project.outcome === 'failed').length;
  const running = read.projects.filter(project => project.outcome === 'started').length;
  const skipped = read.projects.filter(
    project => project.outcome === 'changed' || project.outcome === 'refused',
  ).length;
  const confirmed = open && count > 0 && typed.trim() === String(count);
  let sentence: { bold: string; rest: string };
  if (read.status === 'expired')
    sentence = {
      bold: 'This request expired.',
      rest: `Nothing was deleted. The ${n(read.projects.length, 'project')} are where they were.`,
    };
  else if (read.status === 'declined')
    sentence = { bold: 'You declined this request.', rest: 'Nothing was deleted. The agent was told.' };
  else if (read.status === 'withdrawn')
    sentence = { bold: 'The request was withdrawn.', rest: 'Nothing was deleted.' };
  else if (read.status === 'approved' && running)
    sentence = {
      bold: `Deleting ${done.toLocaleString('en')} of ${count.toLocaleString('en')}.`,
      rest: 'You can leave this page; it carries on.',
    };
  else if (read.status === 'approved' && failed)
    sentence = {
      bold: `${done.toLocaleString('en')} of ${count.toLocaleString('en')} deleted. ${n(failed, 'project')} could not be.`,
      rest: 'Retry resumes only the purges that stopped.',
    };
  else if (read.status === 'approved')
    sentence = {
      bold: `${n(done, 'project')} deleted for good.`,
      rest: skipped ? `${n(skipped, 'project')} skipped, named below.` : 'It is in the log.',
    };
  else
    sentence = {
      bold: `${n(count, 'project')} to delete for good.`,
      rest: `${read.byDevice ? 'An agent sign-in' : 'You'} made the list. Approving removes ${count === 1 ? 'it' : 'all of them'} at once and cannot be undone.`,
    };
  return { open, go, count, bytes, notInTrash, done, failed, running, skipped, confirmed, sentence };
}
