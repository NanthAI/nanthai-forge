// SPDX-License-Identifier: Apache-2.0
/** Native queue planning is a backend boundary, never invoked by these hosted notice fixtures. */
export function planLandingTrain(): never {
  throw new Error('The hosted notice fixture must not invoke native queue planning.');
}
