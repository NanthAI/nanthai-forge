// SPDX-License-Identifier: Apache-2.0
import { policyPreset } from './autonomy-policy.js';
import { latestWorkFormat } from './work-format.js';
import { unifiedWorkSchema } from './work-unified-types.js';
import type { WorkData } from './work-types.js';

/** A new store has no historical conversion facts or receipt to invent. */
export function createWork(nativeHead?: string): WorkData {
  return unifiedWorkSchema.parse({
    schema: latestWorkFormat,
    revision: 0,
    workDetailsMigrated: true,
    autonomyPolicy: policyPreset('supervised'),
    ...(nativeHead ? { nativeHead } : {}),
    intents: [],
    initiatives: [],
    intentAliases: [],
    lanes: [],
    views: [],
  }) as unknown as WorkData;
}
