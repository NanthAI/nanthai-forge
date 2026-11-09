// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { clientCacheRoot } from './root-paths.js';
import { digest } from './hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { checkoutPathExists } from './hosted-checkout-files.js';
import { readHostedLaneCheckout } from './hosted-lane-checkout-marker.js';

/** Local pending-save files only (no network, no checkout code): every agent command reads them
 * before its first call, so they stay out of the save client's module graph. */

/** One retained save per checkout baseline; its reply may be lost while it publishes. */
export const pendingSavePath = (root: string, marker: unknown) =>
  join(clientCacheRoot(root), `save-baseline-${digest(canonicalPayload(marker))}.json`);

export const saveCommandSchema = z
  .object({ operationId: z.uuid(), message: z.string(), supersedeFinish: z.boolean().optional() })
  .strict();

/** A save returned before its settle (fea47345 C) keeps this marker in its directory until the
 * outcome is applied and, when it failed, reported. */
export const backgroundSaveName = 'background';

/** The operation id of this checkout's pending save when it returned before its settle (local
 * files only, no call). */
export function backgroundSaveOperation(root: string): string | undefined {
  const marker = readHostedLaneCheckout(root);
  if (!marker) return undefined;
  const pending = pendingSavePath(root, marker);
  if (!checkoutPathExists(pending)) return undefined;
  const prior = saveCommandSchema.parse(JSON.parse(readFileSync(pending, 'utf8')));
  return checkoutPathExists(join(clientCacheRoot(root), `saves/${prior.operationId}`, backgroundSaveName))
    ? prior.operationId
    : undefined;
}
