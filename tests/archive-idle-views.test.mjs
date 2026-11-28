// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { moduleUrl } from './convex-module.mjs';
import { journalMaintenanceFixture } from './journal-maintenance-fixture.mjs';

const [{ read: fyi }, { read: needs }, { read: loose }, { forLane: check }, { resolve }] = await Promise.all(
  ['projectNeedsFyi', 'projectNeedsMe', 'projectLooseEnds', 'projectFailureCause', 'urlProjects'].map(
    name => import(moduleUrl(`../convex/${name}.ts`)),
  ),
);

test('records and operations archive publications do not wake the signed-in home and landing check reads', async t => {
  const { f, drain, transcript } = await journalMaintenanceFixture(t);
  const { projectId } = f;
  const project = f.tables.hostedProjects.get(projectId);
  const initial = [...f.tables.projectHostedRecords.values()].find(row => row.kind === 'lane');
  assert(initial, 'the fixture includes a landed Lane with retained history');
  await f.c.transaction(
    'setAddress',
    {
      _handler: async ctx => {
        await ctx.db.patch(projectId, { slug: 'project', visibility: 'public' });
        await ctx.db.insert('forgeAccounts', { owner: project.owner, handle: 'builder' });
      },
    },
    {},
  );
  const subscribe = async (fn, args, actor = project.owner) => {
    const run = () => f.c.transaction('observerBudgetPage', fn, { projectId, ...args }, actor);
    const value = await run();
    return { run, value, current: f.c.readSet() };
  };
  const addr = await subscribe(resolve, {}, 'reader');
  const homeFyi = await subscribe(fyi, {});
  const homeNeeds = await subscribe(needs, {});
  const homeLoose = await subscribe(loose, {});
  const landed = await subscribe(check, { laneId: initial.key });
  assert.equal(addr.value?.slug, 'project');
  assert.equal(JSON.parse(homeFyi.value).landings.length, 1);
  assert(JSON.parse(landed.value).landing, 'the check query must select a real landing');
  await drain();
  const phases = transcript
    .filter(row => row.name === 'projectJournalPublish:page' && JSON.parse(row.value).archived > 0)
    .map(row => row.args.phase ?? 0);
  assert(phases.includes(0), 'a records page was published');
  assert(phases.includes(1), 'an operations page was published');
  const views = [homeFyi, homeNeeds, homeLoose, landed, addr];
  const before = f.c.counts.length;
  for (const view of views) if (!view.current()) await view.run();
  assert.deepEqual(
    {
      executions: f.c.counts.length - before,
      bytes: f.c.counts.slice(before).reduce((n, row) => n + row.readBytes, 0),
    },
    { executions: 0, bytes: 0 },
  );

  const other = 'quiet-lane';
  await f.c.transaction(
    'visibleChanges',
    {
      _handler: async ctx => {
        await ctx.db.insert('projectHostedPresence', {
          projectId,
          laneId: other,
          intentId: 'quiet-intent',
          actor: project.owner,
          goal: 'Finish the decoder',
          paths: [],
          pathCount: 0,
          at: f.now() - 3 * 60 * 60_000,
        });
        for (const [operationId, text, choices] of [
          ['heads-up', 'Decoder work started', []],
          ['question', 'Which decoder should land?', ['First', 'Second']],
        ]) {
          await ctx.db.insert('projectCoordinationEvents', {
            projectId,
            operationId,
            actor: 'other-member',
            at: f.now(),
            command: { kind: 'message', recipient: project.owner, text, choices, context: { laneId: other } },
            kind: 'message',
            recipientActor: project.owner,
            laneId: other,
          });
        }
        const old = await ctx.db
          .query('projectHostedMainAudits')
          .withIndex('by_project', q => q.eq('projectId', projectId))
          .unique();
        const audit = { runId: 'synthetic-audit', head: 'f'.repeat(64), sequence: 500, status: 'failed' };
        if (old) await ctx.db.patch(old._id, { audit });
        else await ctx.db.insert('projectHostedMainAudits', { projectId, audit });
      },
    },
    {},
  );
  for (const view of [homeFyi, homeNeeds, homeLoose, landed]) assert.equal(view.current(), false);
  assert.equal(JSON.parse(await homeFyi.run()).messages[0]?.text, 'Decoder work started');
  assert.equal((await homeNeeds.run()).asks[0]?.text, 'Which decoder should land?');
  assert(JSON.stringify(JSON.parse(await homeLoose.run()).groups).includes(other));
  assert.equal(JSON.parse(await landed.run()).main.result, 'failed');

  await f.c.transaction(
    'rename',
    { _handler: ctx => ctx.db.patch(projectId, { name: 'Renamed project' }) },
    {},
  );
  assert.equal(addr.current(), false);
  assert.equal((await addr.run()).name, 'Renamed project');
  const renamed = await subscribe(resolve, {}, 'reader');
  await f.c.transaction(
    'makePrivate',
    { _handler: ctx => ctx.db.patch(projectId, { visibility: 'private' }) },
    {},
  );
  assert.equal(renamed.current(), false);
  assert.equal(await addr.run(), null, 'revoked readers lose access to the address');
});

test('the finish publisher retains the FYI check Lane and a valid title when clipping splits an emoji', async t => {
  const prefix = 'a'.repeat(279);
  const { f } = await journalMaintenanceFixture(t, { message: `${prefix}🔧 finished\n\nBody` });
  const snapshot = [...f.tables.projectHostedAcceptanceSnapshots.values()].at(-1);
  assert.equal(snapshot?.fyi?.title, prefix + '\uFFFD', 'Convex must be able to store the clipped title');
  const first = await f.c.transaction('observerBudgetPage', fyi, { projectId: f.projectId });
  const meter = f.c.counts.at(-1);
  const row = JSON.parse(first).landings[0];
  assert(row?.laneId, 'the published landing links to its check Lane');
  assert(row.checked);
  assert.equal(meter.readDocumentsByTable.projectHostedFinishes, undefined);
  await f.c.transaction(
    'simulateLegacySnapshot',
    { _handler: ctx => ctx.db.patch(snapshot._id, { fyi: undefined }) },
    {},
  );
  const legacy = await f.c.transaction('observerBudgetPage', fyi, { projectId: f.projectId });
  assert.deepEqual(JSON.parse(first), JSON.parse(legacy));
});
