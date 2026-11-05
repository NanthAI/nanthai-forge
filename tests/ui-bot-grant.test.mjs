// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BotNoReaderGrant,
  explainBotAccess,
  grantKey,
  readerGrantOperationId,
  setupCommand,
} from '../scripts/ui-bot-grant.mjs';
import { ShotError } from '../scripts/ui-shots/options.mjs';

const dev = 'https://dev.convex.cloud';

test('reader grant operation ids are per deployment and project, stable on retry', () => {
  let n = 0;
  const mint = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  const credentials = {};
  const first = readerGrantOperationId(credentials, dev, 'project-a', mint);
  assert.equal(readerGrantOperationId(credentials, dev, 'project-a', mint), first);
  const second = readerGrantOperationId(credentials, dev, 'project-b', mint);
  assert.notEqual(second, first, 'a project switch must request a new grant, not replay the old one');
  assert.notEqual(
    readerGrantOperationId(credentials, 'https://other.convex.cloud', 'project-a', mint),
    first,
  );
  assert.equal(readerGrantOperationId(credentials, dev, 'project-a', mint), first);
  assert.equal(readerGrantOperationId(credentials, dev, 'project-b', mint), second);
  assert.deepEqual(Object.keys(credentials.readerGrantOperationIds).sort(), [
    grantKey(dev, 'project-a'),
    grantKey(dev, 'project-b'),
    grantKey('https://other.convex.cloud', 'project-a'),
  ]);
});

test('the legacy single operation id is dropped so it can never be replayed on another project', () => {
  const credentials = { readerGrantOperationId: '11111111-1111-4111-8111-111111111111' };
  const id = readerGrantOperationId(
    credentials,
    dev,
    'project-new',
    () => '22222222-2222-4222-8222-222222222222',
  );
  assert.equal(id, '22222222-2222-4222-8222-222222222222');
  assert.equal('readerGrantOperationId' in credentials, false);
});

test('PROJECT_UNAVAILABLE becomes a typed no-reader-grant error with the exact setup command', () => {
  for (const denied of [{ data: { code: 'PROJECT_UNAVAILABLE' } }, { code: 'PROJECT_UNAVAILABLE' }]) {
    const error = explainBotAccess(denied, dev, 'project-a');
    assert.ok(error instanceof BotNoReaderGrant && error instanceof ShotError);
    assert.equal(error.code, 'BOT_NO_READER_GRANT');
    assert.ok(error.message.includes(setupCommand(dev, 'project-a')));
    assert.match(error.message, /no reader grant on project project-a/);
    assert.ok(error.message.includes('--grant-reader'));
  }
});

test('other failures pass through unchanged', () => {
  const other = { data: { code: 'HOSTED_REQUEST_FAILED' } };
  assert.equal(explainBotAccess(other, dev, 'project-a'), other);
  const denied = { data: { code: 'PROJECT_UNAVAILABLE' } };
  assert.equal(explainBotAccess(denied, undefined, 'project-a'), denied);
});
