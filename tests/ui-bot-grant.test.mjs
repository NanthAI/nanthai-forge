// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BotNoReaderGrant,
  explainBotAccess,
  grantPasskeyBotReader,
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

function accessFixture({ role = null, held = false, disabled = false } = {}) {
  const project = { role: 'owner', invited: [] };
  const laterPage = { invited: [] };
  const calls = [];
  const owner = {
    async query(_ref, { invitationCursor }) {
      return invitationCursor ? laterPage : project;
    },
    async action(action, payload) {
      calls.push({ action, payload });
      if (held || disabled)
        throw Object.assign(new Error(), {
          data: {
            code: 'PROJECT_UNAVAILABLE',
            message: held
              ? 'Project membership needs the owner person. Approval request a1234.'
              : 'Membership approval requests are not enabled on this server yet.',
          },
        });
      project.invited.push({
        id: 'fixture-invite',
        email: '@forge-ui-bot',
        role: 'read',
        state: 'pending',
        operationId: payload.operationId,
      });
    },
  };
  const bot = {
    async query() {
      return { role };
    },
    async mutation(action, payload) {
      calls.push({ action, payload });
      assert.equal(payload.invitationId, 'fixture-invite');
      assert.equal(payload.choice, 'accept');
      role = 'read';
    },
  };
  const credentials = {};
  const options = {
    owner,
    project,
    bot,
    credentials,
    save: async () => {},
    ref: name => name,
    projectId: 'fixture-project',
    deployment: dev,
  };
  return { project, laterPage, calls, grant: () => grantPasskeyBotReader(options) };
}

test('an owner read invitation is accepted by the bot and reused without a second request on retry', async () => {
  const { calls, grant } = accessFixture();
  await grant();
  await grant();
  assert.deepEqual(
    calls.map(call => call.action),
    ['projectContributorActions:invitePerson', 'projectInvitationAnswers:answer'],
  );
  assert.equal(calls[0].payload.person, '@forge-ui-bot');
  assert.equal(calls[0].payload.role, 'read');
});

test('a held owner approval cannot accept an unrelated write invitation', async () => {
  const { project, calls, grant } = accessFixture({ held: true });
  project.invited.push({ id: 'unrelated', role: 'write', email: '@other', state: 'pending' });
  await assert.rejects(grant(), /Review approval a1234/);
  assert.deepEqual(
    calls.map(call => call.action),
    ['projectContributorActions:invitePerson'],
  );
});

test('a pending Write invitation on a later page is preserved', async () => {
  const { project, laterPage, calls, grant } = accessFixture();
  project.invitationCursor = 'next';
  laterPage.invited.push({ id: 'fixture-invite', role: 'write', email: '@forge-ui-bot', state: 'pending' });
  await assert.rejects(grant(), /pending Write invitation/);
  assert.deepEqual(calls, []);
});

test('a browser-issued read invitation can resume setup where CLI approval is disabled', async () => {
  const { project, calls, grant } = accessFixture({ disabled: true });
  await assert.rejects(grant(), /People and access/);
  project.invited.push({ id: 'fixture-invite', role: 'read', email: '@forge-ui-bot', state: 'pending' });
  await grant();
  assert.deepEqual(
    calls.map(call => call.action),
    ['projectContributorActions:invitePerson', 'projectInvitationAnswers:answer'],
  );
});

test('an existing write grant is reported and never downgraded', async () => {
  const { calls, grant } = accessFixture({ role: 'write' });
  await assert.rejects(grant(), /already has write access/);
  assert.deepEqual(calls, []);
});
