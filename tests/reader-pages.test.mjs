// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';

import { installHookHost } from './convex-fake.mjs';

const host = installHookHost();

test.after(() => host.restore());
