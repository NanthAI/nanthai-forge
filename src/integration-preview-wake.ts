// SPDX-License-Identifier: Apache-2.0
import { scheduleIntegrationPreview } from './integration-preview-auto.js';
import type { WorkStore } from './work-store.js';
import type { WorkRecordTransaction } from './work-record-transaction.js';

/** Committed source/configuration changes are wake hints. Reads never launch
 * previews. Exact tuple deduplication ignores unrelated notes and repeated saves. */
export function wakeIntegrationPreview(
  store: WorkStore,
  before: WorkRecordTransaction | undefined,
  after: WorkRecordTransaction | undefined,
) {
  try {
    if (
      !before?.data().autonomyPolicy?.integrationPreview?.auto ||
      !after?.data().autonomyPolicy?.integrationPreview?.auto
    )
      return;
    if (
      ['lanes', 'channelMoves', 'intents', 'views', 'checks'].some(
        name =>
          JSON.stringify(before?.manifest.collections[name]?.pages) !==
          JSON.stringify(after.manifest.collections[name]?.pages),
      )
    )
      scheduleIntegrationPreview(store);
  } catch {
    // The committed mutation is independent of advisory preview availability.
  }
}
