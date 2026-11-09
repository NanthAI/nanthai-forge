// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from './errors.js';

/** A completed checkout operation whose folder no longer holds it (deleted, emptied, or its marker
 * removed) never replays as success (Issue ca49dc6c): nothing is installed by the old receipt, and
 * the next step is a new operation, which installs the current source. */
export function checkoutMissing(root: string, laneId?: string) {
  return new ForgeError(
    'CHECKOUT_MISSING',
    laneId
      ? `This Lane checkout finished earlier, but ${root} no longer holds Lane ${laneId} (the folder was deleted or emptied). Nothing was installed. Open the Lane again as new work: nforge agent ROOT open '{"laneId":"${laneId}"}' (without operationId).`
      : `This clone finished earlier, but ${root} no longer holds it (the folder was deleted or emptied). Nothing was installed. Run nforge clone again with the same project and folder; it starts new work and installs the current main.`,
    undefined,
    { obstruction: { kind: 'checkout-missing', path: root }, ...(laneId ? { laneId } : {}) },
  );
}
