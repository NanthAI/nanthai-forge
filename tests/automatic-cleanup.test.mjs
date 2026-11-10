// SPDX-License-Identifier: Apache-2.0
// Direct focused runs must also avoid the user's real check queue and saved login.
import './check-runtime.mjs';
import test from 'node:test';
import { mockProcessCoverage } from './cleanup-process-fixture.mjs';

test.beforeEach(t => {
  mockProcessCoverage(t);
});
