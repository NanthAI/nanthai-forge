// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Trash as words (Item 8fba39a4, SPEC-01-trash): one row form per project phase, the page sentence and the dates.
// Pure: the page supplies the rows it read and the clock. Phases come from src/project-phase.ts, the one derive the CLI
// and the old screen share; this file adds no state words of its own.
import type { FunctionReturnType } from 'convex/server';
import type { api } from '../../../../convex/_generated/api';
import { deriveProjectPhase } from '../../../../src/project-phase';
import { bytesText } from '../requests/model';

export type TrashProject = FunctionReturnType<typeof api.projectBackups.list>['page'][number];
export const DAY = 86_400_000;
/** Deleted projects stay restorable this long (convex/projectRetention.ts projectRetentionMs). */
export const RETENTION_DAYS = 90;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString('en')} ${count === 1 ? one : many}`;
export const dayText = (at: number) =>
  new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const longDay = (at: number) =>
  new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
/** Whole days until `at`, counted up so "1 day left" is the last day; never negative. */
export const daysUntil = (at: number, now: number) => Math.max(0, Math.ceil((at - now) / DAY));
export const untilDay = (now: number) => longDay(now + RETENTION_DAYS * DAY);

export type TrashKey = 'restore' | 'restore-wait' | 'forever' | 'retry' | 'ask';
export type TrashForm = {
  kind: 'restorable' | 'revoking' | 'ended' | 'purging' | 'stopped' | 'unconfirmed' | 'deleted';
  /** Time-left cell: a bold line and the line under it; null when the cell holds a state word. */
  left: { head: string; sub: string } | null;
  state: { word: string; tone: 'active' | 'failed' | 'passed' | 'stale'; reason?: string } | null;
  keys: readonly TrashKey[];
  /** Added to the meta line. */
  note?: string;
};

/** The row form of one project (SPEC-01-trash, "Screens" 3). */
export function trashForm(project: TrashProject, now: number): TrashForm {
  const phase = deriveProjectPhase(project, now);
  const purgeAt = project.retention?.purgeAt;
  switch (phase.state) {
    case 'restorable':
    case 'trashed': {
      if (purgeAt !== undefined && now >= purgeAt)
        return {
          kind: 'ended',
          left: { head: 'No time left', sub: 'Removal starts on its own.' },
          state: null,
          keys: [],
        };
      const left =
        purgeAt === undefined
          ? { head: 'Deleted', sub: 'no end date recorded' }
          : {
              head: `${plural(daysUntil(purgeAt, now), 'day')} left`,
              sub: `deleted for good ${dayText(purgeAt)}`,
            };
      const revoking = phase.state === 'trashed';
      return {
        kind: revoking ? 'revoking' : 'restorable',
        left,
        state: null,
        keys: [revoking ? 'restore-wait' : 'restore', 'forever'],
        ...(revoking ? { note: 'access is still being removed, restore is ready in a moment' } : {}),
      };
    }
    case 'purging':
      return { kind: 'purging', left: null, state: { word: 'Deleting', tone: 'active' }, keys: [] };
    case 'purge-blocked':
      return {
        kind: 'stopped',
        left: null,
        state: { word: 'Could not delete', tone: 'failed', reason: phase.reason ?? phase.nextStep },
        keys: ['retry'],
      };
    case 'purged-with-leftovers':
      return {
        kind: 'unconfirmed',
        left: {
          head: 'Deleted',
          sub: 'Removal was never confirmed: its records and stored data may remain.',
        },
        state: null,
        keys: ['ask'],
      };
    default:
      return { kind: 'deleted', left: null, state: { word: 'Deleted', tone: 'passed' }, keys: [] };
  }
}

/** Rows to list: finished tombstones are not the Trash (they stay only for the visit that deleted them). */
export function listed(projects: readonly TrashProject[], keep: ReadonlySet<string>, now: number) {
  return projects.filter(
    project => deriveProjectPhase(project, now).state !== 'purged' || keep.has(project.id as string),
  );
}
/** Soonest to go first: end of the restore window ascending; rows with no window follow in the server's order. */
export function soonest(projects: readonly TrashProject[]) {
  const end = (project: TrashProject) => project.retention?.purgeAt ?? Number.POSITIVE_INFINITY;
  return [...projects].sort((a, b) => end(a) - end(b));
}

export const sizeText = (project: TrashProject) =>
  project.retention?.measured ? bytesText(project.retention.retainedBytes) : 'not reported';
export const address = (project: TrashProject) =>
  project.handle && project.slug ? `${project.handle}/${project.slug}` : (project.slug ?? project.name);
/** "owner/slug · moved here DATE"; who moved it is not recorded, so it is left out. */
export const movedWords = (project: TrashProject) =>
  project.removedAt ? `moved here ${dayText(project.removedAt)}` : null;

/** The page sentence: how many, how big, and the one that goes first (SPEC-01-trash, "Screens" 3). */
export function trashSentence(rows: readonly TrashProject[], more: boolean, now: number) {
  if (!rows.length) return { bold: 'Nothing in the trash.', rest: '' };
  const count = `${more ? 'At least ' : ''}${plural(rows.length, 'project')} in the trash`;
  const measured = rows.filter(row => row.retention?.measured);
  const bytes = measured.reduce((sum, row) => sum + (row.retention?.retainedBytes ?? 0), 0);
  const size = measured.length
    ? `, ${more || measured.length < rows.length ? 'at least ' : ''}${bytesText(bytes)}`
    : '';
  const first = rows.find(row => {
    const form = trashForm(row, now);
    return form.kind === 'restorable' || form.kind === 'revoking';
  });
  const days = first?.retention ? daysUntil(first.retention.purgeAt, now) : 0;
  const goes = first
    ? ` ${first.name.length > 40 ? `${first.name.slice(0, 38)}…` : first.name} is deleted for good in ${plural(days, 'day')}.`
    : '';
  return { bold: `${count}${size}.`, rest: goes.trim() };
}
