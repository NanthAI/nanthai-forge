// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { invariant } from '../src/errors';

export const abandonedWindow = 86400_000;
export const maintenancePageSize = 100;
export function maintenanceEnabled() {
  invariant(
    process.env.FORGE_R2_MAINTENANCE === '1',
    'R2_MAINTENANCE_DISABLED',
    'The lead has not enabled R2 storage maintenance.',
  );
}
