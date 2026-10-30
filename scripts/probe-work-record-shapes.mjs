// SPDX-License-Identifier: Apache-2.0
// Read-only: no exchange preparation, owner lock, publication or network calls.
// Build first. --legacy reproduces the old exchange validator on current records.
import { WorkStore } from '../dist/work-store.js';
import { workSchema } from '../dist/work-types.js';
import { unifiedWorkSchema, isUnifiedWork } from '../dist/work-unified-types.js';
import { recordKey } from '../dist/work-exchange-records.js';

const [owner, mode] = process.argv.slice(2);
if (!owner || (mode && mode !== '--legacy'))
  throw new Error('Usage: node scripts/probe-work-record-shapes.mjs OWNER [--legacy]');
const store = new WorkStore(owner);
const data = store.pinnedData(store.pointer());
const shape = mode !== '--legacy' && isUnifiedWork(data) ? unifiedWorkSchema.shape : workSchema.shape;
for (const [collection, records] of Object.entries(data)) {
  if (!Array.isArray(records) || !Object.hasOwn(shape, collection)) continue;
  for (const value of records) {
    const id = recordKey(value, collection);
    const result = shape[collection].safeParse([value]);
    if (!result.success)
      console.log(
        JSON.stringify({ collection, id, paths: result.error.issues.map(issue => issue.path.slice(1)) }),
      );
  }
}
