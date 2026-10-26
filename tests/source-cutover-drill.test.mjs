// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { sourceCutoverDrill } from './source-cutover-drill.mjs';
test('synthetic dry-run, hosted-only landing, old CLI refusal, clean Route B and rollback', async t => {
  console.log('B1.5b drill', JSON.stringify(await sourceCutoverDrill(t)));
});
