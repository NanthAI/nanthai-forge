// SPDX-License-Identifier: Apache-2.0
/** Presentation only: never persist this label in the Work store. Count every retained Lane. */
export function intentProgress(status: string, laneCount: number) {
  if (status === 'proposed') return 'Proposed';
  if (status === 'active') return laneCount === 0 ? 'Planned' : 'Working';
  if (status === 'completed') return 'Done';
  if (status === 'abandoned') return 'Abandoned';
  return 'Ready';
}
