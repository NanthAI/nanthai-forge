// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import { chain } from './physical-manifest-capped-fixture.mjs';
test('2000 eight-file saves at100k preserve64 grants and the root+changed+one63rd upload bound', t =>
  chain(t, { count: 100000, steps: 2000 }));
