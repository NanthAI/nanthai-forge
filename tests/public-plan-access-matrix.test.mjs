// SPDX-License-Identifier: Apache-2.0
// Item 76be0714: the public plan access matrix. Every viewer (signed out, signed-in stranger, reader, writer, owner)
// against every plan policy (a hidden Item, a hidden Initiative with its Items, a members-only plan) on every read
// surface: the public project page (web, signed out), the Plan screen read, CLI planning reads (list, one Item with
// its comments and landing notes, search, counts, short ids) and People (Latest and counts). Members see everything;
// a viewer without a role sees only what the one visibility rule allows, signed in or not. An Archived and a Deleted
// Item sit in every policy's plan: they are never public, whatever the policy (src/planning-model.ts `concealed`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { setup } from './hosted-planning-fixture.mjs';
import { installPlanningSearch } from './planning-search-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { executeHostedPlanning } from '../dist/hosted-agent-planning.js';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
import {
  hostedContractFeatures,
  planningAuditFeature,
  planningInitiativeCountsFeature,
} from '../dist/hosted-contract-features.js';
import { planningSearchTerms } from '../dist/planning-search.js';
import { successorIntentId } from '../dist/hosted-intent-chain.js';
import { v } from 'convex/values';
import { fixture, id, NOW } from './public-discovery-fixture.mjs';
const index = await import(moduleUrl('../convex/projectWorkIndex.ts'));
const search = await import(moduleUrl('../convex/projectHostedPlanningSearch.ts'));
const hostedPlanning = await import(moduleUrl('../convex/projectHostedPlanning.ts'));
const planView = await import(moduleUrl('../convex/projectPlanView.ts'));
const publicRead = await import(moduleUrl('../convex/publicRead.ts'));
const people = await import(moduleUrl('../convex/personDays.ts'));
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const notes = await import(moduleUrl('../convex/projectIntentLandingNotes.ts'));
const itemWork = await import(moduleUrl('../convex/projectItemWork.ts'));
const { query: registeredQuery } = await import(moduleUrl('../convex/cliServer.ts'));
const discovery = await import(moduleUrl('../convex/publicDiscovery.ts'));
const settled = await import(moduleUrl('../convex/projectPlanSettled.ts'));
const planCounts = await import(moduleUrl('../convex/projectPlanCounts.ts'));
const liveLanes = await import(moduleUrl('../convex/projectHostedLiveLanes.ts'));
const briefings = await import(moduleUrl('../convex/projectBriefings.ts'));
const authority = await import(moduleUrl('../convex/projectAuthority.ts'));
const roles = await import(moduleUrl('../convex/projectRole.ts'));
const hostedRecordReads = await import(moduleUrl('../convex/projectHostedRecordReads.ts'));
const journalRead = await import(moduleUrl('../convex/projectJournalRead.ts'));
const { finishReadProjection, finishPlanProjectProjection } = await import(
  moduleUrl('../convex/projectFinishReadProjection.ts')
);

const VIEWERS = ['signed-out', 'stranger', 'reader', 'writer', 'owner'];
const MEMBERS = new Set(['reader', 'writer', 'owner']);
const POLICIES = ['hidden-item', 'hidden-initiative', 'members-only'];
/** Each plan row carries a token in its title, body, comment and landing note, so any leak names its row. */
const ROWS = ['initiative', 'under', 'done', 'loose', 'lone', 'archived', 'deleted'];
/** Archived and Deleted Items: plan rows a status hides, not a flag. */
const SHELVED = ['archived', 'deleted'];
const SECRET = {
  'hidden-item': ['lone', ...SHELVED],
  'hidden-initiative': ['initiative', 'under', 'done', ...SHELVED],
  'members-only': ROWS,
};
const token = row => `tok${row}x`;
const leaks = (value, secret) => secret.filter(row => JSON.stringify(value ?? null).includes(token(row)));

function port(s) {
  installPlanningSearch(s);
  const invoke = async (name, args) => {
    const [module, fn] = name.split(':');
    const handler = {
      projectWorkIndex: index,
      projectHostedPlanningSearch: search,
      projectHostedPlanning: hostedPlanning,
      projectItemWork: itemWork,
    }[module][fn];
    return handler._handler(s.ctx, args);
  };
  return {
    root: s.directory,
    address: { url: 'https://fixture.invalid', projectId: s.projectId },
    exchange: { client: { query: (ref, args) => invoke(getFunctionName(ref), args) } },
    query: async (name, args) => {
      const value = await invoke(name, { ...args, projectId: s.projectId });
      return typeof value === 'string' ? JSON.parse(value) : value;
    },
    mutation: () => assert.fail('a read made a write'),
    serverFeatures: [...hostedContractFeatures, planningInitiativeCountsFeature, planningAuditFeature],
  };
}

/** One public project with an Initiative and an Item under it, a loose Item and a lone Item; each has a comment and
 * a landing note on its first Intent. Members: a reader, a writer and the owner. */
async function world(t, policy) {
  const s = await setup(t);
  const project = s.tables.hostedProjects.get(s.projectId);
  Object.assign(project, {
    sourceAuthority: { mode: 'server', epoch: 1 },
    visibility: 'public',
    slug: 'atlas',
  });
  s.tables.forgeAccounts.set('acct', { _id: 'acct', owner: 'owner', handle: 'ada' });
  s.tables.accountHandles.set('alias', { _id: 'alias', owner: 'owner', handle: 'ada' });
  s.tables.projectSlugs.set('slug', { _id: 'slug', owner: 'owner', slug: 'atlas', projectId: s.projectId });
  s.tables.projectPublic.set('public', {
    _id: 'public',
    projectId: s.projectId,
    owner: 'owner',
    listed: true,
    stars: 0,
  });
  s.tables.projectReaders.set('r', { _id: 'r', projectId: s.projectId, reader: 'reader' });
  s.tables.projectContributors.set('w', { _id: 'w', projectId: s.projectId, contributor: 'writer' });
  const items = {};
  items.initiative = s.item({ kind: 'initiative', title: `Initiative ${token('initiative')}` });
  items.under = s.item({ initiativeId: items.initiative.itemId });
  // A closed Item under the Initiative: the Plan screen's settled page reads it.
  items.done = s.item({ initiativeId: items.initiative.itemId, status: 'closed' });
  items.loose = s.item({});
  items.lone = s.item({ status: 'proposed' });
  items.archived = s.item({});
  items.deleted = s.item({});
  for (const row of ROWS) {
    Object.assign(items[row], {
      title: `${row} ${token(row)}`,
      body: `Body of ${token(row)}`,
    });
    await s.send(items[row]);
    await s.send({
      action: 'comment-planning-item',
      operationId: randomUUID(),
      itemId: items[row].itemId,
      text: `Comment on ${token(row)}`,
      authorLabel: 'Owner',
    });
    await records.writeHostedRecord(s.ctx, {
      projectId: s.projectId,
      actor: 'owner',
      authorityEpoch: 1,
      expectedVersion: null,
      record: {
        kind: 'intent',
        id: items[row].itemId,
        version: 0,
        at: new Date(NOW).toISOString(),
        outcome: items[row].title,
        constraints: items[row].body,
        creatorAccountId: 'owner',
        assigneeAccountIds: [],
        base: { head: 'a'.repeat(64), receiptId: 'receipt' },
        status: 'active',
      },
    });
    // One open Lane started from the Item: what the Item page's Work section and `planning {id}` work list.
    await records.writeHostedRecord(s.ctx, {
      projectId: s.projectId,
      actor: 'owner',
      authorityEpoch: 1,
      expectedVersion: null,
      record: {
        kind: 'lane',
        id: randomUUID(),
        version: 0,
        at: new Date(NOW).toISOString(),
        intentId: items[row].itemId,
        actor: 'owner',
        base: { head: 'a'.repeat(64), receiptId: 'receipt' },
        head: 'b'.repeat(64),
        sourceVersion: 0,
        lifecycleVersion: 0,
        state: 'active',
        authorityEpoch: 1,
      },
    });
    await notes.postIntentLandingNote(s.ctx, s.projectId, {
      intentId: items[row].itemId,
      receiptId: randomUUID(),
      kind: 'landed',
      at: new Date(NOW).toISOString(),
      laneIds: [randomUUID()],
      commit: 'c'.repeat(64),
      sequence: 1,
      actor: 'owner',
    });
  }
  const hide = async row =>
    s.send({ ...items[row], operationId: randomUUID(), expectedVersion: 1, hidden: true });
  for (const row of SHELVED)
    await s.send({ ...items[row], operationId: randomUUID(), expectedVersion: 1, status: row });
  if (policy === 'hidden-item') await hide('lone');
  if (policy === 'hidden-initiative') await hide('initiative');
  if (policy === 'members-only') project.planVisibility = 'members';
  // The compact project headers follow the project row, as an ordinary project write keeps them.
  for (const [key, row] of s.tables.projectFinishReadRows ?? [])
    if (row.sourceId === s.projectId) s.tables.projectFinishReadRows.delete(key);
  for (const row of [finishReadProjection('hostedProjects', project), finishPlanProjectProjection(project)])
    s.tables.projectFinishReadRows?.set(`header-${row.kind}`, { _id: `header-${row.kind}`, ...row });
  // The owner's People day in this project: two Items closed and three planning comments.
  s.tables.personDays ??= new Map();
  const day = new Date(NOW).toISOString().slice(0, 10);
  s.tables.personDays.set('day', {
    _id: 'day',
    person: 'owner',
    day,
    value: JSON.stringify({
      p: {
        [s.projectId]: { l: 1, la: 0, n: 0, na: 0, v: 0, t: [NOW, NOW], r: {}, c: 2, m: 3 },
      },
    }),
  });
  return { s, items, p: port(s) };
}

const as = (s, viewer) => s.caller(viewer === 'signed-out' ? null : viewer);
/** A read's reply, or its structured refusal: either way, what the viewer sees. */
const seen = async read => {
  try {
    return { ok: await read() };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  }
};
const cli = (p, input) =>
  executeHostedPlanning(
    p,
    'viewer',
    'planning',
    hostedAgentCommandSchemas.planning.parse(input),
    undefined,
  ).then(reply => reply.result);

test('a public Item link preserves the source Item’s landing-note visibility', async t => {
  const { s, items, p } = await world(t, 'hidden-item');
  const survivor = items.loose;
  const hidden = items.lone;
  await s.send({
    ...survivor,
    operationId: randomUUID(),
    expectedVersion: 1,
    intentIds: [hidden.itemId],
  });
  for (const viewer of ['owner', 'stranger']) {
    as(s, viewer);
    const reply = await cli(p, { id: survivor.itemId, reconcile: false });
    assert.deepEqual(
      reply.comments
        .filter(comment => comment.system)
        .map(comment => comment.landing.intentId)
        .sort(),
      (viewer === 'owner' ? [survivor.itemId, hidden.itemId] : [survivor.itemId]).sort(),
      viewer,
    );
  }
});

for (const policy of POLICIES)
  test(`plan access matrix: ${policy}`, async t => {
    const { s, items, p } = await world(t, policy);
    const secret = SECRET[policy];
    const shown = ROWS.filter(row => !secret.includes(row));
    for (const viewer of VIEWERS) {
      const member = MEMBERS.has(viewer);
      const cell = surface => `${policy} / ${viewer} / ${surface}`;
      as(s, viewer);
      const surfaces = {
        'CLI planning list': await seen(() => cli(p, { status: 'all', limit: 50 })),
        'CLI planning counts': await seen(() => cli(p, { counts: true, status: 'all' })),
        'CLI planning window audit': await seen(() => cli(p, { history: { from: '2020-01-01' }, limit: 50 })),
        'web Plan read': await seen(() => planView.read._handler(s.ctx, { projectId: s.projectId })),
        'People profile': await seen(() => people.profile._handler(s.ctx, { handle: 'ada' })),
        'Item work (absent Item)': await seen(() =>
          itemWork.read._handler(s.ctx, { projectId: s.projectId, itemId: randomUUID() }),
        ),
        'web Plan settled page': await seen(() =>
          settled.page._handler(s.ctx, {
            projectId: s.projectId,
            status: 'closed',
            paginationOpts: { numItems: 50, cursor: null },
          }),
        ),
        // One row per page: a walk of the settled pages must not count rows it cannot see.
        'web Plan settled page (one row)': await seen(() =>
          settled.page._handler(s.ctx, {
            projectId: s.projectId,
            status: 'closed',
            paginationOpts: { numItems: 1, cursor: null },
          }),
        ),
        'web Plan counts': await seen(() => planCounts.read._handler(s.ctx, { projectId: s.projectId })),
        // Plan pages by Initiative, one row at a time: the Done page and the planning list.
        ...Object.fromEntries(
          await Promise.all(
            [
              ['initiative', items.initiative.itemId],
              ['absent Initiative', randomUUID()],
            ].flatMap(([name, initiativeId]) => [
              (async () => [
                `web Plan settled page by Initiative (${name})`,
                await seen(() =>
                  settled.page._handler(s.ctx, {
                    projectId: s.projectId,
                    status: 'closed',
                    initiativeId,
                    paginationOpts: { numItems: 1, cursor: null },
                  }),
                ),
              ])(),
              (async () => [
                `CLI counts by Initiative (${name})`,
                await seen(() => cli(p, { counts: true, initiativeId })),
              ])(),
              (async () => [
                `planning list by Initiative (${name})`,
                await seen(() =>
                  index.records._handler(s.ctx, {
                    projectId: s.projectId,
                    collection: 'planningItems',
                    planningFilter: { initiativeId },
                    paginationOpts: { numItems: 1, cursor: null },
                  }),
                ),
              ])(),
            ]),
          ),
        ),
        'Lanes list': await seen(() =>
          liveLanes.list._handler(s.ctx, { projectId: s.projectId, cursor: null, limit: 50 }),
        ),
        'Lanes list (absent Item)': await seen(() =>
          liveLanes.list._handler(s.ctx, {
            projectId: s.projectId,
            cursor: null,
            limit: 50,
            planningItemId: randomUUID(),
          }),
        ),
      };
      // The web Item page's own lookup of an Item the plan rows leave out (an Archived or Deleted one), and its list read.
      const lookup = itemId =>
        seen(() =>
          index.detail._handler(s.ctx, { projectId: s.projectId, collection: 'planningItems', id: itemId }),
        );
      const absentItem = randomUUID();
      surfaces['web Item page lookup (absent)'] = await lookup(absentItem);
      surfaces['web planning items list'] = await seen(() =>
        index.records._handler(s.ctx, {
          projectId: s.projectId,
          collection: 'planningItems',
          paginationOpts: { numItems: 50, cursor: null },
        }),
      );
      for (const row of ROWS) {
        surfaces[`web Item page lookup (${row})`] = await lookup(items[row].itemId);
        surfaces[`CLI planning id (${row}, comments and landing notes)`] = await seen(() =>
          cli(p, { id: items[row].itemId, reconcile: false }),
        );
        surfaces[`CLI planning item audit (${row})`] = await seen(() =>
          cli(p, { id: items[row].itemId, history: true }),
        );
        surfaces[`CLI planning short id (${row})`] = await seen(() =>
          cli(p, { id: items[row].itemId.slice(0, 8), reconcile: false }),
        );
        surfaces[`Item work (${row})`] = await seen(() =>
          itemWork.read._handler(s.ctx, { projectId: s.projectId, itemId: items[row].itemId }),
        );
        surfaces[`Lanes list (${row})`] = await seen(() =>
          liveLanes.list._handler(s.ctx, {
            projectId: s.projectId,
            cursor: null,
            limit: 50,
            planningItemId: items[row].itemId,
          }),
        );
        surfaces[`briefing (${row})`] = await seen(() =>
          briefings.brief._handler(s.ctx, {
            projectId: s.projectId,
            situation: 'start-intent',
            intentId: items[row].itemId,
          }),
        );
        // The reply echoes the query text, so only what it found counts.
        surfaces[`planning search (${row})`] = await seen(() =>
          cli(p, { search: token(row), status: 'all', limit: 10 }).then(
            ({ query: _echo, ...found }) => found,
          ),
        );
        // The search read itself, with its read statistics.
        surfaces[`planning search read (${row})`] = await seen(() =>
          search.search
            ._handler(s.ctx, {
              projectId: s.projectId,
              ...planningSearchTerms(token(row)),
              status: 'all',
              cursor: null,
              limit: 10,
            })
            .then(reply => {
              const { query: _echo, ...found } = JSON.parse(reply);
              return found;
            }),
        );
      }
      if (viewer === 'signed-out') {
        surfaces['public project page'] = await seen(() =>
          publicRead.projectPage._handler(s.ctx, { handle: 'ada', slug: 'atlas', now: NOW }),
        );
        surfaces['public profile page'] = await seen(() =>
          publicRead.profilePage._handler(s.ctx, { handle: 'ada', now: NOW }),
        );
      }
      for (const [surface, reply] of Object.entries(surfaces))
        if (!member) assert.deepEqual(leaks(reply, secret), [], cell(surface));
      // Reads that select no Item name no hidden Item by its id either (a planned Intent and its Lanes carry it).
      const unselected = Object.keys(surfaces).filter(
        surface => !/\(/.test(surface) || /one row/.test(surface),
      );
      if (!member)
        for (const surface of unselected)
          for (const row of secret)
            assert.ok(
              !JSON.stringify(surfaces[surface]).includes(items[row].itemId),
              cell(`${surface} names hidden ${row} by id`),
            );
      // A search's read statistics count only what this viewer may see.
      if (!member)
        for (const row of secret) {
          const found = surfaces[`planning search read (${row})`].ok;
          if (found) {
            assert.deepEqual(found.items, [], cell(`hidden ${row} search read`));
            assert.equal(found.matchedRecordsRead, 0, cell(`hidden ${row} search read statistics`));
            assert.equal(found.matchedRecordBytes, 0, cell(`hidden ${row} search read bytes`));
          }
        }
      // Selecting a hidden Initiative answers exactly as an absent one, page by page.
      if (!member && secret.includes('initiative'))
        for (const surface of [
          'web Plan settled page by Initiative',
          'planning list by Initiative',
          'CLI counts by Initiative',
        ])
          assert.deepEqual(
            surfaces[`${surface} (initiative)`],
            surfaces[`${surface} (absent Initiative)`],
            cell(`${surface} of a hidden Initiative`),
          );
      if (viewer !== 'signed-out') {
        const counts = surfaces['CLI counts by Initiative (initiative)'].ok;
        const shownInInitiative = member || !secret.includes('initiative') ? 1 : 0;
        assert.deepEqual(
          counts.counts,
          { proposed: 0, open: shownInInitiative, 'in-progress': 0, closed: shownInInitiative, abandoned: 0 },
          cell('Initiative count visibility'),
        );
        assert.equal(counts.total, shownInInitiative * 2, cell('Initiative total visibility'));
      }
      if (member)
        assert.ok(
          JSON.stringify(surfaces['web Plan settled page by Initiative (initiative)'].ok).includes(
            token('done'),
          ),
          cell('members page the Initiative'),
        );
      // A members-only plan: the settled page a visitor walks is empty and finished, whatever page size it asks for.
      if (!member && viewer !== 'signed-out' && policy === 'members-only')
        assert.deepEqual(
          surfaces['web Plan settled page (one row)'].ok,
          { page: [], isDone: true, continueCursor: '' },
          cell('members-only settled page'),
        );

      // The Item page's Work section: a hidden Item answers exactly as an absent one (no Lanes, total or state).
      const work = surface => JSON.parse(surfaces[surface].ok ?? 'null');
      for (const row of ROWS) {
        const reply = work(`Item work (${row})`);
        if (viewer === 'signed-out') assert.deepEqual(reply, { role: false }, cell(`Item work (${row})`));
        else if (member || shown.includes(row))
          assert.equal(reply.lanes.length, 1, cell(`Item work (${row}) lists its Lane`));
        else assert.deepEqual(reply, work('Item work (absent Item)'), cell(`hidden ${row} Item work`));
      }

      // The Lanes list filtered by an Item: a hidden Item's Lanes answer as an absent Item's.
      for (const row of ROWS) {
        const reply = surfaces[`Lanes list (${row})`];
        if (viewer === 'signed-out') continue;
        if (member || shown.includes(row))
          assert.equal(JSON.parse(reply.ok).page.length, 1, cell(`Lanes list (${row}) lists its Lane`));
        else
          assert.deepEqual(
            JSON.parse(reply.ok),
            JSON.parse(surfaces['Lanes list (absent Item)'].ok),
            cell(`hidden ${row} Lanes list`),
          );
      }
      // A briefing is member context (Lane names, recent messages): members read it; a viewer without a role is
      // refused the same way for every Intent, visible or hidden. The settled Plan page shows visible rows.
      if (viewer !== 'signed-out') {
        for (const row of ROWS.filter(row => row !== 'initiative')) {
          const brief = surfaces[`briefing (${row})`];
          if (member)
            assert.match(JSON.stringify(brief.ok ?? null), new RegExp(token(row)), cell(`briefing (${row})`));
          else
            assert.deepEqual(
              brief,
              surfaces['briefing (under)'],
              cell(`${row} briefing answers as every other`),
            );
        }
        if (!member)
          assert.match(
            surfaces['briefing (under)'].error ?? '',
            /PROJECT_UNAVAILABLE/,
            cell('briefing refused'),
          );
        const done = JSON.stringify(surfaces['web Plan settled page'].ok ?? null).includes(token('done'));
        assert.equal(done, member || shown.includes('done'), cell('web Plan settled page'));
      }
      // Plan counts: members read the stored totals; a viewer without a role counts only visible Items. No count
      // includes an Archived or Deleted Item.
      if (viewer !== 'signed-out') {
        const counts = surfaces['web Plan counts'].ok;
        assert.ok(counts, cell(`web Plan counts answers (${surfaces['web Plan counts'].error ?? ''})`));
        const total = Object.values(counts.issue).reduce((a, b) => a + b, 0);
        const issues = ROWS.filter(row => row !== 'initiative' && !SHELVED.includes(row));
        assert.equal(
          total,
          member ? issues.length : issues.filter(row => shown.includes(row)).length,
          cell('web Plan counts'),
        );
      }

      // A non-member's lookup of a hidden or members-only Item by id answers exactly as an absent id's; the list read
      // names no hidden row. Members read every Item by id.
      for (const row of ROWS) {
        const reply = surfaces[`web Item page lookup (${row})`];
        if (member) {
          assert.ok(leaks(reply.ok, [row]).length, cell(`web Item page lookup (${row}) for members`));
          continue;
        }
        if (!secret.includes(row)) {
          if (viewer === 'stranger')
            assert.ok(leaks(reply.ok, [row]).length, cell(`web Item page lookup (${row}) of a visible Item`));
          continue;
        }
        assert.equal(
          JSON.stringify(reply).split(items[row].itemId).join('ID'),
          JSON.stringify(surfaces['web Item page lookup (absent)']).split(absentItem).join('ID'),
          cell(`web Item page lookup (${row}) answers as absent`),
        );
      }
      if (!member)
        assert.deepEqual(
          leaks(surfaces['web planning items list'], secret),
          [],
          cell('web planning items list'),
        );

      if (member) {
        // Members keep exact replies: every row, its comment and its landing note.
        const list = surfaces['CLI planning list'].ok;
        assert.deepEqual(leaks(list, ROWS).sort(), [...ROWS].sort(), cell('CLI planning list'));
        for (const row of secret) {
          const item = surfaces[`CLI planning id (${row}, comments and landing notes)`].ok;
          assert.match(JSON.stringify(item.comments), new RegExp(`Comment on ${token(row)}`), cell(row));
          assert.ok(
            item.comments.some(comment => comment.system === true),
            cell(`${row} landing note`),
          );
        }
        continue;
      }
      // A viewer without a role: visible rows stay readable, hidden rows answer as absent everywhere.
      if (viewer === 'stranger') {
        const list = surfaces['CLI planning list'].ok;
        assert.deepEqual(leaks(list, shown).sort(), [...shown].sort(), cell('CLI planning list'));
        const counted = Object.values(surfaces['CLI planning counts'].ok.counts).reduce((a, b) => a + b, 0);
        assert.equal(counted, shown.length, cell('CLI planning counts'));
        for (const row of shown)
          assert.ok(
            surfaces[`CLI planning id (${row}, comments and landing notes)`].ok,
            cell(`visible ${row}`),
          );
        for (const row of secret) {
          assert.match(
            surfaces[`CLI planning id (${row}, comments and landing notes)`].error ?? '',
            /not found|NOT_FOUND/i,
            cell(`hidden ${row} answers as absent`),
          );
          assert.deepEqual(
            surfaces[`planning search (${row})`].ok?.items ?? [],
            [],
            cell(`hidden ${row} search`),
          );
        }
      }
      // People: a members-only plan shows no planning counts to a viewer without a role.
      const profile = surfaces['People profile'].ok ?? null;
      const contributions =
        viewer === 'signed-out'
          ? surfaces['public profile page'].ok?.contributions
          : JSON.parse(profile ?? 'null');
      if (contributions) {
        const projects = JSON.stringify(contributions.projects ?? contributions);
        if (policy === 'members-only')
          assert.doesNotMatch(projects, /"closed":[1-9]/, cell('People counts closed Items'));
      }
      if (viewer === 'signed-out') {
        const page = surfaces['public project page'].ok;
        const planShown = page.plan.shown !== false;
        assert.equal(planShown, policy !== 'members-only', cell('public page plan'));
        if (planShown)
          assert.equal(
            page.plan.left,
            shown.filter(row => !['initiative', 'done'].includes(row)).length,
            cell('public page Left count'),
          );
      }
    }
  });

// C1R-03: with the Lane-title opt-in on, a Lane started from a hidden Item (or a follow-up Intent of one) shows no
// title, and an Intent's constraints (the Item body copied at start) never reach a viewer without a role.

for (const [name, setting, intentId, titled] of [
  ['a visible Item', {}, id(4), true],
  ['a hidden Item', { hidden: [id(5)] }, id(5), false],
  ['a follow-up Intent of a hidden Item', { hidden: [id(5)] }, successorIntentId(id(5)), false],
  ['an Item under a hidden Initiative', { hidden: [id(1)] }, id(2), false],
  ['any Item of a members-only plan', { planVisibility: 'members' }, id(4), false],
  ['an Intent the read cannot tie to a visible Item', {}, id(77), false],
])
  test(`Lane-title opt-in: a Lane on ${name} ${titled ? 'keeps' : 'shows no'} title for visitors`, async () => {
    const s = fixture({ laneTitles: true, ...setting });
    const lane = s.tables.projectWorkRecords.get('laneRecord1');
    lane.value = JSON.stringify({ id: 'lane-1', name: 'Lane title tokLanex', intentId });
    s.caller(null);
    const page = await publicRead.projectPage._handler(s.ctx, { handle: 'ada', slug: 'atlas', now: NOW });
    assert.equal(JSON.stringify(page.lanes).includes('tokLanex'), titled, 'public project page');
    // The same Lane through a registered read, as a signed-in visitor without a role.
    s.caller('signed-in-stranger');
    s.tables.projectHostedRecordHeads.get('laneHead2').parent = intentId;
    const endpoint = registeredQuery({
      args: { projectId: v.string() },
      returns: v.string(),
      handler: async ctx => {
        await ctx.db.query('projectLiveLineLanes').take(1);
        return JSON.stringify({
          held: [{ laneId: 'lane-2', title: 'Lane title tokLanex' }],
          intents: [
            {
              kind: 'intent',
              id: intentId,
              outcome: 'Lane title tokLanex',
              constraints: 'Item body tokBodyx',
            },
          ],
        });
      },
    });
    const read = await endpoint._handler(s.ctx, { projectId: 'project' });
    assert.equal(read.includes('tokLanex'), titled, 'registered read');
    assert.doesNotMatch(read, /tokBodyx/, 'Intent constraints');
    s.caller('owner');
    assert.match(await endpoint._handler(s.ctx, { projectId: 'project' }), /tokLanex.*tokBodyx/s, 'members');
  });

// Lane-shaped rows on other reads name their Intent under other fields: the queue's `intentTitle` (an entry may have
// no Lane), a conflict notice's peer `goal`, History's `item: {id, title}` and `goal`. Each follows the same rule.
test('queue entries, conflict notices and History rows name no hidden Item to a visitor, even with the Lane-title opt-in', async () => {
  const s = fixture({ laneTitles: true, hidden: [id(5)] });
  const endpoint = registeredQuery({
    args: { projectId: v.string(), item: v.optional(v.string()) },
    returns: v.string(),
    handler: async (ctx, { item }) => {
      await ctx.db.query('projectLiveLineLanes').take(1);
      // History by Item, as the real read pages it: an Item with landings has rows; any other id has none, but
      // still a next sequence while landings in range remain unread.
      if (item)
        return JSON.stringify(
          item === id(5)
            ? { rows: [{ item: { id: item, title: 'filtered tokFilterx' }, laneId: null }], next: 7 }
            : { rows: [], next: 121 },
        );
      return JSON.stringify({
        entries: [{ laneId: null, intentId: id(5), intentTitle: 'Queue tokQueuex' }],
        conflicts: [{ with: 'lane-2', goal: 'Peer tokPeerx', files: ['a.ts'] }],
        rows: [
          { item: { id: id(5), title: 'Hidden tokHiddenx' }, goal: null, laneId: null },
          { item: null, goal: 'Follow-up tokGoalx', laneId: null },
          { item: { id: id(4), title: 'Visible tokVisiblex' }, goal: null, laneId: null },
        ],
      });
    },
  });
  s.caller('signed-in-stranger');
  const read = await endpoint._handler(s.ctx, { projectId: 'project' });
  for (const leak of ['tokQueuex', 'tokPeerx', 'tokHiddenx', 'tokGoalx'])
    assert.doesNotMatch(read, new RegExp(leak), leak);
  assert.match(read, /tokVisiblex/, 'a visible Item keeps its History link and title');
  const filtered = JSON.parse(await endpoint._handler(s.ctx, { projectId: 'project', item: id(5) }));
  const absent = JSON.parse(await endpoint._handler(s.ctx, { projectId: 'project', item: randomUUID() }));
  assert.deepEqual(
    filtered,
    absent,
    'History filtered by a hidden Item answers as an absent Item, sequence included',
  );
  s.caller('owner');
  assert.match(
    await endpoint._handler(s.ctx, { projectId: 'project' }),
    /tokQueuex.*tokPeerx.*tokHiddenx.*tokGoalx/s,
    'members',
  );
});

// A selection by Item or Intent runs as an absent one for a viewer who may not see it: the handler's own reply for an
// id no record has (cursors, totals and errors included), naming the id that was asked for.
for (const [key, extra] of [
  ['itemId', {}],
  ['planningItemId', {}],
  ['item', {}],
  ['intentId', {}],
  ['parentId', { collection: 'planningComments' }],
  ['id', { collection: 'planningItems' }],
])
  test(`a visitor's ${key} selection of hidden plan work answers exactly as an absent one`, async () => {
    const s = fixture({ hidden: [id(5)] });
    const work = new Map([
      [id(5), 3],
      [successorIntentId(id(5)), 2],
      [id(4), 3],
    ]);
    const asked = [];
    const endpoint = registeredQuery({
      args: { projectId: v.string(), request: v.string() },
      returns: v.string(),
      handler: async (_ctx, { request }) => {
        const selected = JSON.parse(request)[key];
        asked.push(selected);
        const lanes = work.get(selected) ?? 0;
        // Only an absent id answers with this shape: a finished, empty page with a cursor and a refusal note.
        return JSON.stringify(
          lanes
            ? {
                selected,
                page: [{ laneId: `lane-of-${selected}` }],
                total: lanes,
                isDone: false,
                continueCursor: 'next',
              }
            : {
                selected,
                page: [],
                total: 0,
                isDone: true,
                continueCursor: 'end',
                note: `No work for ${selected}.`,
              },
        );
      },
    });
    const read = async selection =>
      JSON.parse(
        await endpoint._handler(s.ctx, {
          projectId: 'project',
          request: JSON.stringify({ ...extra, [key]: selection }),
        }),
      );
    s.caller('signed-in-stranger');
    const visible = await read(id(4));
    assert.equal(visible.total, 3, 'a visible Item runs as asked');
    const ids = key === 'intentId' ? [id(5), successorIntentId(id(5))] : [id(5)];
    for (const hidden of ids) {
      const absentId = randomUUID();
      const absent = await read(absentId);
      assert.deepEqual(
        await read(hidden),
        JSON.parse(JSON.stringify(absent).split(absentId).join(hidden)),
        `hidden ${hidden === id(5) ? 'Item' : 'follow-up Intent'}`,
      );
    }
    assert.ok(!asked.includes(id(5)), 'the handler never runs on the hidden id');
    s.caller('owner');
    assert.equal((await read(id(5))).total, 3, 'members read the hidden Item as asked');
    s.caller(null);
    assert.equal((await read(id(4))).total, 3, 'signed out reads a visible Item');
  });

// Intent records: a planned Intent shares its Item's id, so an Intent row of a hidden Item is that Item. A visitor reads
// neither the row in a list nor the record by id; an Intent started without an Item keeps its (titleless) row.
test("an Intent record of a hidden Item is absent from a visitor's Intent list and detail", async () => {
  const s = fixture({ hidden: [id(5)] });
  const intent = intentId => JSON.stringify({ id: intentId, status: 'active', outcome: 'Goal tokIntentx' });
  const endpoint = registeredQuery({
    args: { projectId: v.string(), collection: v.string(), id: v.optional(v.string()) },
    returns: v.string(),
    handler: async (ctx, { id: selected }) => {
      await ctx.db.query('projectLiveLineLanes').take(1);
      if (selected)
        return JSON.stringify({ value: [id(4), id(5)].includes(selected) ? intent(selected) : null });
      return JSON.stringify({
        page: [id(5), id(4), id(77)].map((intentId, position) => ({
          id: intentId,
          position,
          value: intent(intentId),
        })),
        isDone: true,
        continueCursor: 'end',
      });
    },
  });
  const read = async args =>
    JSON.parse(await endpoint._handler(s.ctx, { projectId: 'project', collection: 'intents', ...args }));
  s.caller('signed-in-stranger');
  const list = await read({});
  assert.deepEqual(
    list.page.map(row => row.id),
    [id(4), id(77)],
    'the hidden Item row is gone; a visible Item and an Intent without an Item stay',
  );
  assert.ok(!JSON.stringify(list).includes(id(5)), 'no row names the hidden Item');
  assert.deepEqual(
    await read({ id: id(5) }),
    await read({ id: randomUUID() }),
    'detail of the hidden Item is absent',
  );
  assert.notEqual((await read({ id: id(4) })).value, null, "a visible Item's Intent stays readable");
  s.caller('owner');
  assert.equal((await read({})).page.length, 3, 'members read every Intent');
});

// Work records name a Lane's Intent as its parent (a planned Intent is its Item) and an Intent by its own id. The real
// record read answers a visitor's selection of a hidden Item as an absent one, live and from the journal, and no
// Lane record names the hidden Item.
for (const [name, setting, hiddenItem] of [
  ['a hidden Item', { hidden: [id(5)] }, id(5)],
  ['an Item of a members-only plan', { planVisibility: 'members' }, id(4)],
])
  test(`Work record reads by ${name} answer a visitor as absent, live and from the journal`, async () => {
    const s = fixture(setting);
    s.tables.projectHostedRecordHeads.get('laneHead2').parent = hiddenItem;
    for (const n of [1, 2]) {
      Object.assign(s.tables.projectHostedRecordHeads.get(`laneHead${n}`), {
        version: 1,
        recordId: `laneRow${n}`,
      });
      s.tables.projectHostedRecords.set(`laneRow${n}`, {
        _id: `laneRow${n}`,
        projectId: 'project',
        kind: 'lane',
        key: `lane-${n}`,
        version: 1,
        parent: s.tables.projectHostedRecordHeads.get(`laneHead${n}`).parent,
        status: 'active',
        digest: 'digest',
        bytes: 2,
        value: '{}',
      });
    }
    const live = async (request, spell = text => text) =>
      hostedRecordReads.read._handler(s.ctx, {
        projectId: 'project',
        request: spell(JSON.stringify(request)),
      });
    const fromJournal = async (request, spell = text => text) =>
      journalRead.read._handler(s.ctx, {
        projectId: 'project',
        query: 'projectHostedRecordReads:read',
        request: JSON.stringify({ request: spell(JSON.stringify(request)) }),
        segments: [],
      });
    const absent = randomUUID();
    const asAsked = reply => String(reply).split(absent).join(hiddenItem);
    s.caller('signed-in-stranger');
    for (const [path, reader] of [
      ['live', live],
      ['journal', fromJournal],
    ]) {
      // The reply, or the error a reply would carry: both must match an absent id's.
      const read = async request =>
        reader(request).then(
          reply => reply,
          error =>
            `error ${typeof error.data === 'string' ? error.data : JSON.stringify(error.data ?? error.message)}`,
        );
      assert.equal(
        await read({ collection: 'lanes', parentId: hiddenItem }),
        asAsked(await read({ collection: 'lanes', parentId: absent })),
        `${path}: Lanes by the hidden Item`,
      );
      assert.equal(
        await read({ collection: 'intents', id: hiddenItem }),
        asAsked(await read({ collection: 'intents', id: absent })),
        `${path}: the hidden Item's Intent record`,
      );
      // A request its reader accepts in any JSON spelling is checked the same way.
      const spelled = async request =>
        reader(request, text => ` \n${text}`).then(
          reply => reply,
          error =>
            `error ${typeof error.data === 'string' ? error.data : JSON.stringify(error.data ?? error.message)}`,
        );
      assert.equal(
        await spelled({ collection: 'lanes', parentId: hiddenItem }),
        asAsked(await spelled({ collection: 'lanes', parentId: absent })),
        `${path}: Lanes by the hidden Item, request led by whitespace`,
      );
      const all = await read({ collection: 'lanes' });
      assert.ok(!all.includes(hiddenItem), `${path}: no Lane record names the hidden Item`);
      assert.match(all, /lane-2/, `${path}: the Lane itself stays listed`);
      if (setting.hidden)
        assert.match(all, new RegExp(id(4)), `${path}: a visible Item's Lane keeps its parent`);
    }
    s.caller('owner');
    const own = await live({ collection: 'lanes', parentId: hiddenItem });
    assert.match(own, /lane-2/, "members list the hidden Item's Lanes");
    assert.match(await live({ collection: 'lanes' }), new RegExp(hiddenItem), 'members see the parent');
  });

// A journal history read hands a nested `request` only to the readers that read one; every other reader reads the flat
// fields, and so does the projection: a nested request naming another collection cannot turn the Intent rows' check off.
for (const [name, setting] of [
  ['a hidden Item', { hidden: [id(5)] }],
  ['a members-only plan', { planVisibility: 'members' }],
])
  test(`journal Work records: a nested request cannot lift ${name}'s Intent row for a visitor`, async () => {
    const s = fixture(setting);
    [5, 4].forEach((n, position) =>
      s.tables.projectWorkRecords.set(`intentRecord${n}`, {
        _id: `intentRecord${n}`,
        projectId: 'project',
        generationId: 'gen',
        collection: 'intents',
        key: id(n),
        parent: '',
        position,
        value: JSON.stringify({
          id: id(n),
          outcome: `Goal tok${n}x`,
          constraints: `Body tok${n}body`,
          status: 'active',
        }),
      }),
    );
    const read = async nested =>
      journalRead.read._handler(s.ctx, {
        projectId: 'project',
        query: 'projectWorkIndex:records',
        request: JSON.stringify({
          collection: 'intents',
          paginationOpts: { numItems: 10, cursor: null },
          ...(nested === undefined ? {} : { request: nested }),
        }),
        segments: [],
      });
    s.caller('signed-in-stranger');
    const flat = await read();
    for (const nested of [{ collection: 'checks' }, JSON.stringify({ collection: 'checks' })])
      assert.equal(await read(nested), flat, `a nested ${typeof nested} request changes nothing`);
    assert.doesNotMatch(flat, /tok5x|tok5body/, 'the hidden Item row');
    if (setting.planVisibility) assert.doesNotMatch(flat, /tok4x/, 'a members-only plan');
    s.caller('owner');
    assert.match(await read({ collection: 'checks' }), /tok5x/, 'members');
  });

// Opus review e2c5fa57 NIT-1: a journal history request that is not a JSON object (null, a bare string, an array, a
// number or not JSON at all) is the caller's error: BAD_ARGUMENT for every viewer, never a TypeError.
test('a journal request that is not a JSON object answers BAD_ARGUMENT, not a TypeError', async () => {
  const s = fixture({ hidden: [id(5)] });
  for (const viewer of ['signed-in-stranger', 'owner']) {
    s.caller(viewer);
    for (const request of ['null', '"text"', '[1]', '7', 'not json'])
      for (const query of ['projectWorkIndex:records', 'projectHostedRecordReads:read'])
        await assert.rejects(
          journalRead.read._handler(s.ctx, { projectId: 'project', query, request, segments: [] }),
          error => !(error instanceof TypeError) && error.code === 'BAD_ARGUMENT',
          `${viewer} ${query} ${request}`,
        );
  }
});

// A read takes its selection flat or inside `request`: each is checked on its own, and a request the boundary cannot
// read as its reader would is refused for a visitor.
test("a visitor's flat and nested selections are each checked, and an unreadable request is refused", async () => {
  const s = fixture({ hidden: [id(5)] });
  const endpoint = registeredQuery({
    args: { projectId: v.string(), itemId: v.optional(v.string()), request: v.optional(v.string()) },
    returns: v.string(),
    handler: async (ctx, { itemId, request }) => {
      await ctx.db.query('projectLiveLineLanes').take(1);
      const nested = request === undefined ? {} : JSON.parse(request);
      return JSON.stringify({
        flat: itemId === id(5) ? 'tokHiddenx' : null,
        nested: nested.itemId === id(5) ? 'tokHiddenx' : null,
      });
    },
  });
  const read = async args => endpoint._handler(s.ctx, { projectId: 'project', ...args });
  s.caller('signed-in-stranger');
  const both = await read({ itemId: id(5), request: JSON.stringify({ itemId: id(4) }) });
  assert.doesNotMatch(both, /tokHiddenx/, 'a flat selection beside a visible nested one');
  const nested = await read({ itemId: id(4), request: JSON.stringify({ itemId: id(5) }) });
  assert.doesNotMatch(nested, /tokHiddenx/, 'a nested selection beside a visible flat one');
  for (const request of ['not json', '[1]', 'null', '"text"'])
    await assert.rejects(
      read({ request }),
      error => /BAD_ARGUMENT/.test(JSON.stringify(error.data ?? error.message)),
      request,
    );
  s.caller('owner');
  assert.match(
    await read({ itemId: id(5), request: JSON.stringify({ itemId: id(5) }) }),
    /tokHiddenx.*tokHiddenx/,
    'members',
  );
});

// A list of Intents (coordination's related feed) selects each one: a hidden Item in the list answers like an absent id.
test('a visitor selecting a list of Intents learns nothing from a hidden Item in it', async () => {
  const s = fixture({ hidden: [id(5)] });
  const events = { [id(5)]: ['event tokHiddenx'], [id(4)]: ['event tokVisiblex'] };
  const endpoint = registeredQuery({
    args: { projectId: v.string(), intentIds: v.array(v.string()) },
    returns: v.string(),
    handler: async (ctx, { intentIds }) => {
      await ctx.db.query('projectLiveLineLanes').take(1);
      return JSON.stringify({
        page: intentIds.flatMap(intentId => (events[intentId] ?? []).map(text => ({ intentId: 'x', text }))),
        scope: { intentIds },
      });
    },
  });
  const read = async intentIds => endpoint._handler(s.ctx, { projectId: 'project', intentIds });
  const absent = randomUUID();
  s.caller('signed-in-stranger');
  assert.equal(
    await read([id(4), id(5)]),
    (await read([id(4), absent])).split(absent).join(id(5)),
    'the hidden Item answers as an absent one',
  );
  assert.match(await read([id(4), id(5)]), /tokVisiblex/, 'a visible Item in the list keeps its events');
  s.caller('owner');
  assert.match(await read([id(5)]), /tokHiddenx/, 'members');
});

// A plan page with nothing left to show is finished: on a members-only plan always, and on a public plan when hidden
// rows emptied it. Its cursor tells nothing about rows the visitor cannot see.
for (const [name, setting, items, finished] of [
  ['a members-only plan, an empty search page', { planVisibility: 'members' }, [], true],
  ['a members-only plan, a page of hidden rows', { planVisibility: 'members' }, [id(4)], true],
  ['a public plan, a page of hidden rows', { hidden: [id(5)] }, [id(5)], true],
  ['a public plan, an empty search page', {}, [], false],
  ['a public plan, a visible row', { hidden: [id(5)] }, [id(4)], false],
])
  test(`plan page cursors: ${name} ${finished ? 'finish' : 'keep their cursor'} for a visitor`, async () => {
    const s = fixture(setting);
    const endpoint = registeredQuery({
      args: { projectId: v.string() },
      returns: v.string(),
      handler: async ctx => {
        await ctx.db.query('projectPlanningRecords').take(1);
        return JSON.stringify({
          items: items.map(itemId => ({ id: itemId, kind: 'issue', status: 'open', title: 'Row tokRowx' })),
          nextCursor: 'more',
        });
      },
    });
    s.caller('signed-in-stranger');
    const reply = JSON.parse(await endpoint._handler(s.ctx, { projectId: 'project' }));
    assert.equal(reply.nextCursor, finished ? null : 'more');
    s.caller('owner');
    assert.equal(
      JSON.parse(await endpoint._handler(s.ctx, { projectId: 'project' })).nextCursor,
      'more',
      'members',
    );
  });

// The selection check before a handler adds no read for a member: the project document and the role it reads are the
// ones the handler reads, once per query.
test("a member's selection by Item adds no project or membership read to the query", async () => {
  const s = fixture();
  s.tables.projectReaders.set('r', { _id: 'r', projectId: 'project', reader: 'reader' });
  const endpoint = registeredQuery({
    args: { projectId: v.string(), itemId: v.optional(v.string()) },
    returns: v.string(),
    handler: async (ctx, { projectId }) => {
      const project = await authority.accessibleProject(ctx, projectId, 'reader');
      await roles.projectRole(ctx, project, 'reader');
      await ctx.db.query('projectLiveLineLanes').take(1);
      return JSON.stringify({ ok: true });
    },
  });
  const count = async args => {
    const reads = { project: 0, membership: 0 };
    const db = new Proxy(s.ctx.db, {
      get(target, key) {
        if (key === 'get')
          return async (...ids) => {
            if (ids.includes('project')) reads.project++;
            return target.get(...ids);
          };
        if (key === 'query')
          return table => {
            if (['projectContributors', 'projectReaders'].includes(table)) reads.membership++;
            return target.query(table);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    // A fresh query: its own auth object keys its caches.
    await endpoint._handler({ ...s.ctx, auth: { ...s.ctx.auth }, db }, { projectId: 'project', ...args });
    return reads;
  };
  s.caller('reader');
  assert.deepEqual(
    await count({ itemId: id(4) }),
    await count({}),
    'same reads with and without a selection',
  );
});

test('only the owner switches the plan to members-only and back, and the public page follows each switch', async () => {
  const s = fixture();
  s.tables.projectReaders.set('r', { _id: 'r', projectId: 'project', reader: 'reader' });
  const page = () => publicRead.projectPage._handler(s.ctx, { handle: 'ada', slug: 'atlas', now: NOW });
  for (const viewer of ['reader', 'signed-in-stranger']) {
    s.caller(viewer);
    const refused = await discovery.setSettings
      ._handler(s.ctx, { projectId: 'project', planVisibility: 'members' })
      .then(
        () => null,
        error => JSON.parse(error.message).code,
      );
    assert.equal(refused, 'PROJECT_UNAVAILABLE', viewer);
  }
  assert.equal((await page()).plan.shown, true, 'public by default');
  s.caller('owner');
  assert.deepEqual(
    await discovery.setSettings._handler(s.ctx, { projectId: 'project', planVisibility: 'members' }),
    {
      laneTitles: false,
      planVisibility: 'members',
      stars: 0,
    },
  );
  assert.deepEqual((await page()).plan, { shown: false });
  assert.equal(
    (await discovery.settings._handler(s.ctx, { projectId: 'project' })).planVisibility,
    'members',
  );
  // Changing the Lane-title opt-in alone keeps the plan setting.
  await discovery.setSettings._handler(s.ctx, { projectId: 'project', laneTitles: true });
  assert.equal(s.tables.hostedProjects.get('project').planVisibility, 'members');
  await discovery.setSettings._handler(s.ctx, { projectId: 'project', planVisibility: 'public' });
  assert.equal(s.tables.hostedProjects.get('project').planVisibility, undefined);
  assert.equal((await page()).plan.shown, true, 'reversible');
  // Item 65b6d701: each real change is one policy-history row with who, when and old/new; repeats record nothing.
  await discovery.setSettings._handler(s.ctx, { projectId: 'project', planVisibility: 'public' });
  const changes = [...s.tables.projectPolicyChanges.values()].sort((a, b) => a.at.localeCompare(b.at));
  assert.deepEqual(
    changes.map(row => [row.actor, row.planChange, row.rule]),
    [
      ['owner', { from: 'public', to: 'members' }, 'owner-person'],
      ['owner', { from: 'members', to: 'public' }, 'owner-person'],
    ],
    'plan visibility changes are recorded in the policy history',
  );
  assert.deepEqual(changes[0].previous, changes[0].policy, 'the policy itself is unchanged');
  // A retry of a change whose reply was lost reconciles: it is not applied again over a later change by another session.
  const op = { projectId: 'project', planVisibility: 'members', operationId: 'op-1' };
  await discovery.setSettings._handler(s.ctx, op);
  await discovery.setSettings._handler(s.ctx, { projectId: 'project', planVisibility: 'public' });
  assert.equal(
    (await discovery.setSettings._handler(s.ctx, op)).planVisibility,
    'public',
    'the retry reports the project as it is now',
  );
  assert.equal(s.tables.hostedProjects.get('project').planVisibility, undefined);
  assert.equal(s.tables.projectPolicyChanges.size, 4, 'the retry recorded nothing');
  await assert.rejects(
    discovery.setSettings._handler(s.ctx, { ...op, planVisibility: 'public' }),
    error => JSON.parse(error.message).code === 'WORK_OPERATION_CHANGED',
  );
});
