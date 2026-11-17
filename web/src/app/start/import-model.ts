// SPDX-License-Identifier: Apache-2.0
// The import screen's words and stages (Items a488af2a, 2abda01f): what one progress read means for the person, said
// from the recorded facts. `now` is the render's clock, never a query argument.
import type { ImportVisibility } from '../../../../src/github-import-report';

export type ImportProgress = {
  projectId: string;
  phase: string;
  completed: number;
  total: number;
  error: { code: string; message: string; retryAt?: number; resumeAt?: number } | null;
};
export type ImportStage =
  | { kind: 'importing'; done: number; total: number }
  /** GitHub's limit stopped it: Forge resumes at `at` (scheduled) or waits for a person to choose. */
  | { kind: 'paused'; at: number; scheduled: boolean; done: number; total: number }
  | { kind: 'stopped'; code: string; message: string; done: number; total: number }
  | { kind: 'ready'; projectId: string };

export function importStage(progress: ImportProgress, now: number): ImportStage {
  const counts = { done: progress.completed, total: progress.total };
  if (progress.phase === 'ready') return { kind: 'ready', projectId: progress.projectId };
  if (progress.phase === 'paused' && progress.error?.resumeAt)
    return { kind: 'paused', at: progress.error.resumeAt, scheduled: true, ...counts };
  if (progress.phase === 'error' && progress.error) {
    const at = progress.error.retryAt;
    if (at !== undefined && at > now) return { kind: 'paused', at, scheduled: false, ...counts };
    return { kind: 'stopped', code: progress.error.code, message: progress.error.message, ...counts };
  }
  return { kind: 'importing', ...counts };
}

const n = new Intl.NumberFormat('en-US');
export const num = (value: number) => n.format(value);
export const count = (value: number, one: string, many = `${one}s`) =>
  `${n.format(value)} ${value === 1 ? one : many}`;
export const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export function bytes(value: number) {
  const units = ['bytes', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) {
    size /= 1000;
    unit++;
  }
  return `${unit ? (Math.round(size * 10) / 10).toString() : n.format(size)} ${units[unit]}`;
}

/** The visibility question, said for this origin. One choice: the sentence says why. */
export function visibilityWords(origin: ImportVisibility, choices: readonly ImportVisibility[]) {
  return choices.length > 1
    ? 'Public on GitHub. Private here keeps it to you until you are ready.'
    : `${origin === 'private' ? 'Private' : 'Public'} on GitHub, so ${origin} here.`;
}

/** The mirror question (Item c63c2171): asked once, Yes preselected; the mirror is on either way. */
export const mirrorAnswers = {
  'two-way': {
    sub: 'Two-way mirror. Each landing goes to GitHub main as one commit, and a push there becomes a Forge landing that passes the same check.',
  },
  'one-way': {
    sub: 'One-way mirror, Forge to GitHub. A push made on GitHub is not taken in; Forge stops and asks instead of pushing over it.',
  },
} as const;
export type MirrorAnswer = keyof typeof mirrorAnswers;

/** OWNER/NAME from an address the import accepted (a GitHub URL, a clone URL or OWNER/NAME). */
export function repositoryOf(url: string) {
  const found =
    url.match(/github\.com[/:]([^/\s]+)\/([^/#?\s]+?)(?:\.git)?(?:[/#?]|$)/) ??
    url.match(/^([\w.-]+)\/([\w.-]+)$/);
  return found ? `${found[1]}/${found[2]}` : url;
}

/** The command a person or agent would run for the same import. */
export function importCommand(url: string, ref: string, visibility: ImportVisibility | null) {
  return [
    'nforge import',
    url || 'https://github.com/OWNER/REPO',
    ref ? `--ref ${ref}` : '',
    visibility === 'private' ? '--private' : '',
  ]
    .filter(Boolean)
    .join(' ');
}
