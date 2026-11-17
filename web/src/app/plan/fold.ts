// SPDX-License-Identifier: Apache-2.0
// Which Initiative groups of the backlog are folded (Item 4df3ee17; decision afcb5bc3): per viewer, on this browser
// only, never a server write. One record per project: a base (everything open, or everything folded by Collapse all)
// and the groups flipped from it since, so Collapse all also folds an Initiative created later.
import { useCallback, useState } from 'react';

export type Folds = { base: 'open' | 'shut'; flip: readonly string[] };
/** Group id of the Items in no Initiative. */
export const NO_INITIATIVE = 'none';
/** Flipped groups kept per project; past this the oldest flips are dropped (a bounded entry). */
export const FOLD_FLIPS = 400;
const key = (projectId: string) => `forge.plan.folds.${projectId}`;
const allOpen: Folds = { base: 'open', flip: [] };

export const isShut = (folds: Folds, id: string) => (folds.base === 'shut') !== folds.flip.includes(id);

export function toggled(folds: Folds, id: string): Folds {
  const flip = folds.flip.includes(id)
    ? folds.flip.filter(other => other !== id)
    : [...folds.flip, id].slice(-FOLD_FLIPS);
  return { base: folds.base, flip };
}

/** Collapse all or Expand all: the base changes and every flip is forgotten. */
export const allFolds = (base: Folds['base']): Folds => ({ base, flip: [] });

export function readFolds(raw: string | null): Folds {
  try {
    const value = JSON.parse(raw ?? 'null');
    if (value && (value.base === 'open' || value.base === 'shut') && Array.isArray(value.flip))
      return {
        base: value.base,
        flip: value.flip.filter((id: unknown) => typeof id === 'string').slice(-FOLD_FLIPS),
      };
  } catch {
    /* An unreadable entry folds nothing. */
  }
  return allOpen;
}

function load(projectId: string) {
  try {
    return readFolds(localStorage.getItem(key(projectId)));
  } catch {
    return allOpen;
  }
}

/** The project's folds and the two ways to change them; written only when the reader folds or unfolds. */
export function usePlanFolds(projectId: string) {
  const [state, setState] = useState(() => ({ projectId, folds: load(projectId) }));
  const folds = state.projectId === projectId ? state.folds : load(projectId);
  const save = useCallback(
    (next: Folds) => {
      setState({ projectId, folds: next });
      try {
        localStorage.setItem(key(projectId), JSON.stringify(next));
      } catch {
        // a private window keeps the folds for this visit only
      }
    },
    [projectId],
  );
  return {
    folds,
    toggle: (id: string) => save(toggled(folds, id)),
    setAll: (base: Folds['base']) => save(allFolds(base)),
  };
}
