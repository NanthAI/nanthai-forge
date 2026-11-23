// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Internal seed page, not a repository limit. A digest can require a primary
 * row, a slim point and a legacy catalog probe: <=3,001 queries per page,
 * leaving 1,095 of Convex's 4,096 for the enclosing source step and its fence.
 * Ordinary source windows keep their existing 100-object / four-window shape. */
export const sourceSeedPageSize = 1000;
