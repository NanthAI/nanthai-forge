// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { parseNativeState } from '../dist/state/format.js';

import { saveBytes, savePin } from '../dist/hosted-save.js';

import { initialSourceStep, runSourceStep } from '../dist/hosted-source-step.js';

const compose = await import(moduleUrl('../convex/projectHostedCompose.ts'));

test('an unchanged Lane publishes an exact empty listing in both source execution paths', async () => {
  const c = await composeFixture();
  const selected = c.selection([await c.lane(c.baseline)]);
  await c.prepare(selected);
  await c.stage(selected);
  await c.submit(selected);
  const work = await c.work(selected);
  const raw = JSON.parse(work.manifest);
  const plan = (await c.progress(selected)).input;
  const input = c.put(saveBytes(plan));
  let cursor = initialSourceStep(input),
    steps = 0;
  while (cursor.phase !== 'done') {
    assert(++steps < 20);
    cursor = (
      await runSourceStep(cursor, {
        async describeBatch(ids) {
          return ids.map(id => ({ object: { sha256: id, size: c.objects.get(id).length }, recipe: null }));
        },
        async read(pin) {
          return [c.objects.get(pin.sha256)];
        },
        async upload(pin, stream) {
          const parts = [];
          for await (const part of stream) parts.push(part);
          assert.deepEqual(c.put(Buffer.concat(parts)), pin);
        },
      })
    ).cursor;
  }
  const stepped = JSON.parse(c.objects.get(cursor.output.sha256));
  assert.deepEqual(stepped.result.candidateFiles, raw.result.candidateFiles);
  const listing = JSON.parse(c.objects.get(stepped.result.candidateFiles.sha256));
  assert.equal(listing.base, listing.head);
  assert.deepEqual(listing.files, []);
});

test('an already pinned rollout plan replays its original input digest and publishes one listing', async () => {
  const c = await composeFixture();
  const head = c.state([c.file('new.txt', 'new\n')], [c.baseline.sha256]);
  const selected = c.selection([await c.lane(head)]);
  await c.prepare(selected);
  await c.stage(selected);
  const row = [...c.tables.projectHostedComposes.values()].find(
    row => row.operationId === selected.request.operationId,
  );
  // A persisted pre-cutover operation can still carry the former true-only wire field.
  c.patch('projectHostedComposes', row._id, {
    value: JSON.stringify({ ...JSON.parse(row.value), candidateFiles: true }),
  });
  const plan = (await c.progress(selected)).input;
  assert.equal(plan.candidateFiles, true);
  await c.submit(selected);
  const work = await c.work(selected);
  assert.deepEqual(JSON.parse(work.manifest).input, savePin(plan));
  const published = await c.publish(work);
  assert.deepEqual(await c.publish(work), published);
  assert.equal(published.outcome.result.result.status, 'clean');
  const candidate = [...c.tables.projectHostedRecords.values()].find(
    row => row.key === published.outcome.result.id && row.kind === 'candidate',
  );
  assert(candidate.candidateFiles);
});

test('Item 8c50ce13: compose admission refuses a new note over 1 KiB with the limit and byte count', async () => {
  const c = await composeFixture({ baselineFiles: [['src/a.ts', 'same\n']] });
  const files = parseNativeState(c.objects.get(c.baseline.sha256)).files;
  const changed = c.file(files[0].path, 'changed\n');
  const head = c.state([changed], [c.baseline.sha256]);
  const selected = c.selection([await c.lane(head)]);
  const long = { ...selected, request: { ...selected.request, message: 'm'.repeat(2009) } };
  await assert.rejects(
    c.prepare(long),
    error =>
      /LANDING_MESSAGE_TOO_LARGE/.test(error.message) &&
      /has 2009 UTF-8 bytes; the limit is 1024/.test(error.message),
  );
  const reply = await c.prepare({ ...selected, request: { ...selected.request, message: 'm'.repeat(1024) } });
  assert(!JSON.stringify(reply).includes('LANDING_MESSAGE_TOO_LARGE'), 'a note at the limit is admitted');
});
