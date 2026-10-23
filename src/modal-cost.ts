// SPDX-License-Identifier: Apache-2.0
/** Headroom for unmetered container startup/teardown; never a billing adjustment.
 * Historical receipts without a retained margin keep their original basis.
 */
export const MODAL_COST_SAFETY_MARGIN = 1.15;
export function modalUsageCost(item: {
  cpuCoreSeconds: number;
  memoryGiBSeconds: number;
  safetyMargin?: number | undefined;
}) {
  return (item.cpuCoreSeconds * 0.00003942 + item.memoryGiBSeconds * 0.00000667) * (item.safetyMargin ?? 1);
}
