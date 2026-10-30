// SPDX-License-Identifier: Apache-2.0
import { WorkStore } from '../dist/work-store.js';
import { policyPreset } from '../dist/autonomy-policy.js';
/** Existing automation tests deliberately opt in; new-project defaults are tested separately. */
export function trustAgents(root) {
  const store = new WorkStore(root);
  store.locked(() => {
    const data = store.load();
    data.autonomyPolicy = policyPreset('trusted');
    store.save(data);
  });
}

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkService } from '../dist/work.js';
import { initNative } from '../dist/native-work.js';
/** Preserve the historical custom autonomy defaults in otherwise current-format fixtures. */
function makeLegacy(store) {
  const data = store.load();
  delete data.autonomyPolicy;
  writeFileSync(join(store.directory, 'work.json'), JSON.stringify(data));
}
export function initLegacyNative(root) {
  const result = initNative(root);
  makeLegacy(new WorkStore(root));
  return result;
}
/** These format fixtures explicitly keep accepted work open to isolate older record formats. */
export class LegacyWorkService extends WorkService {
  constructor(root) {
    super(root);
    const data = this.store.load();
    if (
      !existsSync(join(this.store.directory, 'work.json')) ||
      (data.autonomyPolicy?.preset === 'supervised' &&
        !data.policyChanges?.length &&
        !data.intents.length &&
        !data.lanes.length &&
        !data.views.length &&
        !data.runs.length)
    )
      makeLegacy(this.store);
  }
  dispatch(input, revision, options = {}) {
    return super.dispatch(input, revision, { ...options, keepOpen: true });
  }
}
