// SPDX-License-Identifier: Apache-2.0
// Who a hosted planning comment names (Item 9a3d6f5f, security review C1-10 and C1-11): the writer is the signed-in
// account, never a label the client typed, so a forged label cannot change the author an outside reader of a public
// project sees; the agent marker comes from the credential kind; comments have a server size cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { setup } from './hosted-planning-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const workCommand = await import(moduleUrl('../convex/projectWorkCommand.ts'));
const { MAX_COMMENT_CHARACTERS } = await import(moduleUrl('../convex/planningCommentWriter.ts'));
const model = await import(moduleUrl('../web/src/app/discussion/model.ts'));
const { Discussion } = await import(moduleUrl('../web/src/app/discussion/Discussion.tsx'));
const { isAgentSlug } = await import(moduleUrl('../src/agent-slug.ts'));

async function publicProject(t) {
  const s = await setup(t);
  s.tables.cliCredentials.set('device', {
    _id: 'device',
    credentialId: 'credential-1',
    owner: 'owner',
    name: 'test',
    tokenHash: 'synthetic-hash',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 600000,
    revoked: false,
    scope: 'cli',
  });
  s.tables.hostedProjects.set('project', { ...s.tables.hostedProjects.get('project'), visibility: 'public' });
  s.tables.forgeAccounts.set('account-owner', {
    _id: 'account-owner',
    _creationTime: 1,
    owner: 'owner',
    handle: 'sample-owner',
  });
  const issue = s.item({ title: 'Synthetic Item', body: 'Intro.' });
  await s.send(issue);
  const as = identity => {
    s.ctx.auth.getUserIdentity = async () => identity;
  };
  // The browser path: the public mutation, as the web app calls it.
  const comment = async (patch, identity = { subject: 'owner' }) => {
    as(identity);
    const operationId = randomUUID();
    await workCommand.command._handler(s.ctx, {
      projectId: 'project',
      operationId,
      command: JSON.stringify({
        action: 'comment-planning-item',
        operationId,
        itemId: issue.itemId,
        text: 'Said.',
        ...patch,
      }),
    });
    return operationId;
  };
  const comments = async reader => {
    as(reader ? { subject: reader } : null);
    const page = await index.records._handler(s.ctx, {
      projectId: 'project',
      collection: 'planningComments',
      parentId: issue.itemId,
      paginationOpts: { numItems: 100, cursor: null },
    });
    return page.page.map(row => JSON.parse(row.value));
  };
  return { s, issue, as, comment, comments };
}

test('a forged label never becomes the writer: an outside reader of a public project sees no typed handle', async t => {
  const { s, issue, as, comment, comments } = await publicProject(t);
  const id = await comment({ authorLabel: 'mara', text: 'Ship it.\n\nWhy, at length.', decision: true });
  // Also through the older action path, which signs in the same way.
  as({ subject: 'owner' });
  await s.send({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: issue.itemId,
    authorLabel: '@mara',
    text: 'Via the action.',
  });
  const owner = await comments('owner');
  assert.equal(owner.length, 2);
  for (const row of owner) {
    assert.equal(row.authorLabel, '', 'the server stores no typed label');
    assert.equal(row.author, 'sample-owner', 'the writer is the signed-in account');
  }
  const outside = await comments('stranger');
  assert.equal(outside.length, 2);
  for (const row of outside) {
    assert.equal(row.author, undefined, 'an outside reader may not see people');
    assert.equal(model.writer(row), null);
  }
  const html = renderToStaticMarkup(h(Discussion, { comments: outside, canWrite: false }));
  assert.doesNotMatch(html, /mara/, 'the forged handle shows nowhere');
  assert.match(html, /A member/);
  as({ subject: 'owner' });
  const body = (await s.read()).data.planningItems.filter(item => item.id === issue.itemId).at(-1).body;
  assert.match(
    body,
    new RegExp(`- \\d{4}-\\d\\d-\\d\\d @sample-owner: Ship it\\. \\(comment ${id.slice(0, 8)}\\)`),
  );
  assert.doesNotMatch(body, /mara/, 'the decision line names the server-resolved writer');
});

test('the agent marker comes from the credential: a browser cannot claim one, a device always has one', async t => {
  const { comment, comments } = await publicProject(t);
  await comment({ agent: 'keen-impala', text: 'From the browser.' });
  await comment({ text: 'From a device, no slug.' }, { subject: 'owner', forgeCredential: 'credential-1' });
  await comment(
    { agent: 'keen-impala', text: 'From a device.' },
    { subject: 'owner', forgeCredential: 'credential-1' },
  );
  const rows = Object.fromEntries((await comments('owner')).map(row => [row.text, row]));
  assert.equal(rows['From the browser.'].agent, undefined, 'a person is never shown as an agent');
  assert.ok(
    isAgentSlug(rows['From a device, no slug.'].agent),
    'a device without a slug still reads as an agent',
  );
  assert.equal(rows['From a device.'].agent, 'keen-impala');
  assert.equal(model.writer(rows['From the browser.']).label, '@sample-owner');
  assert.match(model.writer(rows['From a device, no slug.']).label, /^sample-owner\/[a-z]+-[a-z]+$/);
});

test('a comment over the size cap is refused by the server and never drawn by the page', async t => {
  const { comment, comments } = await publicProject(t);
  assert.equal(model.MAX_COMMENT_CHARACTERS, MAX_COMMENT_CHARACTERS, 'the page and the server share one cap');
  await assert.rejects(
    comment({ text: 'x'.repeat(MAX_COMMENT_CHARACTERS + 1) }),
    error => (error.data?.code ?? error.code) === 'BAD_ARGUMENT',
  );
  assert.equal((await comments('owner')).length, 0);
  const html = renderToStaticMarkup(
    h(Discussion, {
      comments: [
        { id: randomUUID(), itemId: randomUUID(), at: '2026-11-17T09:00:00Z', text: '*'.repeat(70_000) },
      ],
      canWrite: false,
    }),
  );
  assert.match(html, /longer than 65,536 characters and is not shown/);
  assert.ok(html.length < 5_000);
});
