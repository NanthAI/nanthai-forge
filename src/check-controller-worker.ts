// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { runCheckController } from './check-controller.js';
import { WorkStore } from './work-store.js';

// Keep the executable separate: awaiting execution in the reusable module would
// deadlock its dynamic import of work-run (which also imports that module).
const keepAlive = setInterval(() => undefined, 60_000);
try {
  if (process.argv[2] && process.argv[3])
    await runCheckController(
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
      process.argv[3],
    );
} finally {
  clearInterval(keepAlive);
}
