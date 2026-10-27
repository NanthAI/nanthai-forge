// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './landing-batch-fixture.mjs';
import { batchEdit, selectBatch, composeBatch } from '../dist/landing-batch-store.js';

export async function historyFixture(t, { github = false, journals = true } = {}) {
  const f = await fixture(t, { remote: false, stopChecks: github });
  if (github)
    await f.agent.dispatch({
      action: 'set-policy',
      operationId: randomUUID(),
      checks: { runner: 'github-actions', repo: 'synthetic/checks' },
    });
  const input = await f.candidate('selected.txt');
  const selected = await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
  await composeBatch(f.work, selected);
  const data = f.store.load(),
    entry = data.landingEntries[0],
    batch = data.landingBatches[0];
  for (let i = 1; i < 550; i++) data.landingEntries.push({ ...entry, id: randomUUID(), status: 'accepted' });
  for (let i = 1; i < 450; i++) {
    const entryIds = [data.landingEntries[i].id];
    data.landingBatches.push({
      ...batch,
      id: randomUUID(),
      entryIds,
      prefixes: batch.prefixes.map(prefix => ({ ...prefix, entryIds })),
      status: 'completed',
    });
  }
  f.store.locked(() => f.store.save(data));
  if (journals) {
    const finishDirectory = join(f.store.directory, 'agent-finish'),
      landDirectory = join(f.store.directory, 'agent-land');
    mkdirSync(finishDirectory, { recursive: true });
    mkdirSync(landDirectory, { recursive: true });
    for (let i = 0; i < 550; i++) {
      const operationId = randomUUID();
      writeFileSync(
        join(finishDirectory, `${operationId}.json`),
        JSON.stringify({
          schema: 1,
          request: 'synthetic',
          command: { ...input.command, operationId },
          attempts: [],
          landing: [],
          result: { status: 'passed' },
        }),
      );
    }
    for (let i = 0; i < 450; i++) {
      const operationId = randomUUID();
      writeFileSync(
        join(landDirectory, `${operationId}.json`),
        JSON.stringify({
          schema: 1,
          request: 'synthetic',
          entries: [
            {
              command: { ...input.command, operationId },
              inputs: input.view.inputs,
              result: { status: 'accepted' },
            },
          ],
        }),
      );
    }
  }
  return { ...f, input, batch };
}
