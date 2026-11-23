// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';

import { installHookHost } from './convex-fake.mjs';

const host = installHookHost();

test.after(() => host.restore());
