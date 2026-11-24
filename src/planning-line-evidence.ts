// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { planningTaskLines } from './planning-search.js';
import { digest } from './state/hash.js';

export type PlanningLineEvidence = { position: number; digest: string };

/** Scope evidence to a task position and exact wording; moved lines retain their positions. */
export function planningLineEvidence(position: number, wording: string): PlanningLineEvidence {
  return { position, digest: digest(wording.trim()) };
}

/** A tick may change only the addressed checkbox. Evidence cannot piggyback on another kind of body edit. */
export function isPlanningTick(before: string, after: string, line: PlanningLineEvidence) {
  const rows = before.split('\n');
  for (const { row, position, match } of planningTaskLines(rows)) {
    if (position !== line.position) continue;
    const [, head, mark, tail, text, cr] = match;
    if (mark !== ' ' || planningLineEvidence(position, text!).digest !== line.digest) return false;
    rows[row] = `${head}x${tail}${text}${cr}`;
    return rows.join('\n') === after;
  }
  return false;
}
