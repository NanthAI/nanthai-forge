// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The cockpit's live coordination drops its counts (unknown) at nextExpiryAt from one local timer,
// with no further Convex call while idle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installHookHost } from './convex-fake.mjs';

const host = installHookHost();

test.after(() => host.restore());
