// SPDX-License-Identifier: Apache-2.0
import { WorkStore } from './work-store.js';
import { drainIntegrationPreviews } from './integration-preview-auto.js';

if (process.argv[2]) {
  await drainIntegrationPreviews(new WorkStore(process.argv[2]));
}
