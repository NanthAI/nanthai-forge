// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Import in each cleanup test file: Node isolates hooks between test files.
// Direct focused runs also avoid the user's real check queue and saved login.
import './check-runtime.mjs';
import test from 'node:test';
import { mockProcessCoverage } from './cleanup-process-fixture.mjs';

test.beforeEach(t => {
  mockProcessCoverage(t);
});
