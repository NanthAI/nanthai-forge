// SPDX-License-Identifier: Apache-2.0
// Account > Your data > Close account (Item 17cdc774, owner 2026-11-22: self-serve close ships in the beta). Once an
// account holds nothing, its own person closes it through Forge's path: the account row, every handle it held, its
// handle operations, deletion receipts, ordering hints, device sign-ins and native sign-in (sessions, passkeys,
// username) go; deleted-project tombstones stay. An account that holds or is shared anything is refused with the next
// step and nothing is written; the close is retry-safe by operation id; nobody else can close it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionAddress, getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { state, providers } from './hosted-fixture.mjs';

const close = await import(moduleUrl('../convex/accountClose.ts'));
const authority = await import(moduleUrl('../convex/secretGrantAuthority.ts'));
test.beforeEach(t => t.after(providers()));
let clock = 1;
const row = (id, fields) => ({ _id: id, _creationTime: clock++, ...fields });
const code = c => e => (e.data?.code ?? e.code) === c;

/** An account that holds nothing: two handles, a handle change, two finished receipts, a deleted-project tombstone, a
 * device sign-in, an ordering hint and a hidden secret grant someone else gave it. `native` adds a Convex Auth user
 * with GitHub, two sessions and passkeys behind stubbed components. */
function emptyWorld({ native = true } = {}) {
  clock = 1;
  const f = state([]);
  const t = f.tables;
  t.forgeAccounts.set('acct', row('acct', { owner: 'owner', handle: 'sample-owner', secretsLeftBefore: 5 }));
  t.accountHandles.set('h1', row('h1', { owner: 'owner', handle: 'sample-owner' }));
  t.accountHandles.set('h0', row('h0', { owner: 'owner', handle: 'older-name' }));
  t.accountHandles.set('hx', row('hx', { owner: 'other', handle: 'someone-else' }));
  t.handleOperations.set(
    'ho',
    row('ho', { owner: 'owner', operationId: randomUUID(), handle: 'sample-owner' }),
  );
  for (const id of ['op1', 'op2']) {
    t.accountOperations.set(
      id,
      row(id, {
        owner: 'owner',
        operationId: randomUUID(),
        request: 'r',
        expectedItems: 1,
        leave: [],
        stage: 'completed',
        captured: [],
        pending: 0,
        at: 1,
      }),
    );
    t.accountItems.set(
      `${id}-item`,
      row(`${id}-item`, {
        owner: 'owner',
        accountId: id,
        key: `project:${id}`,
        resourceId: id,
        kind: 'project',
        pin: 'p',
        operationId: randomUUID(),
        hidden: false,
        state: 'completed',
      }),
    );
  }
  t.hostedProjects.set('gone', row('gone', { owner: 'owner', name: 'Old', key: 'old', removal: 'deleted' }));
  t.cliCredentials.set(
    'cred',
    row('cred', {
      credentialId: 'synthetic-device',
      owner: 'owner',
      name: 'synthetic',
      tokenHash: 'synthetic-hash',
      issuedAt: 1,
      // A live sign-in: expires in 2100, after any clock this test runs on.
      expiresAt: 4_102_444_800_000,
      revoked: false,
      scope: 'cli',
    }),
  );
  t.accountProjectOrder.set(
    'order',
    row('order', { person: 'owner', projectId: 'gone', role: 'owner', activityHour: 1 }),
  );
  t.secretObjects.set(
    'their-secret',
    row('their-secret', {
      owner: 'other',
      name: 'canary',
      operationId: randomUUID(),
      repository: 'private/canary',
      ref: 'main',
      version: 1,
      policyRevision: 1,
      disabled: false,
    }),
  );
  t.secretGrants.set(
    'hidden-grant',
    row('hidden-grant', {
      secretId: 'their-secret',
      principal: 'owner',
      discover: false,
      capabilities: ['use'],
      activeUntil: 9999999999999,
    }),
  );
  const calls = [];
  if (native) {
    t.users.set(
      'u1',
      row('u1', {
        accountKey: 'owner',
        githubId: '12345',
        githubLogin: 'sample-owner',
        email: 'owner@example.test',
        emailVerified: true,
        emailConfirmedAt: 1,
        legalAcceptance: { version: 'v1', at: 1 },
        passkeyNotice: { at: 1, passkeyId: 'pk' },
      }),
    );
    t.authLinkEvents.set(
      'link',
      row('link', {
        userId: 'u1',
        operationId: randomUUID(),
        request: 'r',
        kind: 'github',
        sessionId: 's1',
        identityId: '12345',
        at: 1,
      }),
    );
  }
  const component = (fn, args) => {
    const name = getFunctionAddress(fn).reference ?? '';
    if (!name.startsWith('_reference/childComponent/')) return null;
    calls.push([name.split('/').slice(-1)[0], args]);
    if (name.endsWith('/listSessions'))
      return { value: args.userId === 'u1' ? [{ sessionId: 's1' }, { sessionId: 's2' }] : [] };
    if (name.endsWith('/listPasskeys')) return { value: args.userId === 'u1' ? [{ id: 'pk' }] : [] };
    if (name.endsWith('/revokeSessions')) return { value: args.sessionIds };
    if (name.endsWith('/deleteUsername')) return { value: { deleted: true } };
    return { value: null };
  };
  // Component calls answer from the stub; the fixture's validating dispatcher checks every app call as before.
  for (const key of ['runQuery', 'runMutation']) {
    const base = f.ctx[key];
    Object.defineProperty(f.ctx, key, {
      configurable: true,
      value: (fn, args) => {
        const stub = component(fn, args);
        return stub ? Promise.resolve(stub.value) : base(fn, args);
      },
    });
  }
  return { f, t, calls };
}
const as = (f, subject) => {
  f.ctx.auth.getUserIdentity = async () => ({ subject });
};
/** Runs the close's scheduled steps in order, as the scheduler would; returns how many ran. */
async function background(f) {
  let ran = 0;
  for (let task; (task = f.scheduled.find(x => getFunctionName(x.fn) === 'accountClose:step')); ran++) {
    f.scheduled.splice(f.scheduled.indexOf(task), 1);
    f.tasks.set(task.id, { state: { kind: 'inProgress' } });
    await f.transaction(() => close.step._handler(f.ctx, task.args));
    f.tasks.set(task.id, { state: { kind: 'success' } });
  }
  return ran;
}
const closeAs = (f, input) => close.close._handler(f.ctx, input);

test('an account that holds nothing closes: account, handles, receipts, devices and native sign-in go; tombstones stay', async () => {
  const { f, t, calls } = emptyWorld();
  as(f, 'owner');
  const before = await close.preview._handler(f.ctx, {});
  assert.deepEqual(before, {
    handle: 'sample-owner',
    handles: ['older-name', 'sample-owner'],
    receipts: 2,
    more: false,
    passkeys: 1,
    devices: 1,
    github: true,
    blocker: null,
    closing: null,
  });
  const operationId = randomUUID();
  assert.deepEqual(await closeAs(f, { operationId, handle: 'sample-owner' }), { stage: 'closing' });
  // The hidden grant gives nothing from the close's own write, before its row goes.
  assert.equal(await authority.leftByCleanup(f.ctx, t.secretGrants.get('hidden-grant')), true);
  assert.ok((await background(f)) >= 3);
  assert.equal(t.forgeAccounts.size, 0);
  assert.deepEqual([...t.accountHandles.keys()], ['hx']);
  assert.equal(t.handleOperations.size + t.accountOperations.size + t.accountItems.size, 0);
  assert.equal(t.accountProjectOrder.size + t.authLinkEvents.size, 0);
  assert.equal(t.secretGrants.size, 0);
  assert.equal(t.cliCredentials.get('cred').revoked, true);
  assert.ok(t.hostedProjects.has('gone'), 'the deleted-project tombstone stays');
  // GitHub keeps its own account link, so the users row keeps only the numeric id, under a fresh account key: the next
  // GitHub sign-in never acts as the closed key (review of the delete path #4). No email or login stays.
  const { _id, _creationTime, accountKey, ...left } = t.users.get('u1');
  assert.match(accountKey, /^user_[0-9a-f]{32}$/);
  assert.deepEqual(left, {
    githubId: '12345',
    emailVerified: false,
    legalAcceptance: { version: 'v1', at: 1 },
  });
  const done = calls.map(([name]) => name);
  for (const name of ['revokeSessions', 'deleteUser', 'deleteUsername']) assert.ok(done.includes(name), name);
  assert.deepEqual(calls.find(([name]) => name === 'revokeSessions')[1], { sessionIds: ['s1', 's2'] });
  // The same operation again reconciles to its outcome.
  assert.deepEqual(await closeAs(f, { operationId, handle: 'sample-owner' }), { stage: 'closed' });
  assert.equal(await close.preview._handler(f.ctx, {}), null);
});

test('an account signed in with the old provider only (no native user) closes the same way', async () => {
  const { f, t, calls } = emptyWorld({ native: false });
  as(f, 'owner');
  await closeAs(f, { operationId: randomUUID(), handle: 'sample-owner' });
  await background(f);
  assert.equal(t.forgeAccounts.size + t.accountOperations.size, 0);
  assert.deepEqual([...t.accountHandles.keys()], ['hx']);
  assert.equal(calls.filter(([name]) => name !== 'listPasskeys').length, 0, 'no native sign-in to end');
});

test('a passkey-only native user is removed with its sign-in', async () => {
  const { f, t } = emptyWorld();
  const { githubId, githubLogin, ...rest } = t.users.get('u1');
  t.users.set('u1', rest);
  as(f, 'owner');
  await closeAs(f, { operationId: randomUUID(), handle: 'sample-owner' });
  await background(f);
  assert.equal(t.users.size, 0);
});

test('an account that still holds or is shared anything is refused with the next step, writing nothing', async () => {
  const cases = [
    [
      'a live project',
      t => t.hostedProjects.set('live', row('live', { owner: 'owner', name: 'Live', key: 'live' })),
      /still holds projects/,
    ],
    [
      'a project in the trash',
      t =>
        t.hostedProjects.set(
          'trashed',
          row('trashed', { owner: 'owner', name: 'T', key: 't', removal: 'trash' }),
        ),
      /still holds projects/,
    ],
    [
      'a saved view',
      t => t.savedViews.set('sv', row('sv', { owner: 'owner', name: 'View', importId: 'x', route: {} })),
      /still holds saved views/,
    ],
    [
      'a team someone shared',
      t => {
        t.teams.set('ft', row('ft', { owner: 'other', name: 'Their team', operationId: randomUUID() }));
        t.teamMembers.set('tm', row('tm', { teamId: 'ft', member: 'owner' }));
      },
      /Leave them/,
    ],
    [
      'a deletion still running',
      t => t.accountOperations.set('op1', { ...t.accountOperations.get('op1'), stage: 'running' }),
      /still running/,
    ],
    [
      'secret grants still being left',
      t => t.accountOperations.set('op1', { ...t.accountOperations.get('op1'), secretsDone: false }),
      /still running/,
    ],
  ];
  for (const [label, add, words] of cases) {
    const { f, t } = emptyWorld();
    add(t);
    as(f, 'owner');
    const preview = await close.preview._handler(f.ctx, {});
    assert.match(preview.blocker, words, label);
    await assert.rejects(
      closeAs(f, { operationId: randomUUID(), handle: 'sample-owner' }),
      e => code('ACCOUNT_CHANGED')(e) && words.test(e.data?.message ?? e.message),
      label,
    );
    assert.equal(t.forgeAccounts.get('acct').closing, undefined, label);
    assert.equal(t.forgeAccounts.get('acct').secretsLeftBefore, 5, label);
    assert.equal(f.scheduled.length, 0, label);
  }
});

test('close is retry-safe by operation id: a retry reconciles, a failed step restarts, another id is refused', async () => {
  const { f, t } = emptyWorld();
  as(f, 'owner');
  const operationId = randomUUID();
  await closeAs(f, { operationId, handle: 'sample-owner' });
  assert.equal(f.scheduled.length, 1);
  // A retry while the step is pending schedules nothing new.
  assert.deepEqual(await closeAs(f, { operationId, handle: 'sample-owner' }), { stage: 'closing' });
  assert.equal(f.scheduled.length, 1);
  await assert.rejects(
    closeAs(f, { operationId: randomUUID(), handle: 'sample-owner' }),
    code('ACCOUNT_OPERATION_CHANGED'),
  );
  // The step failed: the same id starts it again from where it stood; the stale task then does nothing.
  const stale = f.scheduled.splice(0, 1)[0];
  f.tasks.set(stale.id, { state: { kind: 'failed' } });
  await closeAs(f, { operationId, handle: 'sample-owner' });
  assert.equal(f.scheduled.length, 1);
  await f.transaction(() => close.step._handler(f.ctx, { ...stale.args, cursor: 'stale' }));
  assert.equal(t.secretGrants.size, 1, 'a step the account row does not name does nothing');
  await background(f);
  assert.equal(t.forgeAccounts.size, 0);
  assert.deepEqual(await closeAs(f, { operationId, handle: 'sample-owner' }), { stage: 'closed' });
});

test('something made while the close runs keeps the account whole: its handle, passkeys and user', async () => {
  const { f, t, calls } = emptyWorld();
  as(f, 'owner');
  await closeAs(f, { operationId: randomUUID(), handle: 'sample-owner' });
  t.hostedProjects.set('new', row('new', { owner: 'owner', name: 'New', key: 'new' }));
  await background(f);
  assert.ok(t.forgeAccounts.has('acct'));
  assert.equal(t.forgeAccounts.get('acct').closing, undefined);
  assert.ok(t.accountHandles.has('h1'), 'the current handle stays with the account (review #5)');
  assert.equal(t.users.get('u1').accountKey, 'owner');
  assert.ok(t.users.get('u1').email);
  const names = calls.map(([name]) => name);
  assert.ok(!names.includes('deleteUser') && !names.includes('deleteUsername'), 'passkeys and username kept');
});

test('a deletion started after the close began stops the close before any sign-in ends (review #5)', async () => {
  const { f, t, calls } = emptyWorld();
  as(f, 'owner');
  await closeAs(f, { operationId: randomUUID(), handle: 'sample-owner' });
  t.accountOperations.set('late', { ...t.accountOperations.get('op1'), _id: 'late', stage: 'running' });
  await background(f);
  assert.ok(t.accountOperations.has('late'), 'never cut short');
  assert.equal(t.forgeAccounts.get('acct').closing, undefined);
  assert.equal(t.cliCredentials.get('cred').revoked, false);
  assert.equal(calls.filter(([name]) => name === 'revokeSessions').length, 0);
});

/** Turns op1 into a deletion whose begin stopped before sealing (Item 17cdc774: the two dormant dev accounts each held
 * one since 2026-11-11, expectedItems 1, pending 0). `item` appends one pending item for that resource. */
function stuck(t, { item, at = 1 } = {}) {
  t.accountOperations.set('op1', {
    ...t.accountOperations.get('op1'),
    stage: 'preparing',
    pending: item ? 1 : 0,
    at,
  });
  t.accountItems.delete('op1-item');
  if (item)
    t.accountItems.set(
      'op1-held',
      row('op1-held', {
        owner: 'owner',
        accountId: 'op1',
        key: `${item.kind}:${item.id}`,
        resourceId: item.id,
        kind: item.kind,
        pin: 'p',
        operationId: randomUUID(),
        hidden: !!item.hidden,
        state: 'pending',
      }),
    );
}
const closeFor = (f, input) => close.closeFor._handler(f.ctx, { owner: 'owner', ...input });

test('a deletion stuck at preparing no longer blocks the close once nothing is held: the close drops it (Item 17cdc774)', async () => {
  for (const item of [undefined, { kind: 'project', id: 'gone' }]) {
    const { f, t } = emptyWorld();
    // Without an item, or with one whose project is only a tombstone: nothing it could still remove is held.
    stuck(t, { item });
    as(f, 'owner');
    assert.equal((await close.preview._handler(f.ctx, {})).blocker, null);
    // The operator path, as run on the dormant dev accounts that nobody can sign in to.
    assert.deepEqual(await closeFor(f, { operationId: randomUUID(), handle: 'sample-owner' }), {
      stage: 'closing',
    });
    await background(f);
    assert.equal(t.forgeAccounts.size, 0);
    assert.equal(t.accountOperations.size + t.accountItems.size, 0);
    assert.equal(t.secretGrants.size, 0, 'the hidden grant is left as in any close');
    assert.ok(t.hostedProjects.has('gone'));
  }
});

test('a preparing deletion whose item is still held stays refused, and the held item and receipt stay (Item 17cdc774)', async () => {
  const cases = [
    [
      { kind: 'project', id: 'live' },
      t => t.hostedProjects.set('live', row('live', { owner: 'owner', name: 'Live', key: 'live' })),
      /still holds projects/,
    ],
    [
      { kind: 'view', id: 'sv' },
      t => t.savedViews.set('sv', row('sv', { owner: 'owner', name: 'View', importId: 'x', route: {} })),
      /still holds saved views/,
    ],
    [
      { kind: 'teams', id: 'tm', hidden: true },
      t => {
        t.teams.set('ft', row('ft', { owner: 'other', name: 'Their team', operationId: randomUUID() }));
        t.teamMembers.set('tm', row('tm', { teamId: 'ft', member: 'owner' }));
      },
      /Leave them/,
    ],
  ];
  for (const [item, add, words] of cases) {
    const { f, t } = emptyWorld();
    stuck(t, { item });
    add(t);
    as(f, 'owner');
    assert.match((await close.preview._handler(f.ctx, {})).blocker, words);
    for (const run of [closeAs, closeFor])
      await assert.rejects(
        run(f, { operationId: randomUUID(), handle: 'sample-owner' }),
        e => code('ACCOUNT_CHANGED')(e) && words.test(e.data?.message ?? e.message),
      );
    assert.equal(t.forgeAccounts.get('acct').closing, undefined);
    assert.equal(f.scheduled.length, 0);
    assert.equal(t.accountOperations.get('op1').stage, 'preparing', 'the person can still continue it');
    assert.ok(t.accountItems.has('op1-held'));
  }
});

test('closing past a stuck preparing deletion is retry-safe; one begun during the close stops it (Item 17cdc774)', async () => {
  const { f, t } = emptyWorld();
  stuck(t);
  const operationId = randomUUID();
  await closeFor(f, { operationId, handle: 'sample-owner' });
  assert.deepEqual(await closeFor(f, { operationId, handle: 'sample-owner' }), { stage: 'closing' });
  assert.equal(f.scheduled.length, 1, 'a retry while the step is pending schedules nothing new');
  await assert.rejects(
    closeFor(f, { operationId: randomUUID(), handle: 'sample-owner' }),
    code('ACCOUNT_OPERATION_CHANGED'),
  );
  const failed = f.scheduled.splice(0, 1)[0];
  f.tasks.set(failed.id, { state: { kind: 'failed' } });
  await closeFor(f, { operationId, handle: 'sample-owner' });
  // Run the secrets step, then fail the receipts step that drops the stuck receipt: the same id restarts it there.
  const secrets = f.scheduled.splice(0, 1)[0];
  await f.transaction(() => close.step._handler(f.ctx, secrets.args));
  const receipts = f.scheduled.find(x => getFunctionName(x.fn) === 'accountClose:step');
  assert.equal(receipts.args.phase, 'receipts');
  f.scheduled.splice(f.scheduled.indexOf(receipts), 1);
  f.tasks.set(receipts.id, { state: { kind: 'failed' } });
  await closeFor(f, { operationId, handle: 'sample-owner' });
  await background(f);
  assert.equal(t.forgeAccounts.size + t.accountOperations.size, 0);
  assert.deepEqual(await closeFor(f, { operationId, handle: 'sample-owner' }), { stage: 'closed' });

  // A begin that registers after the close started, even in the same millisecond, may be running in another tab: the
  // receipts step meets it first (newest first) and stops before any older receipt goes (review of this fix #1, #2).
  const late = emptyWorld();
  as(late.f, 'owner');
  await closeAs(late.f, { operationId: randomUUID(), handle: 'sample-owner' });
  const { _id, _creationTime, ...op1 } = late.t.accountOperations.get('op1');
  late.t.accountOperations.set(
    'new',
    row('new', {
      ...op1,
      operationId: randomUUID(),
      stage: 'preparing',
      at: late.t.forgeAccounts.get('acct').closing.at,
    }),
  );
  await background(late.f);
  assert.deepEqual([...late.t.accountOperations.keys()].sort(), ['new', 'op1', 'op2'], 'none dropped');
  assert.equal(late.t.forgeAccounts.get('acct').closing, undefined);
  assert.equal(late.t.cliCredentials.get('cred').revoked, false);

  // One that registers after the receipts step stops the final transaction: the account stays whole.
  const later = emptyWorld();
  as(later.f, 'owner');
  await closeAs(later.f, { operationId: randomUUID(), handle: 'sample-owner' });
  const begun = { ...later.t.accountOperations.get('op1'), _id: 'new', operationId: randomUUID() };
  for (let task; (task = later.f.scheduled.find(x => getFunctionName(x.fn) === 'accountClose:step'));) {
    later.f.scheduled.splice(later.f.scheduled.indexOf(task), 1);
    if (task.args.phase === 'finish')
      later.t.accountOperations.set('new', {
        ...begun,
        stage: 'preparing',
        at: later.t.forgeAccounts.get('acct').closing.at + 1,
      });
    await later.f.transaction(() => close.step._handler(later.f.ctx, task.args));
  }
  assert.ok(later.t.forgeAccounts.has('acct'));
  assert.ok(later.t.accountHandles.has('h1'));
  assert.ok(later.t.accountOperations.has('new'));
});

test('every device sign-in, on every page, and every waiting device code end before the account row goes (review #1)', async () => {
  const { f, t } = emptyWorld();
  for (let i = 0; i < close.STEP + 30; i++)
    t.cliCredentials.set(`c${i}`, { ...t.cliCredentials.get('cred'), _id: `c${i}`, credentialId: `d${i}` });
  t.deviceCodes.set(
    'code',
    row('code', {
      deviceHash: 'dh',
      userHash: 'uh',
      operationId: randomUUID(),
      request: 'r',
      name: 'synthetic',
      scope: 'cli',
      expiresAt: 4_102_444_800_000,
      nextPollAt: 0,
      state: 'approved',
      owner: 'owner',
      credentialId: 'pending-device',
    }),
  );
  as(f, 'owner');
  await closeAs(f, { operationId: randomUUID(), handle: 'sample-owner' });
  await background(f);
  assert.equal(t.forgeAccounts.size, 0);
  assert.ok([...t.cliCredentials.values()].every(c => c.revoked));
  assert.equal(t.deviceCodes.get('code').state, 'denied');
});

test('a disputed GitHub identity keeps its conflict mark through a close (review #2)', async () => {
  const { f, t } = emptyWorld();
  t.users.set('u1', { ...t.users.get('u1'), githubConflict: true });
  as(f, 'owner');
  await closeAs(f, { operationId: randomUUID(), handle: 'sample-owner' });
  await background(f);
  assert.equal(t.users.get('u1').githubConflict, true);
});

test('a person who is not the account holder, or a device, cannot close the account', async () => {
  const { f, t } = emptyWorld();
  t.forgeAccounts.set('theirs', row('theirs', { owner: 'other', handle: 'someone-else' }));
  as(f, 'other');
  await assert.rejects(
    closeAs(f, { operationId: randomUUID(), handle: 'sample-owner' }),
    code('BAD_ARGUMENT'),
  );
  f.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'synthetic-device' });
  await assert.rejects(closeAs(f, { operationId: randomUUID(), handle: 'sample-owner' }), e =>
    /^AUTH_/.test(e.data?.code ?? e.code ?? ''),
  );
  await assert.rejects(close.preview._handler(f.ctx, {}), e => /^AUTH_/.test(e.data?.code ?? e.code ?? ''));
  assert.equal(t.forgeAccounts.get('acct').closing, undefined);
  assert.equal(t.forgeAccounts.get('theirs').closing, undefined);
  assert.equal(f.scheduled.length, 0);
});
