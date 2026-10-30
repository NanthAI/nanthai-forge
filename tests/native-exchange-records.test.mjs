// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from '../dist/hash.js';

test('legacy unified baseline recovery preserves exact catalog property order and planned Intents', async t => {
  const { retainExchangeBaseline, exchangeBaseline } = await import('../dist/native-exchange-baseline.js');
  const { buildWorkRecords } = await import('../dist/work-exchange-records.js');
  const { createWork } = await import('../dist/work-create.js');
  const { unifyIntent } = await import('../dist/work-intent-local.js');
  const directory = mkdtempSync(join(tmpdir(), 'forge-unified-hint-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const head = 'a'.repeat(64),
    source = { ...createWork(head), schema: 18, revision: 7 };
  source.intents.push(
    unifyIntent({
      id: randomUUID(),
      outcome: 'Planned',
      constraints: '',
      status: 'proposed',
      createdAt: 'now',
      notes: [],
    }),
  );
  const { schema, ...rest } = source,
    data = { ...rest, schema, opaque: { unchanged: true } },
    work = Buffer.from(JSON.stringify(data, null, 2)),
    id = randomUUID();
  const manifest = {
    schema: 1,
    kind: 'forge-native-work-backup',
    id,
    head,
    revision: data.revision,
    files: [{ path: 'work.json', sha256: digest(work), size: work.length }],
    unavailable: [],
    coverage: 'Synthetic',
  };
  const store = { native: true, directory },
    key = 'synthetic/legacy';
  mkdirSync(join(directory, `exchange-${id}`));
  writeFileSync(join(directory, `exchange-${id}`, 'work.json'), work);
  retainExchangeBaseline(store, key, manifest, data, [], []);
  const path = join(directory, `exchange-baseline-${digest(key)}.json`),
    envelope = JSON.parse(readFileSync(path)),
    value = JSON.parse(envelope.payload);
  delete value.data;
  const payload = JSON.stringify(value);
  writeFileSync(path, JSON.stringify({ payload, sha256: digest(payload) }));
  const recovered = exchangeBaseline(store, key);
  assert.equal(recovered.data.intents[0].base, undefined);
  assert.equal(buildWorkRecords(recovered.data).pin.sha256, buildWorkRecords(data).pin.sha256);
  assert.deepEqual(Object.keys(recovered.data), Object.keys(data));
});
