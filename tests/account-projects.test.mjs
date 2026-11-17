// SPDX-License-Identifier: Apache-2.0
// Incident 2026-11-17 (Item 3d5d8839): the owner of a project with 276 newer removed (test) projects saw "No projects
// yet": the owner list paged removed rows first and the screen filtered them out. Active projects must never sit
// behind removed ones, and member projects belong in the person's list with their role. Review 5dccf92e: the list
// pages by activity with a real cursor, a scoped device reads its one project, and excluded grants never fill a page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { projectRow, state } from './hosted-fixture.mjs';

const projectBackups = await import(moduleUrl('../convex/projectBackups.ts'));
const accountProjects = await import(moduleUrl('../convex/accountProjects.ts'));
const order = await import(moduleUrl('../convex/accountProjectOrder.ts'));
const line = await import(moduleUrl('../convex/projectLiveLineStore.ts'));
const page = { paginationOpts: { cursor: null, numItems: 20 } };
const HOUR = 3_600_000;

function project(s, id, fields = {}) {
  s.tables.hostedProjects.set(id, projectRow({ _id: id, key: id, name: id, ...fields }));
}
function grant(s, table, id, projectId, person) {
  s.tables[table].set(id, {
    _id: id,
    _creationTime: 1,
    projectId,
    ...(table === 'projectContributors' ? { contributor: person } : { reader: person }),
  });
}
/** The one-time backfill, run to completion: the same writer a restore uses. Returns its runs. */
async function backfill(s, ctx = s.ctx) {
  let args = {};
  for (let runs = 1; ; runs++) {
    const result = await s.transaction(() => order.backfill._handler(ctx, args));
    if (result.isDone) {
      s.scheduled.length = 0;
      return runs;
    }
    args = s.scheduled.at(-1).args;
  }
}
/** The provider's per-transaction read ceiling, enforced: every get and query range counts (4,096 max). */
function metered(s) {
  const seen = { now: 0, max: 0 };
  const db = new Proxy(s.ctx.db, {
    get: (target, key) =>
      key === 'get' || key === 'query'
        ? (...args) => {
            if (++seen.now > 4096) throw new Error('over the provider per-transaction range limit');
            seen.max = Math.max(seen.max, seen.now);
            return target[key](...args);
          }
        : target[key],
  });
  const transaction = s.transaction;
  s.transaction = run => {
    seen.now = 0;
    return transaction(run);
  };
  return { ctx: { ...s.ctx, db }, seen };
}
/** Runs every scheduled order task (touch, drop, rebuild) until none is left; returns how many ran. */
async function drain(s, limit = 100) {
  for (let ran = 0; ran < limit; ran++) {
    const task = s.scheduled.shift();
    if (!task) return ran;
    const name = getFunctionName(task.fn).split(':')[1];
    await s.transaction(() => order[name]._handler(s.ctx, task.args));
  }
  throw new Error('order tasks never settled');
}
const orderRows = (s, projectId) =>
  [...s.tables.accountProjectOrder.values()].filter(r => r.projectId === projectId);
/** Every page of the person's list, following the cursor until it is done. */
async function all(s, numItems, ctx = s.ctx) {
  const seen = [];
  let cursor = null;
  for (let pages = 0; pages < 50; pages++) {
    const result = await accountProjects.list._handler(ctx, { paginationOpts: { cursor, numItems } });
    seen.push(...result.page);
    if (result.isDone) return seen;
    cursor = result.continueCursor;
  }
  throw new Error('the cursor never finished');
}
function owner() {
  const s = state([]);
  s.tables.hostedProjects.clear();
  project(s, 'active', { _creationTime: 10, name: 'Active project' });
  for (let i = 0; i < 25; i++)
    project(s, `removed-${i}`, { _creationTime: 100 + i, removal: i % 2 ? 'deleted' : 'trash' });
  s.caller('owner');
  return s;
}

test('an owner with 25 newer removed projects sees the older active one on the first page', async () => {
  const s = owner();
  await backfill(s);
  const active = await projectBackups.list._handler(s.ctx, page);
  assert.deepEqual(
    active.page.map(row => row.id),
    ['active'],
  );
  const removed = await projectBackups.list._handler(s.ctx, { ...page, removed: true });
  assert.equal(removed.page.length, 20);
  assert.ok(removed.page.every(row => row.removal));
  const account = await accountProjects.list._handler(s.ctx, {
    paginationOpts: { cursor: null, numItems: 1 },
  });
  assert.deepEqual(
    account.page.map(row => [row.id, row.role]),
    [['active', 'owner']],
  );
});

test('the account list includes member projects with their role and never a removed or foreign one', async () => {
  const s = owner();
  for (const [id, removal] of [
    ['shared-write', undefined],
    ['shared-read', undefined],
    ['shared-gone', 'trash'],
    ['foreign', undefined],
  ])
    project(s, id, { _creationTime: 50, owner: 'other', ...(removal ? { removal } : {}) });
  grant(s, 'projectContributors', 'g1', 'shared-write', 'owner');
  grant(s, 'projectContributors', 'g2', 'shared-gone', 'owner');
  grant(s, 'projectReaders', 'r1', 'shared-read', 'owner');
  await backfill(s);
  const rows = await all(s, 50);
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.id, row.role])), {
    active: 'owner',
    'shared-write': 'write',
    'shared-read': 'read',
  });
  s.caller(undefined);
  assert.deepEqual((await accountProjects.list._handler(s.ctx, page)).page, []);
});

test('201 owned projects are all reachable by cursor, each once, with no ceiling', async () => {
  const s = state([]);
  s.tables.hostedProjects.clear();
  for (let i = 0; i < 201; i++) project(s, `p-${String(i).padStart(3, '0')}`, { _creationTime: i * HOUR });
  s.caller('owner');
  await backfill(s);
  const rows = await all(s, 50);
  assert.equal(rows.length, 201);
  assert.equal(new Set(rows.map(row => row.id)).size, 201);
  assert.equal(rows[0].id, 'p-200', 'newest activity first');
  // The server caps a page, never the list.
  const big = await accountProjects.list._handler(s.ctx, { paginationOpts: { cursor: null, numItems: 500 } });
  assert.equal(big.page.length, 100);
  assert.equal(big.isDone, false);
});

test('a device limited to the oldest of 201 projects reads that project only, directly', async () => {
  const s = state([]);
  s.tables.hostedProjects.clear();
  for (let i = 0; i < 201; i++) project(s, `p-${String(i).padStart(3, '0')}`, { _creationTime: i * HOUR });
  s.caller('owner');
  await backfill(s);
  const device = projectId => {
    s.tables.cliCredentials.set('cred', {
      _id: 'cred',
      _creationTime: 1,
      credentialId: 'synthetic-device',
      owner: 'owner',
      name: 'test',
      tokenHash: 'synthetic-hash',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      revoked: false,
      scope: 'cli',
      settings: { projects: { kind: 'project', projectId } },
    });
    s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'synthetic-device' });
  };
  device('p-000');
  const result = await accountProjects.list._handler(s.ctx, page);
  assert.deepEqual(
    result.page.map(row => row.id),
    ['p-000'],
  );
  assert.equal(result.isDone, true);
  device('missing');
  assert.deepEqual((await accountProjects.list._handler(s.ctx, page)).page, []);
});

test('a live shared project behind 201 newer removed shared projects is on the first page', async () => {
  const s = state([]);
  s.tables.hostedProjects.clear();
  project(s, 'live', { _creationTime: 1, owner: 'other' });
  grant(s, 'projectContributors', 'g-live', 'live', 'member');
  for (let i = 0; i < 201; i++) {
    project(s, `gone-${i}`, { _creationTime: 1000 + i, owner: 'other', removal: 'trash' });
    grant(s, 'projectContributors', `g-${i}`, `gone-${i}`, 'member');
  }
  s.caller('member');
  await backfill(s);
  const first = await accountProjects.list._handler(s.ctx, page);
  assert.deepEqual(
    first.page.map(row => [row.id, row.role]),
    [['live', 'write']],
  );
});

test('the oldest-created but most recently landed of 51 projects leads the first page', async () => {
  const s = state([]);
  s.tables.hostedProjects.clear();
  for (let i = 0; i < 51; i++)
    project(s, `p-${String(i).padStart(2, '0')}`, { _creationTime: (i + 1) * HOUR });
  s.caller('owner');
  await backfill(s);
  await s.transaction(() =>
    line.writeLineMain(s.ctx, 'p-00', { head: 'h', at: new Date(500 * HOUR).toISOString(), check: 'passed' }),
  );
  const [touch] = s.scheduled.splice(0);
  assert.equal(getFunctionName(touch.fn), 'accountProjectOrder:touch');
  await s.transaction(() => order.touch._handler(s.ctx, touch.args));
  const first = await accountProjects.list._handler(s.ctx, {
    paginationOpts: { cursor: null, numItems: 50 },
  });
  assert.equal(first.page[0].id, 'p-00');
  assert.equal(first.page[0].activityAt, 500 * HOUR);
  assert.equal(first.page.length, 50);
});

test('acceptance schedules the order update once per (project, hour); replays and later landings that hour add none', async () => {
  const s = owner();
  await backfill(s);
  const at = minutes => new Date(400 * HOUR + minutes * 60_000).toISOString();
  await s.transaction(() => line.writeLineMain(s.ctx, 'active', { head: 'a', at: at(1) }));
  await s.transaction(() => line.writeLineMain(s.ctx, 'active', { head: 'a', at: at(1) })); // replay: same main
  await s.transaction(() => line.writeLineMain(s.ctx, 'active', { head: 'b', at: at(40) })); // same hour
  assert.deepEqual(
    s.scheduled.map(task => [getFunctionName(task.fn), task.args.hour]),
    [['accountProjectOrder:touch', 400]],
  );
  const [touch] = s.scheduled.splice(0);
  await s.transaction(() => order.touch._handler(s.ctx, touch.args));
  await s.transaction(() => order.touch._handler(s.ctx, touch.args)); // a retried run changes nothing
  await s.transaction(() => order.touch._handler(s.ctx, { projectId: 'active', hour: 3 })); // an older hour neither
  const [row] = [...s.tables.accountProjectOrder.values()].filter(r => r.projectId === 'active');
  assert.equal(row.activityHour, 400);
  // Without a scheduler (the legacy line rebuild) nothing is scheduled and no hour is recorded.
  await line.writeLineMain({ db: s.ctx.db }, 'active', { head: 'c', at: at(5 * 60) });
  assert.equal(s.scheduled.length, 0);
});

test('removing a grant or the project deletes the person row in the same transaction; restore rebuilds it', async () => {
  const s = owner();
  project(s, 'shared', { _creationTime: 50, owner: 'other' });
  grant(s, 'projectReaders', 'r1', 'shared', 'owner');
  await backfill(s);
  const rows = () =>
    [...s.tables.accountProjectOrder.values()].map(r => `${r.person}:${r.projectId}:${r.role}`).sort();
  assert.deepEqual(rows(), ['other:shared:owner', 'owner:active:owner', 'owner:shared:read']);
  s.tables.projectReaders.delete('r1');
  await s.transaction(() => order.syncPersonOrder(s.ctx, 'shared', 'owner'));
  assert.deepEqual(rows(), ['other:shared:owner', 'owner:active:owner']);
  await s.transaction(() => order.dropProjectOrder(s.ctx, 'active'));
  assert.deepEqual(rows(), ['other:shared:owner']);
  await s.transaction(() => order.restoreProjectOrder(s.ctx, s.tables.hostedProjects.get('active')));
  assert.deepEqual(rows(), ['other:shared:owner', 'owner:active:owner']);
});

test('backfill of 100 projects x 20 members stays inside the per-transaction budget, finishes, and a rerun writes nothing', async () => {
  const s = state([]);
  s.tables.hostedProjects.clear();
  for (let p = 0; p < 100; p++) {
    project(s, `p-${p}`, { _creationTime: (p + 1) * HOUR });
    for (let m = 0; m < 20; m++) grant(s, 'projectContributors', `g-${p}-${m}`, `p-${p}`, `member-${m}`);
  }
  s.caller('owner');
  const grants = structuredClone([...s.tables.projectContributors.values()]);
  const { ctx, seen } = metered(s);
  const runs = await backfill(s, ctx);
  assert.ok(seen.max <= 1000, `at most 1,000 ranges per transaction (saw ${seen.max})`);
  assert.ok(runs > 1, 'the work continues across scheduled runs');
  assert.equal(s.tables.accountProjectOrder.size, 100 + 2000);
  const snapshot = JSON.stringify(
    [...s.tables.accountProjectOrder.values()].sort((a, b) => a._id.localeCompare(b._id)),
  );
  await backfill(s, ctx);
  assert.equal(
    JSON.stringify([...s.tables.accountProjectOrder.values()].sort((a, b) => a._id.localeCompare(b._id))),
    snapshot,
    'a rerun writes nothing',
  );
  assert.deepEqual([...s.tables.projectContributors.values()], grants, 'no grant changes');
});

test('touch continues only while stale rows remain: current, superseded and interleaved hours', async () => {
  const s = owner();
  for (let m = 0; m < 200; m++) grant(s, 'projectReaders', `r-${m}`, 'active', `reader-${m}`);
  await backfill(s);
  assert.equal(orderRows(s, 'active').length, 201);
  const set = hour =>
    orderRows(s, 'active').forEach(row =>
      s.tables.accountProjectOrder.set(row._id, { ...row, activityHour: hour }),
    );
  // Fully current multi-page project: one empty range, nothing patched, nothing scheduled.
  set(500);
  await s.transaction(() => order.touch._handler(s.ctx, { projectId: 'active', hour: 500 }));
  await s.transaction(() => order.touch._handler(s.ctx, { projectId: 'active', hour: 400 })); // superseded hour
  assert.equal(s.scheduled.length, 0);
  assert.ok(orderRows(s, 'active').every(row => row.activityHour === 500));
  // Stale rows: 100 per run, continuing exactly while stale rows remain (201 rows: 3 runs).
  set(300);
  await s.transaction(() => order.touch._handler(s.ctx, { projectId: 'active', hour: 500 }));
  assert.equal(s.scheduled.length, 1);
  // An older hour's job interleaves with the newer continuation; both settle, rows only move forward.
  await s.transaction(() => order.touch._handler(s.ctx, { projectId: 'active', hour: 400 }));
  const ran = await drain(s);
  assert.ok(ran <= 4, `bounded continuations (ran ${ran})`);
  assert.ok(orderRows(s, 'active').every(row => row.activityHour === 500));
  // A replay of the finished hour reads one empty range and schedules nothing.
  await s.transaction(() => order.touch._handler(s.ctx, { projectId: 'active', hour: 500 }));
  assert.equal(s.scheduled.length, 0);
});

/** Review ff347162 finding 3: what one project-hour of order upkeep costs, by membership size. Counts every touch run
 * (continuations too), the rows each run's one range returns, the rows patched and their bytes; retained storage (the
 * rows sitting there) is reported apart from bytes rewritten. Index entries rewritten: two per patched row (the
 * by_person_and_activity and by_project_and_activity keys both carry the hour). */
async function projectHourCost(people) {
  const s = owner();
  for (let m = 0; m < people - 1; m++) grant(s, 'projectReaders', `r-${m}`, 'active', `reader-${m}`);
  await backfill(s);
  const counted = { runs: 0, rowsRead: 0, patched: 0, bytesRewritten: 0 };
  const chain = value =>
    typeof value !== 'object' || value === null
      ? value
      : new Proxy(value, {
          get: (target, key) => {
            const member = target[key];
            if (typeof member !== 'function') return member;
            return (...args) => {
              const out = member.apply(target, args);
              if (key === 'take') return out.then(rows => ((counted.rowsRead += rows.length), rows));
              return chain(out);
            };
          },
        });
  const db = new Proxy(s.ctx.db, {
    get: (target, key) => {
      if (key === 'query') return (...args) => chain(target.query(...args));
      if (key === 'patch')
        return async (id, fields) => {
          await target.patch(id, fields);
          counted.patched++;
          counted.bytesRewritten += JSON.stringify(s.tables.accountProjectOrder.get(id)).length;
        };
      return target[key];
    },
  });
  const ctx = { ...s.ctx, db };
  const hour = orderRows(s, 'active')[0].activityHour + 1;
  s.scheduled.push({ fn: order.touch, args: { projectId: 'active', hour } });
  while (s.scheduled.length) {
    const task = s.scheduled.shift();
    counted.runs++;
    await s.transaction(() => order.touch._handler(ctx, task.args));
  }
  const rows = orderRows(s, 'active');
  assert.ok(rows.every(row => row.activityHour === hour));
  return {
    people,
    ...counted,
    indexEntriesRewritten: counted.patched * 2,
    retainedBytes: rows.reduce((n, row) => n + JSON.stringify(row).length, 0),
  };
}

test('one project-hour of order upkeep: runs, rows read, rows and bytes rewritten, retained apart', async t => {
  const measured = [];
  for (const people of [1, 2, 21, 151, 1001]) measured.push(await projectHourCost(people));
  t.diagnostic(`projectHourOrderCost ${JSON.stringify(measured)}`);
  for (const m of measured) {
    assert.equal(m.runs, Math.max(1, Math.ceil(m.people / 100)), `${m.people}: one run per 100 stale rows`);
    assert.equal(m.patched, m.people, `${m.people}: each row rewritten once`);
    assert.ok(m.rowsRead <= m.people + m.runs, `${m.people}: each run reads at most one row past its batch`);
    assert.ok(m.bytesRewritten <= m.retainedBytes, `${m.people}: rewrite is bounded by what is retained`);
  }
});

test('removal over 500 members: 500 rows go in its transaction, the rest in bounded cleanup; a restore race keeps the rebuild', async () => {
  const s = owner();
  for (let m = 0; m < 600; m++) grant(s, 'projectReaders', `r-${m}`, 'active', `reader-${m}`);
  await backfill(s);
  assert.equal(orderRows(s, 'active').length, 601);
  const trash = () =>
    s.transaction(async () => {
      s.tables.hostedProjects.set('active', { ...s.tables.hostedProjects.get('active'), removal: 'trash' });
      await order.dropProjectOrder(s.ctx, 'active');
    });
  await trash();
  assert.equal(orderRows(s, 'active').length, 101, '500 rows deleted with the removal');
  // Meanwhile a member whose row is still there does not see the removed project.
  s.caller('reader-599');
  assert.deepEqual(await all(s, 50), []);
  s.caller('owner');
  // Restore before the cleanup runs: it rebuilds every row; the late cleanup sees a live project and leaves them.
  await s.transaction(async () => {
    s.tables.hostedProjects.set('active', { ...s.tables.hostedProjects.get('active'), removal: undefined });
    await order.restoreProjectOrder(s.ctx, s.tables.hostedProjects.get('active'));
  });
  await drain(s);
  assert.equal(orderRows(s, 'active').length, 601);
  // Removal without a restore: the cleanup finishes in bounded runs.
  await trash();
  const runs = await drain(s);
  assert.equal(orderRows(s, 'active').length, 0);
  assert.equal(runs, 2);
});

test('a 1,000-reader restore stays inside 900 ranges in its own run and in every continuation', async () => {
  const s = owner();
  for (let m = 0; m < 1000; m++) grant(s, 'projectReaders', `r-${m}`, 'active', `reader-${m}`);
  await backfill(s);
  await s.transaction(async () => {
    s.tables.hostedProjects.set('active', { ...s.tables.hostedProjects.get('active'), removal: 'trash' });
    await order.dropProjectOrder(s.ctx, 'active');
  });
  await drain(s);
  assert.equal(orderRows(s, 'active').length, 0);
  const { ctx, seen } = metered(s);
  const runs = [];
  await s.transaction(async () => {
    s.tables.hostedProjects.set('active', { ...s.tables.hostedProjects.get('active'), removal: undefined });
    await order.restoreProjectOrder(ctx, s.tables.hostedProjects.get('active'));
  });
  runs.push(seen.max);
  while (s.scheduled.length) {
    const task = s.scheduled.shift();
    seen.max = 0;
    await s.transaction(() => order[getFunctionName(task.fn).split(':')[1]]._handler(ctx, task.args));
    runs.push(seen.max);
  }
  assert.ok(runs.length > 1, 'the restore continues in scheduled runs');
  for (const [i, ranges] of runs.entries()) assert.ok(ranges <= 900, `run ${i}: ${ranges} ranges`);
  assert.equal(orderRows(s, 'active').length, 1001);
});

test('a stale order row never shows a project the person no longer has a role on', async () => {
  const s = owner();
  project(s, 'shared', { _creationTime: 50, owner: 'other' });
  grant(s, 'projectContributors', 'g1', 'shared', 'owner');
  await backfill(s);
  s.tables.projectContributors.delete('g1'); // a grant removed without its order write (the safety net only)
  assert.deepEqual(
    (await all(s, 50)).map(row => row.id),
    ['active'],
  );
});

test('a 50-row page re-checks roles only for member rows: owner rows add no read', async () => {
  const reads = async ownerRows => {
    const s = state([]);
    s.tables.hostedProjects.clear();
    for (let i = 0; i < 50; i++) {
      const id = `p-${i}`;
      project(s, id, { _creationTime: i * HOUR, ...(ownerRows ? {} : { owner: 'other' }) });
      if (!ownerRows) grant(s, 'projectReaders', `r-${i}`, id, 'owner');
    }
    s.caller('owner');
    await backfill(s);
    let reads = 0;
    const db = new Proxy(s.ctx.db, {
      get: (target, key) =>
        key === 'get' || key === 'query'
          ? (...args) => {
              reads++;
              return target[key](...args);
            }
          : target[key],
    });
    await accountProjects.list._handler({ ...s.ctx, db }, { paginationOpts: { cursor: null, numItems: 50 } });
    return reads;
  };
  const owned = await reads(true);
  const member = await reads(false);
  // A reader row costs two role reads (no write grant, then the read grant); owner rows none.
  assert.equal(member - owned, 100);
});

test('class guard: every Convex module that writes a grant row keeps the person order row in the same transaction', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../convex/', import.meta.url);
  const missing = readdirSync(dir)
    .filter(file => file.endsWith('.ts') && file !== 'accountProjectOrder.ts')
    .filter(file => {
      const source = readFileSync(new URL(file, dir), 'utf8');
      return /insert\('project(Contributors|Readers)'/.test(source) && !/\bsyncPersonOrder\(/.test(source);
    });
  assert.deepEqual(missing, [], 'call syncPersonOrder after the grant write (convex/accountProjectOrder.ts)');
});
