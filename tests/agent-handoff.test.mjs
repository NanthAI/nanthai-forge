// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { briefingContext } from '../dist/agent-brief-context.js';
import { records, ids, states, guidance } from './agent-brief-fixture.mjs';
const cli = resolve('dist/cli.js');
test('brief selection never returns a cached delivery for a removed Lane', () => {
  const saved = structuredClone(records);
  saved.lanes = [];
  assert.throws(
    () =>
      briefingContext(
        { situation: 'continue-lane', laneId: ids.lane },
        saved,
        head => states[head],
        guidance,
        () => '',
      ),
    { code: 'NOT_FOUND' },
  );
});
