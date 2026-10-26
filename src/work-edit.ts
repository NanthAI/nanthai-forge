import { stageWorkEdit } from './work-edit-records.js';
// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';
import { retryWorkPhase } from './work-retry.js';
import { readWorkFile, prepareRecordPublication } from './work-records.js';
import { pendingRecordWriter } from './work-record-staging.js';
import type { WorkStore } from './work-store.js';
import type { WorkData } from './work-types.js';

/** Internal retry signal for a changed Work pointer or collected prepared source. */
export class PreparationChanged extends ForgeError {
  constructor(
    message = 'Work changed during preparation. Retry the original operation; nothing was overwritten.',
  ) {
    super('WORK_STALE', message);
  }
}
/** Compute against one committed pointer and stage immutable pages without the
 * writer lock; the final fence and pointer CAS run together under the lock.
 * edit must only mutate its private data or write immutable source objects.
 * validatePreparation checks those objects after preparation and before commit;
 * it can signal PreparationChanged to restore them on the next attempt.
 * Two optimistic attempts keep holds short; a third prepares under the lock so
 * a long preparation always makes progress under steady concurrent writes. */
export function editWork<T>(
  store: WorkStore,
  edit: (data: WorkData) => T,
  beforePublish?: () => void,
  validatePreparation?: () => void,
): T {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return editWorkOnce(store, edit, beforePublish, validatePreparation, false);
    } catch (error) {
      if (!(error instanceof PreparationChanged)) throw error;
    }
  }
  return editWorkOnce(store, edit, beforePublish, validatePreparation, true);
}
function editWorkOnce<T>(
  store: WorkStore,
  edit: (data: WorkData) => T,
  beforePublish: (() => void) | undefined,
  validatePreparation: (() => void) | undefined,
  underLock: boolean,
): T {
  const release = pendingRecordWriter(store.directory);
  try {
    const prepare = () =>
      store.observing(() => {
        const pointer = store.pointer();
        try {
          const data = store.load();
          const before = JSON.stringify(data),
            revision = data.revision;
          const result = edit(data);
          const changed = JSON.stringify(data) !== before;
          if (changed && data.revision === revision) data.revision++;
          const manifest = changed
            ? store.prepareSave(data, (directory, value) =>
                stageWorkEdit(directory, value as WorkData, before, pointer),
              )
            : undefined;
          return {
            pointer,
            result,
            manifest,
            publish: manifest ? prepareRecordPublication(store.directory, manifest) : undefined,
          };
        } catch (error) {
          return { pointer, error };
        }
      });
    const optimistic = underLock ? undefined : prepare();
    return store.locked(() => {
      beforePublish?.();
      const prepared = optimistic ?? prepare();
      const current = readWorkFile(store.directory);
      if (!(prepared.pointer === null ? current === null : !!current && prepared.pointer.equals(current)))
        throw new PreparationChanged();
      if ('error' in prepared) throw prepared.error;
      // Validate the current preparation, including when the progress fallback
      // has just restored collected source under the lock. Driver fences above
      // still run before any fallback preparation or source write.
      validatePreparation?.();
      if (prepared.manifest) {
        try {
          store.publishSave(prepared.manifest, prepared.publish);
        } catch (error) {
          if (error instanceof ForgeError && error.code === 'WORK_STALE') throw new PreparationChanged();
          throw error;
        }
      }
      return prepared.result;
    });
  } finally {
    release();
  }
}

/** Retry publication races only. A changed binding/operation reported by edit is
 * a semantic conflict: return it immediately rather than retrying stale inputs. */
export async function retryWorkEdit<T>(store: WorkStore, operationId: string, edit: (data: WorkData) => T) {
  const result = await retryWorkPhase(operationId, () => {
    try {
      return { value: editWork(store, edit) };
    } catch (error) {
      if (error instanceof PreparationChanged || (error instanceof ForgeError && error.code === 'WORK_BUSY'))
        throw error;
      return { error };
    }
  });
  if ('error' in result) throw result.error;
  return result.value;
}
