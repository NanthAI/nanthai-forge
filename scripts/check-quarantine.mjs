// SPDX-License-Identifier: Apache-2.0
import { WorkStore } from '../dist/work-store.js';
import { checkQuarantine, fixQuarantinedTest } from '../dist/check-quarantine.js';
const [root, action = 'list', operationId, test] = process.argv.slice(2);
if (!root || !['list', 'fix'].includes(action) || (action === 'fix' && (!operationId || !test)))
  throw new Error(
    'Usage: node scripts/check-quarantine.mjs OWNER [list | fix OPERATION_UUID "tests/file :: test name"]',
  );
const store = new WorkStore(root);
process.stdout.write(
  `${JSON.stringify(action === 'fix' ? fixQuarantinedTest(store, operationId, test) : checkQuarantine(store))}\n`,
);
