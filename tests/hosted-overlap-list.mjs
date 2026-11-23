// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { moduleUrl } from './convex-module.mjs';

const buckets = await import(moduleUrl('../convex/projectHostedOverlapChanges.ts'));

/** An overlap Lane row of a fixture with its saved list rebuilt from the Lane's bucket rows (Item 411727ba):
 * tests that read what peers and advice read compare this, not the slim stored row. */
export const withSavedList = (s, row) =>
  !row || row.changes !== undefined
    ? row
    : {
        ...row,
        changes: buckets.joinOverlapBuckets(
          [...s.tables.projectHostedOverlapChanges.values()]
            .filter(bucket => bucket.laneId === row.laneId)
            .map(bucket => bucket.changes),
        ),
      };
