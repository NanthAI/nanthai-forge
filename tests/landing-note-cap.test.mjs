// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 8c50ce13: a landing message is stored once; the save and compose notes that travel with it
// are capped at 1 KiB so a long message is never copied into every finish row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { saveFixture } from './hosted-saves-fixture.mjs';
const { landingNote, noteText, LANDING_NOTE_BYTES } = await import(moduleUrl('../src/landing-message.ts'));
const bytes = value => new TextEncoder().encode(value).length;

test('a message within the note cap is its own note, unchanged', () => {
  assert.equal(LANDING_NOTE_BYTES, 1024);
  const message = `${'m'.repeat(1000)}\n\nbody body body`;
  assert(bytes(message) > 1000 && bytes(message) <= 1024);
  assert.equal(landingNote(message), message);
  assert.equal(landingNote('m'.repeat(1024)), 'm'.repeat(1024));
  assert.equal(landingNote('Agent change'), 'Agent change');
});

test('a message over the cap is noted by its first non-empty line, cut at a character boundary within 1 KiB', () => {
  assert.equal(landingNote(`Fix the writer\r\n\r\n${'x'.repeat(16 * 1024)}`), 'Fix the writer');
  assert.equal(
    landingNote(`\n\n  \nSubject\n${'x'.repeat(2000)}`),
    'Subject',
    'an empty first line is skipped',
  );
  assert.equal(landingNote('\n'.repeat(2000)), 'Agent change', 'never an empty note');
  const note = landingNote(`${'é'.repeat(900)}\n\nbody`);
  assert.equal(note, 'é'.repeat(512), 'whole characters only');
  assert(bytes(note) <= LANDING_NOTE_BYTES);
});

test('a new save or compose note over 1 KiB fails with the limit and the byte count', () => {
  assert.equal(noteText('m'.repeat(1024)), 'm'.repeat(1024));
  assert.throws(
    () => noteText('m'.repeat(2009)),
    error =>
      error.code === 'LANDING_MESSAGE_TOO_LARGE' &&
      /has 2009 UTF-8 bytes; the limit is 1024/.test(error.message),
  );
  assert.throws(() => noteText('é'.repeat(513)), /has 1026 UTF-8 bytes/, 'bytes, not characters');
});

test('Item 8c50ce13: the observer guard allows a third cold body per ticket and refuses a fourth', async () => {
  const { landingBodyCounts } = await import('./observer-projection-budget.mjs');
  const count = bodies => ({
    readDocumentsByTable: { projectHostedLandingBodies: bodies, projectHostedLandingRequests: 1 },
    written: ['projectHostedLandingRequests', ...Array(bodies).fill('projectHostedLandingBodies')],
  });
  assert.equal(landingBodyCounts(count(3)).reads, 3);
  assert.throws(() => landingBodyCounts(count(4)), /at most three cold bodies per ticket/);
  assert.throws(
    () => landingBodyCounts({ ...count(3), written: [...count(3).written, 'projectHostedLandingBodies'] }),
    /at most three cold-body writes/,
  );
});

test('Item 8c50ce13: save admission refuses a new note over 1 KiB with the limit and byte count, and admits 1 KiB', async () => {
  const f = await saveFixture();
  const change = () => {
    const pin = f.put('note cap');
    return [
      {
        path: 'b.txt',
        before: null,
        after: { blob: pin.sha256, mode: 'file', content: { object: pin, recipe: null } },
      },
    ];
  };
  await assert.rejects(
    f.prepare(change(), { message: 'm'.repeat(2009) }),
    error =>
      /LANDING_MESSAGE_TOO_LARGE/.test(error.message) &&
      /has 2009 UTF-8 bytes; the limit is 1024/.test(error.message),
  );
  const admitted = await f.prepare(change(), { message: 'm'.repeat(1024) });
  assert(admitted.result, 'a note at the limit is admitted');
});

test('the landing message limit is 16 KiB, one constant for the client pre-check and the server admission', async () => {
  const { LANDING_MESSAGE_BYTES, landingMessage, landingMessageSchema, suppliedLandingMessage } =
    await import(moduleUrl('../src/landing-message.ts'));
  assert.equal(LANDING_MESSAGE_BYTES, 16 * 1024);
  const atLimit = 'm'.repeat(LANDING_MESSAGE_BYTES);
  const over = `${atLimit}m`;
  // The client's early check (land, finish, preflight) and every server schema share these functions.
  for (const check of [landingMessage, suppliedLandingMessage, value => landingMessageSchema.parse(value)]) {
    assert.equal(check(atLimit), atLimit);
    assert.throws(
      () => check(over),
      error =>
        error.code === 'LANDING_MESSAGE_TOO_LARGE' &&
        error.message.includes(
          `has ${LANDING_MESSAGE_BYTES + 1} UTF-8 bytes; the limit is ${LANDING_MESSAGE_BYTES}`,
        ),
    );
  }
});

test('Item 8c50ce13: a receipt names a stored message it inherited, and copies one it does not hold', async () => {
  const { receiptMessageField } = await import(moduleUrl('../convex/projectHostedLandingMessageBody.ts'));
  const row = { messageBodyId: 'body' };
  const own = { request: { message: 'Own message' } };
  const inherited = { request: { message: null }, message: 'Inherited message' };
  assert.deepEqual(receiptMessageField(row, own, 'Own message'), { messageRef: 'body' });
  assert.deepEqual(receiptMessageField(row, inherited, 'Inherited message'), { messageRef: 'body' });
  // A different accepted text, a ticket with no stored body, or an omission is never a reference.
  assert.deepEqual(receiptMessageField(row, inherited, 'Other'), { message: 'Other' });
  assert.deepEqual(receiptMessageField({}, inherited, 'Inherited message'), { message: 'Inherited message' });
  assert.deepEqual(receiptMessageField(row, own, undefined), {});
});
