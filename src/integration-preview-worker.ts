// SPDX-License-Identifier: Apache-2.0
import { WorkStore } from './work-store.js';
import { drainIntegrationPreviews } from './integration-preview-auto.js';

if (process.argv[2]) {
  await drainIntegrationPreviews(
    WorkStore.open<
      | 'commitRecords'
      | 'directory'
      | 'laneLocked'
      | 'load'
      | 'locked'
      | 'lockedAsync'
      | 'native'
      | 'observing'
      | 'page'
      | 'path'
      | 'pinnedBytes'
      | 'pinnedData'
      | 'pointer'
      | 'prepareCommitRecords'
      | 'prepareSave'
      | 'preparing'
      | 'publishSave'
      | 'readRecords'
      | 'records'
      | 'revision'
      | 'root'
      | 'save'
      | 'select'
      | 'snapshotBytes'
    >(process.argv[2]),
  );
}
