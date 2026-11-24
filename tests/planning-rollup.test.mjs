// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import assert from 'node:assert/strict';
import test from 'node:test';
import { rollupContribution, rollupDecision } from '../dist/planning-rollup.js';
import { rollupMembershipChanges } from '../dist/planning-rollup-membership.js';
import { purgedIndexValue } from '../dist/work-planning-purge.js';
import { resolvePlanningPut } from '../dist/work-planning-put.js';
import { planningItemSchema } from '../dist/work-planning-types.js';

const empty = { total: 0, unsettled: 0, progress: 0, started: 0, done: 0 };
const pin = { by: '@mara/bright-otter', at: '2026-11-24T10:00:00Z' };
const item = (changes = {}) => ({
  status: 'open',
  kind: 'issue',
  unchecked: 0,
  checked: 0,
  work: 'none',
  ...changes,
});
const initiative = (changes = {}) => item({ kind: 'initiative', ...changes });
const decide = (subject, scope = empty, enabled = true) => rollupDecision(subject, scope, enabled);
const totals = (...parts) => {
  const tally = { ...empty };
  for (const part of parts) for (const key of Object.keys(tally)) tally[key] += part[key];
  return tally;
};

test('a start moves Planned ancestors, even through an overridden intermediate Item', () => {
  assert.equal(decide(item({ work: 'active' })).status, 'in-progress');
  const child = rollupContribution('in-progress');
  assert.equal(decide(item(), child).status, 'in-progress');
  const pinned = item({ status: 'closed', statusPin: pin });
  assert.equal(decide(pinned, child), null);
  assert.equal(decide(item(), rollupContribution(pinned.status, child)).status, 'in-progress');
  assert.equal(decide(initiative(), child).status, 'in-progress');
});

test('an unstarted Initiative with some completed work is In progress even when no Lane is running', () => {
  const scope = totals(rollupContribution('closed'), rollupContribution('open'));
  assert.equal(decide(initiative(), scope).status, 'in-progress');
  assert.equal(decide(item(), scope).status, 'in-progress');
});

test('the final linked-work completion closes ancestors and the Initiative, with distinct rule reasons', () => {
  const leaf = decide(item({ status: 'in-progress', work: 'completed' }));
  assert.equal(leaf.status, 'closed');
  assert.equal(leaf.reason, 'Done: linked work finished');
  const parent = decide(item({ status: 'in-progress' }), rollupContribution(leaf.status));
  assert.equal(parent.status, 'closed');
  assert.equal(parent.reason, 'Done: last child settled');
  const group = decide(
    initiative({ status: 'in-progress' }),
    totals(rollupContribution(leaf.status), rollupContribution(parent.status)),
  );
  assert.equal(group.status, 'closed');
  assert.equal(group.reason, 'Done: last Item settled');
});

test('the same unfinished checklist gate holds parents and Initiatives open after the last child settles', () => {
  const unchecked = 1;
  const doneChild = rollupContribution('closed');
  assert.equal(decide(item({ status: 'in-progress', unchecked }), doneChild), null);
  assert.equal(decide(initiative({ status: 'in-progress', unchecked }), doneChild), null);
  assert.equal(decide(item({ work: 'active', status: 'in-progress' }), doneChild), null);
  assert.equal(decide(item()), null, 'an empty unstarted leaf is not considered done');
});

test('an Initiative with all Items abandoned becomes Abandoned, not Done, and an empty Initiative stays open', () => {
  const allAbandoned = totals(rollupContribution('abandoned'), rollupContribution('abandoned'));
  assert.equal(decide(initiative(), allAbandoned).status, 'abandoned');
  assert.equal(decide(initiative(), allAbandoned).reason, 'Abandoned: all Items abandoned');
  assert.equal(decide(initiative({ unchecked: 1 }), allAbandoned), null);
  assert.equal(decide(initiative(), totals(allAbandoned, rollupContribution('closed'))).status, 'closed');
  assert.equal(decide(initiative(), rollupContribution('deleted')), null);
});

test('an open child reopens a settled parent to Planned before work has started or In progress otherwise', () => {
  const open = rollupContribution('open');
  assert.equal(decide(item({ status: 'closed' }), open).status, 'open');
  const started = totals(open, rollupContribution('closed'));
  assert.equal(decide(initiative({ status: 'abandoned' }), started).status, 'in-progress');
  assert.equal(decide(initiative({ status: 'proposed' }), started), null);
  assert.equal(decide(initiative({ status: 'closed', statusPin: pin }), started), null);
});

test('turning roll-up off leaves parents and Initiatives alone while own Lane start and finish still work', () => {
  assert.equal(decide(item(), rollupContribution('in-progress'), false), null);
  assert.equal(decide(initiative(), rollupContribution('closed'), false), null);
  assert.equal(decide(item({ work: 'active' }), empty, false).status, 'in-progress');
  assert.equal(decide(item({ status: 'in-progress', work: 'completed' }), empty, false).status, 'closed');
  assert.equal(decide(item({ statusPin: pin, work: 'active' }), empty, false), null);
});

test('moving an active member between parents and Initiatives takes it out of both old scopes and adds it once to both new ones', () => {
  const before = item({ status: 'in-progress', parentId: 'old-parent', initiativeId: 'old-group' });
  const after = { ...before, parentId: 'new-parent', initiativeId: 'new-group' };
  const changes = rollupMembershipChanges(before, after);
  assert.deepEqual([...changes.keys()].sort(), [
    'initiative:new-group',
    'initiative:old-group',
    'parent:new-parent',
    'parent:old-parent',
  ]);
  assert.equal(totals(rollupContribution(before.status), changes.get('parent:old-parent')).total, 0);
  assert.equal(decide(item(), changes.get('parent:new-parent')).status, 'in-progress');
  assert.equal(decide(initiative(), changes.get('initiative:new-group')).status, 'in-progress');
  assert.equal(rollupMembershipChanges(before, before).size, 0, 'a replay does not dirty any scope');
});

test('a retained pin survives an unrelated edit and is erased when the record is purged', () => {
  const id = 'fec7baf6-9cc3-4329-a057-1a3edb8462e5';
  const version = planningItemSchema.parse({
    id,
    operationId: id,
    request: 'a'.repeat(64),
    kind: 'issue',
    title: 'Plan work',
    status: 'closed',
    previousVersion: 0,
    version: 1,
    at: pin.at,
    provenance: 'user-declared-local',
    statusPin: pin,
  });
  const put = resolvePlanningPut(
    { action: 'put-planning-item', itemId: id, title: 'Plan more work' },
    version,
  );
  assert.deepEqual(put.model.statusPin, pin);
  assert.equal(purgedIndexValue('planningVersions', version, id).statusPin, undefined);
});
