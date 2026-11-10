// SPDX-License-Identifier: Apache-2.0
import { resolve } from 'node:path';
import { ForgeError } from './errors.js';

/** Forge has one client mode: hosted. A folder without a hosted marker (a Forge clone, a Lane
 * checkout or an explicit url + projectId) is refused with its one next step. The code stays
 * FORGE_ROOT_UNAVAILABLE, which scripts already read for an unaddressed root. */
export function hostedRootRequired(root: string): ForgeError {
  const absolute = resolve(root);
  return new ForgeError(
    'FORGE_ROOT_UNAVAILABLE',
    `ROOT ${JSON.stringify(absolute)} is not a hosted Forge checkout; Forge runs hosted projects only. Next step: nforge host ${JSON.stringify(absolute)}, then work in its clone or Lanes (they keep working offline and land once back online).`,
  );
}
