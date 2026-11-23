// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import { sourceCutoverDrill } from './source-cutover-drill.mjs';
test('synthetic dry-run, hosted-only landing, old CLI refusal, clean Route B and rollback', async t => {
  console.log('B1.5b drill', JSON.stringify(await sourceCutoverDrill(t)));
});
