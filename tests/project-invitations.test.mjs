// SPDX-License-Identifier: Apache-2.0
// Invitations with a role and one email (Item c6629fda), and the People and access read (b987e608, docs/access.md):
// the role reaches the grant, the email names only the inviter, the project and the role, a resend is explicit and
// idempotent, and the people read answers each role with only what the contract lets it see.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const originalSwitch = process.env.FORGE_INVITATION_EMAIL;
beforeEach(() => {
  process.env.FORGE_INVITATION_EMAIL = '1';
});
afterEach(() => {
  if (originalSwitch === undefined) delete process.env.FORGE_INVITATION_EMAIL;
  else process.env.FORGE_INVITATION_EMAIL = originalSwitch;
});
const answers = await import(moduleUrl('../convex/projectInvitationAnswers.ts'));
const contributors = await import(moduleUrl('../convex/projectContributors.ts'));
const access = await import(moduleUrl('../convex/projectAccess.ts'));
const mail = await import(moduleUrl('../convex/projectInviteMail.ts'));

const account = (owner, handle) => ({ _id: `a-${handle}`, _creationTime: 1, owner, handle });
function setup(visibility = 'private') {
  const s = state([]);
  s.tables.hostedProjects.set('project', {
    _id: 'project',
    _creationTime: 1,
    owner: 'user_owner',
    key: 'synthetic',
    slug: 'tools',
    name: 'Access project',
    visibility,
    revision: 1,
  });
  s.tables.projectSlugs.set('slug', {
    _id: 'slug',
    _creationTime: 1,
    owner: 'user_owner',
    slug: 'tools',
    projectId: 'project',
  });
  for (const [owner, handle] of [
    ['user_owner', 'olive'],
    ['user_writer', 'wren'],
    ['user_reader', 'rook'],
  ]) {
    s.tables.forgeAccounts.set(`a-${handle}`, account(owner, handle));
    s.tables.accountHandles.set(`h-${handle}`, { _id: `h-${handle}`, _creationTime: 1, owner, handle });
  }
  s.tables.projectContributors.set('w', {
    _id: 'w',
    _creationTime: 2,
    projectId: 'project',
    contributor: 'user_writer',
  });
  s.tables.projectReaders.set('r', {
    _id: 'r',
    _creationTime: 3,
    projectId: 'project',
    reader: 'user_reader',
  });
  s.tables.users.set('verified-owner', {
    _id: 'verified-owner',
    _creationTime: 1,
    accountKey: 'user_owner',
    emailVerified: true,
    email: 'owner@example.test',
  });
  s.caller('user_owner');
  return s;
}
const invite = (s, extra) =>
  contributors.invite._handler(s.ctx, {
    projectId: 'project',
    owner: 'user_owner',
    operationId: randomUUID(),
    ...extra,
  });
const rows = (s, table) => [...s.tables[table].values()];
const code = async run => {
  try {
    await run();
    return 'ok';
  } catch (error) {
    return error?.data?.code ?? error?.code;
  }
};
const refused = value => assert.ok(['PROJECT_UNAVAILABLE', 'AUTH_REVOKED'].includes(value), value);
const device = s => {
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'user_owner', forgeCredential: 'synthetic-device' });
};

test('an email invitation keeps its role, sends one email and replays without a second', async () => {
  const s = setup();
  const operationId = randomUUID();
  const input = { operationId, person: 'new@example.com', email: 'new@example.com', role: 'read' };
  await invite(s, input);
  await invite(s, input);
  const [row] = rows(s, 'projectInvites');
  assert.deepEqual([row.email, row.role, row.operationId], ['new@example.com', 'read', operationId]);
  const operation = rows(s, 'projectAccessOperations').find(item => item.operationId === operationId);
  assert.equal(operation.mail.status, 'sending');
  assert.equal(operation.mail.sends, 1);
  assert.equal(s.scheduled.length, 1, 'one send for one invitation, also on retry');
  assert.equal(rows(s, 'projectReaders').length, 1, 'invitation creates no membership');
  s.ctx.auth.getUserIdentity = async () => ({
    subject: 'user_new',
    email: 'New@Example.com',
    emailVerified: true,
  });
  await answers.answer._handler(s.ctx, {
    invitationId: row._id,
    choice: 'accept',
    operationId: randomUUID(),
  });
  assert.ok(rows(s, 'projectReaders').some(item => item.reader === 'user_new'));
  assert.ok(!rows(s, 'projectContributors').some(item => item.contributor === 'user_new'));
  assert.equal(rows(s, 'projectInvites')[0].state, 'accepted');
});

test('a handle invitation stays pending without email', async () => {
  const s = setup();
  await invite(s, { person: '@rook', contributor: 'user_reader', role: 'write' });
  assert.ok(!rows(s, 'projectContributors').some(item => item.contributor === 'user_reader'));
  assert.equal(rows(s, 'projectInvites')[0].state, 'pending');
  assert.equal(s.scheduled.length, 0);
});

test('the email names the inviter, the project and the role only, with the project link and nothing tracked', async () => {
  const s = setup();
  const before = process.env.FORGE_WEB_URL;
  process.env.FORGE_WEB_URL = 'https://forge.example';
  try {
    const operationId = randomUUID();
    await invite(s, { operationId, person: 'new@example.com', email: 'new@example.com', role: 'write' });
    const email = await mail.details._handler(s.ctx, { projectId: 'project', operationId });
    assert.equal(email.to, 'new@example.com');
    assert.equal(email.subject, '@olive invited you to olive/tools on Forge');
    assert.match(email.text, /read and change olive\/tools/);
    assert.match(email.text, /https:\/\/forge\.example\/account\/people/);
    const all = `${email.subject}\n${email.text}\n${email.html}`;
    for (const secret of ['wren', 'rook', 'user_', 'Access project', 'synthetic'])
      assert.ok(!all.includes(secret), `email leaks ${secret}`);
    assert.ok(!/<img|<script|utm_|\?/.test(email.html), 'no image, script, tracking or query string');
    const links = [...email.html.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(links, ['https://forge.example/account/people']);
    // Escaped: a name cannot inject markup.
    assert.ok(
      !mail.inviteEmail({ inviter: '<b>', project: 'p', role: 'read', url: 'u' }).html.includes('<b><'),
    );
  } finally {
    if (before === undefined) delete process.env.FORGE_WEB_URL;
    else process.env.FORGE_WEB_URL = before;
  }
});

test('a send records sent, failed or off and never the address; a resend is explicit and idempotent', async () => {
  const s = setup();
  const operationId = randomUUID();
  await invite(s, { operationId, person: 'new@example.com', email: 'new@example.com' });
  const action = {
    runQuery: (_, args) => mail.details._handler(s.ctx, args),
    runMutation: (_, args) => mail.settle._handler(s.ctx, args),
  };
  const operation = () => rows(s, 'projectAccessOperations').find(item => item.operationId === operationId);
  const names = ['FORGE_ALERT_EMAIL_TOKEN', 'FORGE_ALERT_EMAIL_ACCOUNT_ID'];
  const saved = names.map(name => process.env[name]);
  const fetch = globalThis.fetch;
  const sent = [];
  try {
    names.forEach(name => delete process.env[name]);
    await mail.deliver._handler(action, { projectId: 'project', operationId });
    assert.equal(operation().mail.status, 'off');
    process.env.FORGE_ALERT_EMAIL_TOKEN = 'synthetic-token';
    process.env.FORGE_ALERT_EMAIL_ACCOUNT_ID = 'a'.repeat(32);
    globalThis.fetch = async (url, init) => (
      sent.push({ url: String(url), body: JSON.parse(init.body) }),
      new Response('', { status: 502 })
    );
    const resendId = randomUUID();
    await mail.resend._handler(s.ctx, { projectId: 'project', operationId, resendId });
    await mail.resend._handler(s.ctx, { projectId: 'project', operationId, resendId });
    assert.equal(operation().mail.sends, 2, 'the same resend id sends once');
    assert.equal(
      await code(() =>
        mail.resend._handler(s.ctx, { projectId: 'project', operationId, resendId: randomUUID() }),
      ),
      'BAD_ARGUMENT',
      'no second send while one is in flight',
    );
    await mail.deliver._handler(action, { projectId: 'project', operationId, sendId: resendId });
    assert.deepEqual([operation().mail.status, operation().mail.code], ['failed', 'HTTP 502']);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.to, 'new@example.com');
    assert.ok(!JSON.stringify(operation().mail).includes('example.com'), 'the state never holds the address');
    // A settled send is not settled again, and an ended invitation sends nothing.
    await mail.settle._handler(s.ctx, { projectId: 'project', operationId, status: 'sent' });
    assert.equal(operation().mail.status, 'failed');
    // Only the owner person resends: a device and a writer are refused.
    device(s);
    refused(
      await code(() =>
        mail.resend._handler(s.ctx, { projectId: 'project', operationId, resendId: randomUUID() }),
      ),
    );
    s.ctx.auth.getUserIdentity = async () => ({ subject: 'user_writer' });
    assert.equal(
      await code(() =>
        mail.resend._handler(s.ctx, { projectId: 'project', operationId, resendId: randomUUID() }),
      ),
      'PROJECT_UNAVAILABLE',
    );
  } finally {
    globalThis.fetch = fetch;
    names.forEach((name, i) =>
      saved[i] === undefined ? delete process.env[name] : (process.env[name] = saved[i]),
    );
  }
});

test('the people read answers each role with only what it may see', async () => {
  const s = setup();
  await invite(s, { person: 'new@example.com', email: 'new@example.com', role: 'read' });
  const read = who => (s.caller(who), access.people._handler(s.ctx, { projectId: 'project' }));
  const owner = await read('user_owner');
  assert.equal(owner.role, 'owner');
  // Named by handle (public identity rule), never by account id.
  assert.deepEqual(
    owner.write.rows.map(row => row.person),
    ['wren'],
  );
  assert.deepEqual(
    owner.read.rows.map(row => row.person),
    ['rook'],
  );
  assert.equal(owner.owner, 'olive');
  assert.deepEqual(
    owner.invited.map(row => [row.email, row.role, row.mail?.status]),
    [['new@example.com', 'read', 'sending']],
  );
  const writer = await read('user_writer');
  assert.equal(writer.role, 'write');
  assert.equal(writer.read.rows.length, 1, 'writers see the roster');
  assert.equal(writer.invited.length, 0, 'invitation addresses reach the owner only');
  const reader = await read('user_reader');
  assert.equal(reader.role, 'read');
  assert.deepEqual([reader.write.rows.length, reader.read.rows.map(row => row.person)], [0, ['rook']]);
  assert.equal(reader.answers.changeWork, 'no');
  assert.equal(reader.owner, '', 'a reader is not shown other accounts, the owner included');
  assert.equal(await code(() => read('user_outsider')), 'PROJECT_UNAVAILABLE');
  const open = setup('public');
  open.caller('user_outsider');
  const visitor = await access.people._handler(open.ctx, { projectId: 'project' });
  assert.deepEqual([visitor.role, visitor.write.rows.length, visitor.read.rows.length], [null, 0, 0]);
  assert.equal(visitor.answers.readSource, 'yes');
  // Bounded: a page of one says there is more.
  s.tables.projectContributors.set('w2', {
    _id: 'w2',
    _creationTime: 4,
    projectId: 'project',
    contributor: 'user_two',
  });
  s.caller('user_owner');
  const page = await access.people._handler(s.ctx, { projectId: 'project', limit: 1 });
  assert.deepEqual([page.write.rows.length, page.write.more], [1, true]);
});

test('only the owner person changes a role; lowering and removal apply on the next call and replay safely', async () => {
  const s = setup();
  const change = (role, operationId = randomUUID()) =>
    access.setRole._handler(s.ctx, { projectId: 'project', person: 'wren', role, operationId });
  const operationId = randomUUID();
  await change('read', operationId);
  await change('read', operationId);
  assert.ok(!rows(s, 'projectContributors').some(item => item.contributor === 'user_writer'));
  assert.equal(rows(s, 'projectReaders').filter(item => item.reader === 'user_writer').length, 1);
  assert.equal(await code(() => change('write', operationId)), 'WORK_OPERATION_CHANGED');
  await change('write');
  assert.ok(rows(s, 'projectContributors').some(item => item.contributor === 'user_writer'));
  await change('none');
  assert.ok(!rows(s, 'projectContributors').some(item => item.contributor === 'user_writer'));
  assert.ok(!rows(s, 'projectReaders').some(item => item.reader === 'user_writer'));
  assert.equal(await code(() => change('read')), 'BAD_ARGUMENT', 'a removed person is not in the project');
  assert.equal(
    await code(() =>
      access.setRole._handler(s.ctx, {
        projectId: 'project',
        person: 'user_owner',
        role: 'read',
        operationId: randomUUID(),
      }),
    ),
    'BAD_ARGUMENT',
  );
  device(s);
  refused(
    await code(() =>
      access.setRole._handler(s.ctx, {
        projectId: 'project',
        person: 'user_reader',
        role: 'write',
        operationId: randomUUID(),
      }),
    ),
  );
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'user_reader' });
  assert.equal(
    await code(() =>
      access.setRole._handler(s.ctx, {
        projectId: 'project',
        person: 'user_reader',
        role: 'write',
        operationId: randomUUID(),
      }),
    ),
    'PROJECT_UNAVAILABLE',
  );
});
