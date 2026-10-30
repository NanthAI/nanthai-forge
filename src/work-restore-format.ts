// SPDX-License-Identifier: Apache-2.0
import type { WorkData } from './work-types.js';
import { latestWorkFormat } from './work-format.js';
import { convertHostedIntents } from './work-hosted-intents.js';
import { parseWork } from './work-unified-types.js';
import { preserveFields } from './work-normalization.js';

/** Recovery alone converts older Work. Journal replay happens before this boundary. */
export function restoreWorkFormat(data: WorkData): WorkData {
  if (Number(data.schema) === latestWorkFormat) return data;
  const unified = convertHostedIntents(data);
  const restored = { ...unified, schema: latestWorkFormat };
  return preserveFields(parseWork(restored), restored) as WorkData;
}
