// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './convex-module.mjs';
import { state, projectRow } from './hosted-fixture.mjs';
import { saveFixture } from './hosted-saves-fixture.mjs';

const { page, run, metricsProbe, reportsEdge } = await import(moduleUrl('../convex/legacyShapeSweep.ts'));

const direct = s => args => page._handler(s.ctx, args);
const transacted = s => args => s.transaction('sweep', { _handler: ctx => page._handler(ctx, args) }, {});
async function drain(s, family, apply, call = direct(s)) {
  const total = { pages: 0, scanned: 0, changed: 0, counts: {}, blockedIds: [] };
  let cursor = null;
  do {
    const next = await call({ family, cursor, apply });
    total.pages++;
    total.scanned += next.scanned;
    total.changed += next.changed;
    for (const [key, count] of Object.entries(next.counts))
      total.counts[key] = (total.counts[key] ?? 0) + count;
    total.blockedIds.push(...next.blockedIds);
    cursor = next.cursor;
  } while (cursor !== null && total.pages < 20);
  return total;
}
const snapshot = (s, table) => structuredClone([...s.tables[table].values()]);

test('F11 sweep: a dry run counts every retired project field and writes nothing, an apply unsets them, a replay writes 0', async () => {
  const s = state([]);
  for (let i = 0; i < 250; i++)
    s.tables.hostedProjects.set(
      `project-${i}`,
      projectRow({
        _id: `project-${i}`,
        name: `Synthetic ${i}`,
        ...(i % 5 === 0 ? { r2StorageUsed: true } : {}),
        ...(i % 25 === 0 ? { r2Writes: true } : {}),
        ...(i === 3 ? { stateTrees: { any: 'shape' } } : {}),
        ...(i === 4 ? { purgeBlocked: 'R2_MAINTENANCE_DISABLED' } : {}),
      }),
    );
  const before = snapshot(s, 'hostedProjects');
  const dry = await drain(s, 'projects', false);
  assert.equal(dry.scanned, 250);
  assert.ok(dry.pages >= 3, 'the scan spans several bounded pages');
  assert.deepEqual(dry.counts, {
    'hostedProjects.r2StorageUsed': 50,
    'hostedProjects.r2Writes': 10,
    'hostedProjects.stateTrees': 1,
    'hostedProjects.purgeBlocked:R2_MAINTENANCE_DISABLED': 1,
  });
  assert.deepEqual(snapshot(s, 'hostedProjects'), before, 'a dry run writes nothing');
  assert.deepEqual(
    dry.blockedIds,
    ['project-4'],
    'a project blocked by the retired switch is reported, not touched',
  );
  await drain(s, 'projects', true);
  const rows = [...s.tables.hostedProjects.values()];
  assert.ok(
    rows.every(
      row => row.r2StorageUsed === undefined && row.r2Writes === undefined && row.stateTrees === undefined,
    ),
  );
  assert.equal(s.tables.hostedProjects.get('project-4').purgeBlocked, 'R2_MAINTENANCE_DISABLED');
  assert.equal(
    s.tables.hostedProjects.get('project-7').name,
    'Synthetic 7',
    'every other field is untouched',
  );
  const again = await drain(s, 'projects', true);
  assert.equal(again.changed, 0, 'a replay writes 0');
});

test('F11 sweep: imports and users lose only their retired fields', async () => {
  const s = state([
    {
      _id: 'a',
      _creationTime: 1,
      scope: 'owner',
      owner: 'owner',
      repository: 'x/y',
      ref: 'main',
      visibility: 'private',
      phase: 'ready',
      processed: 1,
      total: 1,
      generation: 1,
      remote: true,
      workerClaimed: true,
      r2Writes: true,
    },
    {
      _id: 'b',
      _creationTime: 2,
      scope: 'owner',
      owner: 'owner',
      repository: 'x/z',
      ref: 'main',
      visibility: 'private',
      phase: 'ready',
      processed: 1,
      total: 1,
      generation: 1,
      syncRevision: 4,
    },
  ]);
  s.tables.users.set('u1', {
    _id: 'u1',
    _creationTime: 1,
    accountKey: 'k1',
    emailVerified: true,
    legacyGithubProvider: true,
    legacyPasskeyFlow: { operationId: 'o', sessionId: 's', confirmed: true },
    githubId: '1',
  });
  s.tables.users.set('u2', { _id: 'u2', _creationTime: 2, accountKey: 'k2', emailVerified: false });
  const dry = { imports: await drain(s, 'imports', false), users: await drain(s, 'users', false) };
  assert.deepEqual(dry.imports.counts, {
    'imports.remote': 1,
    'imports.workerClaimed': 1,
    'imports.r2Writes': 1,
  });
  assert.deepEqual(dry.users.counts, { 'users.legacyGithubProvider': 1, 'users.legacyPasskeyFlow': 1 });
  assert.equal(s.tables.imports.get('a').remote, true, 'a dry run writes nothing');
  await drain(s, 'imports', true);
  await drain(s, 'users', true);
  assert.equal(s.tables.imports.get('a').remote, undefined);
  assert.equal(s.tables.imports.get('b').syncRevision, 4, 'live import fields stay');
  assert.equal(s.tables.users.get('u1').githubId, '1', 'live account fields stay');
  assert.equal(s.tables.users.get('u1').legacyPasskeyFlow, undefined);
  assert.equal((await drain(s, 'users', true)).changed, 0);
});

test('F11 sweep: a retired stateTree is unset on object rows across pages and a replay writes 0', async () => {
  const s = state([]);
  for (let i = 0; i < 600; i++)
    s.tables.projectObjects.set(`object-${i}`, {
      _id: `object-${i}`,
      _creationTime: i + 1,
      projectId: 'project',
      digest: String(i).padStart(64, '0'),
      size: 1,
      nonce: 'n',
      removed: false,
      ...(i === 300 ? { stateTree: 'x'.repeat(2000) } : {}),
    });
  const dry = await drain(s, 'objects', false);
  assert.equal(dry.scanned, 600);
  assert.equal(dry.counts['projectObjects.stateTree'], 1);
  assert.equal(s.tables.projectObjects.get('object-300').stateTree.length, 2000);
  await drain(s, 'objects', true);
  assert.equal(s.tables.projectObjects.get('object-300').stateTree, undefined);
  assert.equal((await drain(s, 'objects', true)).changed, 0);
});

test('F12 sweep: a membership with no handle takes its account handle, or null; set handles stay', async () => {
  const s = state([]);
  s.tables.forgeAccounts.set('acct', {
    _id: 'acct',
    _creationTime: 1,
    owner: 'user_one',
    handle: 'one-handle',
  });
  s.tables.teamMembers.set('m1', { _id: 'm1', _creationTime: 1, teamId: 't', member: 'user_one' });
  s.tables.teamMembers.set('m2', { _id: 'm2', _creationTime: 2, teamId: 't', member: 'user_none' });
  s.tables.teamMembers.set('m3', {
    _id: 'm3',
    _creationTime: 3,
    teamId: 't',
    member: 'user_one',
    handle: 'kept',
  });
  const dry = await drain(s, 'teamMembers', false);
  assert.equal(dry.counts['teamMembers.handle'], 2);
  assert.equal(s.tables.teamMembers.get('m1').handle, undefined);
  await drain(s, 'teamMembers', true);
  assert.equal(s.tables.teamMembers.get('m1').handle, 'one-handle');
  assert.equal(s.tables.teamMembers.get('m2').handle, null);
  assert.equal(s.tables.teamMembers.get('m3').handle, 'kept');
  assert.equal((await drain(s, 'teamMembers', true)).changed, 0);
});

test('F10 sweep: every overlap row ends with lastActivityAt: open rows take the Lane record time, a row with no record closes, closed rows take presence or creation time', async () => {
  const s = await saveFixture('original', 'a.txt');
  const record = JSON.parse(
    [...s.tables.projectHostedRecordBodies.values()].find(row => JSON.parse(row.value).kind === 'lane').value,
  );
  const [open] = [...s.tables.projectHostedOverlapLanes.values()].filter(row => row.laneId === record.id);
  assert.ok(open?.open && open.lastActivityAt > 0, 'a Lane saved today already carries the field');
  const { _id: _a, _creationTime: _b, ...fields } = structuredClone(open);
  const orphan = s.insert('projectHostedOverlapLanes', { ...fields, laneId: 'orphan-lane' });
  const closed = s.insert('projectHostedOverlapLanes', {
    ...fields,
    laneId: 'closed-lane',
    open: false,
    presenceRow: { id: open.presenceRow?.id, at: 4242 },
  });
  for (const id of [open._id, orphan, closed])
    s.patch('projectHostedOverlapLanes', id, { lastActivityAt: undefined });
  const dry = await drain(s, 'overlapLanes', false, transacted(s));
  assert.equal(dry.counts['overlapLanes.lastActivityAt:open'], 2);
  assert.equal(dry.counts['overlapLanes.lastActivityAt:closed'], 1);
  assert.equal(
    s.tables.projectHostedOverlapLanes.get(open._id).lastActivityAt,
    undefined,
    'a dry run writes nothing',
  );
  await drain(s, 'overlapLanes', true, transacted(s));
  const rows = s.tables.projectHostedOverlapLanes;
  assert.equal(
    rows.get(open._id).lastActivityAt,
    Date.parse(record.at),
    'the Lane record time, as the healer stamped',
  );
  assert.equal(rows.get(open._id).open, true);
  assert.equal(rows.get(orphan).open, false, 'a row with no Lane record holds no open Lane');
  assert.ok(rows.get(orphan).lastActivityAt !== undefined);
  assert.equal(rows.get(closed).lastActivityAt, 4242, 'a closed row takes its presence time with no read');
  assert.ok([...rows.values()].every(row => row.lastActivityAt !== undefined));
  assert.equal((await drain(s, 'overlapLanes', true, transacted(s))).changed, 0, 'a replay writes 0');
});

test('F9 probe: reports check runs without a metric projection, read-only', async () => {
  const s = state([]);
  const project = 'probe-project';
  s.tables.hostedProjects.set(project, projectRow({ _id: project }));
  const run = (id, at, fields, value = '{}') =>
    s.tables.projectHostedCheckRuns.set(id, {
      _id: id,
      _creationTime: at,
      projectId: project,
      runId: id,
      candidateId: 'c',
      status: 'passed',
      value,
      ...fields,
    });
  run('old', 1000, { metricsProjected: true });
  run('late', 11_000, { reportStorage: 'r2', status: 'pending' });
  const before = snapshot(s, 'projectHostedCheckRuns');
  const probe = await metricsProbe._handler(s.ctx, { cursor: null });
  const found = probe.projects.find(entry => entry.project === project);
  assert.equal(found.unprojected, 1);
  assert.deepEqual(found.statuses, { pending: 1 });
  assert.equal(found.unprojectable, 1, 'an unfinished run has no projection to build');
  assert.equal(found.oldestRunInline, true);
  assert.equal(found.newestRunInline, false);
  assert.equal(probe.resume, null);
  assert.deepEqual(snapshot(s, 'projectHostedCheckRuns'), before, 'a probe writes nothing');
});

test('F9 probe: the report cutoff is the newest inline run even with a gap before the first R2 run, and ci-status runs never count', async () => {
  const s = state([]);
  const project = 'edge-project';
  const ci = JSON.stringify({ configuration: { provider: 'ci-status' } });
  const run = (id, at, fields = {}, value = '{}') =>
    s.tables.projectHostedCheckRuns.set(id, {
      _id: id,
      _creationTime: at,
      projectId: project,
      runId: id,
      candidateId: 'c',
      status: 'passed',
      value,
      ...fields,
    });
  // Inline reports at 9000 and 10000, nothing until the first R2 report at 17000.
  run('a', 1000);
  run('b', 9000);
  run('c', 10_000);
  run('status-after', 12_000, {}, ci);
  for (const [i, at] of [17_000, 18_000, 19_000].entries()) run(`r${i}`, at, { reportStorage: 'r2' });
  const edge = await reportsEdge._handler(s.ctx, { projectId: project, steps: 40 });
  assert.equal(edge.inlineAtOrAfter, 10_000, 'the 10:00 report is the newest inline one, not the 09:00 one');
  assert.ok(edge.r2Before <= 17_000 && edge.r2Before > 10_000);
  assert.equal(edge.resolved, true);
  const short = await reportsEdge._handler(s.ctx, { projectId: project, steps: 1 });
  assert.equal(short.resolved, false, 'too few steps leave the bracket open, never a false cutoff');
  assert.ok(short.r2Before > edge.inlineAtOrAfter, 'an open bracket still bounds the cutoff from above');
  run('tail', 30_000);
  assert.equal((await reportsEdge._handler(s.ctx, { projectId: project, steps: 5 })).lastRunInline, true);
});

test('run refuses a budget above 400 MB and stops at its read budget with a cursor', async () => {
  const s = state([]);
  for (let i = 0; i < 300; i++)
    s.tables.hostedProjects.set(`project-${i}`, projectRow({ _id: `project-${i}` }));
  const runner = { runMutation: (_ref, args) => page._handler(s.ctx, args) };
  await assert.rejects(run._handler({ ...runner }, { apply: false, budgetBytes: 500_000_000 }), /400 MB/);
  const whole = await run._handler(runner, {
    apply: false,
    budgetBytes: 100_000_000,
    families: ['projects'],
  });
  assert.equal(whole.totals[0].stopped, null);
  assert.equal(whole.totals[0].scanned, 300);
  const first = await run._handler(runner, {
    apply: false,
    budgetBytes: 2 * 1024 * 1024 + 1,
    families: ['projects'],
  });
  assert.equal(first.totals[0].stopped, 'budget', 'one more page would pass the budget');
  assert.equal(first.totals[0].pages, 1);
  assert.ok(first.totals[0].cursor, 'the stop names the cursor to continue from');
  const rest = await run._handler(runner, {
    apply: false,
    budgetBytes: 100_000_000,
    families: ['projects'],
    from: { family: 'projects', cursor: first.totals[0].cursor },
  });
  assert.equal(first.totals[0].scanned + rest.totals[0].scanned, 300, 'a continued run finishes the scan');
});

test('F11 sweep: the legacy planningArchiveIndexed marker moves into the coverage receipt, and a replay writes 0', async () => {
  const s = state([]);
  s.tables.hostedProjects.set('legacy', projectRow({ _id: 'legacy', planningArchiveIndexed: 2 }));
  s.tables.hostedProjects.set('plain', projectRow({ _id: 'plain' }));
  const dry = await drain(s, 'projects', false);
  assert.equal(dry.counts['hostedProjects.planningArchiveIndexed'], 1);
  assert.equal(s.tables.hostedProjects.get('legacy').planningArchiveIndexed, 2, 'a dry run writes nothing');
  assert.equal(s.tables.projectJournalReceipts.size, 0);
  await drain(s, 'projects', true);
  assert.equal(s.tables.hostedProjects.get('legacy').planningArchiveIndexed, undefined);
  const [receipt] = [...s.tables.projectJournalReceipts.values()];
  assert.equal(receipt.projectId, 'legacy');
  assert.equal(
    JSON.parse(receipt.envelope).ready,
    true,
    'the marker said coverage was complete; the receipt says so too',
  );
  assert.equal((await drain(s, 'projects', true)).changed, 0);
});
