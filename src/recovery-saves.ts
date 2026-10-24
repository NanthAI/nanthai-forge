// SPDX-License-Identifier: Apache-2.0
import { digest } from './hash.js';
import type { WorkData } from './work-types.js';

export type RecoverySave = {
  kind: 'checkpoint' | 'check-completion' | 'work-mutation';
  id: string;
  at: string | null;
  sha256: string;
};
function timestamp(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const times = Object.entries(value).flatMap(([key, item]) => {
    if (typeof item === 'string' && /^(at|.*At)$/.test(key) && Number.isFinite(Date.parse(item)))
      return [item];
    const nested = timestamp(item);
    return nested ? [nested] : [];
  });
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}
/** Fingerprints contain no note text, logs, commands or credentials. Dates are observations,
 * not revision clocks: a changed record without a newer date has unknown save time. */
export function recoverySaves(data: WorkData): RecoverySave[] {
  const saves: RecoverySave[] = [];
  const add = (kind: RecoverySave['kind'], id: string, value: unknown, at = timestamp(value)) =>
    saves.push({
      kind,
      id,
      at: at && Number.isFinite(Date.parse(at)) ? at : null,
      sha256: digest(JSON.stringify(value)),
    });
  for (const lane of data.lanes)
    for (const [index, checkpoint] of lane.checkpoints.entries())
      add('checkpoint', `${lane.id}:${checkpoint.operation?.id ?? index}`, checkpoint, checkpoint.at);
  for (const run of data.runs) if (run.endedAt) add('check-completion', run.id, run, run.endedAt);
  for (const [key, value] of Object.entries(data)) {
    if (key === 'revision') continue;
    if (Array.isArray(value)) {
      for (const [index, record] of value.entries()) {
        const id = record && typeof record === 'object' ? (record as { id?: string }).id : undefined;
        add('work-mutation', `${key}:${id ?? index}`, record);
      }
    } else add('work-mutation', key, value);
  }
  return saves;
}

export function pendingRecoverySaves(current: RecoverySave[], baseline: RecoverySave[]) {
  const prior = new Map(baseline.map(save => [`${save.kind}:${save.id}`, save]));
  const changed = current.flatMap(save => {
    const previous = prior.get(`${save.kind}:${save.id}`);
    if (previous?.sha256 === save.sha256) return [];
    return [
      {
        ...save,
        at:
          previous && (!save.at || (previous.at && Date.parse(save.at) <= Date.parse(previous.at)))
            ? null
            : save.at,
      },
    ];
  });
  const present = new Set(current.map(save => `${save.kind}:${save.id}`));
  for (const save of baseline)
    if (!present.has(`${save.kind}:${save.id}`)) changed.push({ ...save, at: null });
  return changed;
}
