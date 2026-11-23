// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import { chain } from './physical-manifest-capped-fixture.mjs';
test('2000 stress-mix saves at29k preserve bounded metadata grants through replacements,adds,deletes and renames', t =>
  chain(t, { count: 29000, steps: 2000, stress: true, nonce: true }));
