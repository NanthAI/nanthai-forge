// SPDX-License-Identifier: Apache-2.0
import type { FileProvenancePlan, ProvenanceFile } from './view-provenance-plan.js';
import {
  alignment,
  advanceAttribution,
  attributionRanges,
  type Attribution,
} from './view-line-attribution.js';

export async function readFileProvenance(
  file: FileProvenancePlan,
  read: (blob: string) => Promise<Buffer>,
  lines = false,
  size?: (blob: string) => number,
) {
  const unchangedContent = file.before?.blob === file.after?.blob;
  const oversized = [
    file.before,
    file.after,
    ...(lines ? file.contributors.flatMap(c => c.saves.flatMap(s => [s.before, s.after])) : []),
  ].some(entry => entry && size && size(entry.blob) > 1024 * 1024);
  if (oversized)
    return {
      ...file,
      additions: unchangedContent ? 0 : null,
      deletions: unchangedContent ? 0 : null,
      reason: 'Too large for exact line counts',
      ...(lines
        ? {
            lines: {
              status: 'unavailable' as const,
              reason: 'Too large for line attribution (1 MiB)',
              ranges: [],
            },
          }
        : {}),
    };
  const bytes = (entry: ProvenanceFile | null) =>
    entry ? read(entry.blob) : Promise.resolve(Buffer.alloc(0));
  const [before, after] = await Promise.all([bytes(file.before), bytes(file.after)]);
  const diff = alignment(before, after);
  const changes = unchangedContent
    ? { additions: 0, deletions: 0 }
    : diff
      ? {
          additions: diff.edits.reduce((sum, edit) => sum + edit.lines.length, 0),
          deletions: diff.edits.reduce((sum, edit) => sum + edit.end - edit.start, 0),
        }
      : { additions: null, deletions: null, reason: 'Binary or too large for exact line counts' };
  if (!lines) return { ...file, ...changes };
  const unavailable = (reason: string) => ({
    ...file,
    ...changes,
    lines: { status: 'unavailable' as const, reason, ranges: [] },
  });
  if (!diff)
    return unavailable(
      'Binary or too large for line attribution (1 MiB, 20,000 lines or diff computation budget)',
    );
  const baseLines: boolean[] = [];
  let baseCursor = 0;
  for (const edit of diff.edits) {
    baseLines.push(
      ...Array.from({ length: edit.start - baseCursor }, () => true),
      ...edit.lines.map(() => false),
    );
    baseCursor = edit.end;
  }
  baseLines.push(...Array.from({ length: diff.before - baseCursor }, () => true));
  const output: Attribution[][] = Array.from({ length: diff.after }, () => []);
  for (const contributor of file.contributors) {
    let current = before,
      labels: (Attribution | null)[] = Array.from({ length: diff.before }, () => null);
    for (const save of contributor.saves) {
      const parent = await bytes(save.before),
        saved = await bytes(save.after);
      // A sync/undo can jump to a parent outside the recorded chain. Preserve
      // only aligned labels; newly introduced source has no claimed authorship.
      const parentLabels = advanceAttribution(current, parent, labels, null);
      if (!parentLabels) return unavailable('Too large for line attribution along the save chain');
      const next = advanceAttribution(parent, saved, parentLabels, {
        laneId: contributor.laneId,
        saveIndex: save.saveIndex,
        head: save.head,
      });
      if (!next) return unavailable('Too large for line attribution along the save chain');
      current = saved;
      labels = next;
    }
    const projected = advanceAttribution(current, after, labels, null);
    if (!projected) return unavailable('Too large for line attribution when aligning the View version');
    projected.forEach((label, index) => {
      if (label) output[index]!.push(label);
    });
  }
  return {
    ...file,
    ...changes,
    lines: { status: 'available' as const, ranges: attributionRanges(output, baseLines) },
  };
}
