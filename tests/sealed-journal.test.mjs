// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { SealedJournal } from '../dist/sealed-journal.js';
import { FileKeyStore } from '../dist/sealed-local.js';
import { fixture } from './helpers/sealed-fixture.mjs';
import { sealedWrite } from '../dist/sealed-transport.js';

test('journal cap drops oldest confirmed receipts first and never silently drops an unknown request', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-sealed-journal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const journal = new SealedJournal(directory, join(directory, 'pins.lock'));
  const f = fixture(),
    identity = { project: f.request.forgeProjectId, name: 'API_TOKEN', removing: false, file: false };
  const ids = [];
  for (let i = 0; i < 64; i++) {
    const id = randomUUID(),
      entry = { ...identity, state: 'unknown', wire: sealedWrite(f.reply, id, null) };
    ids.push(id);
    await journal.retain(id, entry);
    if (i > 0) {
      await journal.accept(id, entry);
      const path = join(directory, 'operations', id + '.bin');
      const receipt = deserialize(readFileSync(path));
      receipt.confirmedAt = i;
      writeFileSync(path, serialize(receipt));
    }
  }
  const extra = randomUUID(),
    entry = { ...identity, state: 'unknown', wire: sealedWrite(f.reply, extra, null) };
  await journal.retain(extra, entry);
  assert.equal(existsSync(join(directory, 'operations', ids[1] + '.bin')), false);
  assert.equal((await journal.read(ids[0], identity)).state, 'unknown');
  assert.equal(readdirSync(join(directory, 'operations')).length, 64);
  for (const id of ids.slice(2)) {
    await journal.refuse(id);
    await journal.retain(id, { ...entry, wire: { ...entry.wire, operationId: id } });
  }
  await assert.rejects(journal.retain(randomUUID(), entry), error => {
    assert.equal(error.code, 'SECRETS_JOURNAL_FULL');
    for (const file of readdirSync(join(directory, 'operations')))
      assert(error.message.includes(file.slice(0, -4)));
    return true;
  });
  assert.equal(readdirSync(join(directory, 'operations')).length, 64);
  assert.equal(await journal.discardUnknown(ids[0]), true);
  await journal.retain(randomUUID(), entry);
  assert.equal(readdirSync(join(directory, 'operations')).length, 64);
});
test('invalid local key structures fail with PIN_LOST while cleanup remains safe', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-sealed-invalid-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'device.bin');
  writeFileSync(path, serialize({}), { mode: 0o600 });
  assert.throws(() => new FileKeyStore(path).load(), { code: 'SECRETS_PIN_LOST' });
});
