// SPDX-License-Identifier: Apache-2.0
import { WorkRecordTransaction } from './work-record-transaction.js';
import { ForgeError, invariant } from './errors.js';
import { readWorkFile, recordManifest, readRecordPage } from './work-records.js';
import { checkRunSchema, type CheckRun } from './work-types.js';
import type { WorkStore } from './work-store.js';

/** Cache only observations from the existing Work owner, never a second run authority. */
export class SelectedRunObserver {
  private position?: number;
  private revision?: number;
  private observed?: CheckRun;
  constructor(
    private readonly store: WorkStore,
    private readonly id: string,
  ) {}
  read(): CheckRun {
    try {
      return this.current();
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      throw new ForgeError(
        'INVALID_WORK_STORE',
        'The selected run observation is invalid. Existing Work is preserved.',
      );
    }
  }
  private current(): CheckRun {
    const bytes = readWorkFile(this.store.directory),
      raw: unknown = bytes ? JSON.parse(bytes.toString('utf8')) : undefined;
    const manifest = recordManifest(raw);
    // Legacy journals retain their existing validation; indexed owners never decode other collections.
    if (!manifest) {
      const run = this.store.load().runs.find(item => item.id === this.id);
      invariant(run, 'NOT_FOUND', 'Run not found.');
      return run;
    }
    const revision = manifest.fields.revision;
    invariant(
      typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0,
      'INVALID_WORK_STORE',
      'Work revision is invalid.',
    );
    if (this.revision === revision && this.observed?.id === this.id) return this.observed;
    const page = (offset: number, limit: number) =>
      readRecordPage(this.store.directory, manifest, 'runs', offset, limit);
    const remember = (value: unknown, position: number) => {
      const run = checkRunSchema.parse(value);
      this.position = position;
      this.revision = revision;
      this.observed = run;
      return run;
    };
    if (manifest.schema !== 'forge-work-records-v1' && manifest.collections.runs?.lookup) {
      const selected = new WorkRecordTransaction(this.store.directory, manifest, bytes!).find(
        'runs',
        this.id,
      );
      invariant(selected, 'NOT_FOUND', 'Run not found.');
      return remember(selected.record, selected.position);
    }
    if (this.position !== undefined) {
      const value = page(this.position, 1).records[0] as CheckRun | undefined;
      if (value?.id === this.id) return remember(value, this.position);
    }
    // One immutable manifest pins this lookup, including a moved/previously unknown record.
    for (let offset = 0; ;) {
      const current = page(offset, 128),
        index = current.records.findIndex(value => (value as CheckRun)?.id === this.id);
      if (index >= 0) return remember(current.records[index], offset + index);
      invariant(current.nextOffset !== null, 'NOT_FOUND', 'Run not found.');
      offset = current.nextOffset;
    }
  }
}
