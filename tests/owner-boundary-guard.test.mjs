// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerBoundaryFindings } from '../scripts/check-owner-boundary.mjs';

// Reviewed device permissions live one file per Convex module in tests/owner-boundary-guard.d/
// (`{"actions": [...], "reason"?: "..."}`). Each entry names an existing owner entry point; new ones
// need an explicit classification. Read-only metadata, reversible source/Work operations, project
// setup, decisions and metrics retain device access. Existing person gates remain in their own handlers.
test('class guard: every public owner authority entry point has reviewed device permission or a person gate', () => {
  assert.deepEqual(ownerBoundaryFindings(new URL('../convex/', import.meta.url)), []);
});
