// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { hostedFreshness } from '../dist/hosted-freshness.js';
import { moduleUrl } from './convex-module.mjs';
import { state } from './hosted-fixture.mjs';
const { projectFreshness } = await import(moduleUrl('../convex/projectFreshness.ts'));
const { GenerationFreshness } = await import(moduleUrl('../web/src/ui/generation-freshness.ts'));
const { StatusPill } = await import(moduleUrl('../web/src/ui/primitives.tsx'));
const { Rail } = await import(moduleUrl('../web/src/ui/Rail.tsx'));
const { cockpitLanes } = await import(moduleUrl('../web/src/cockpit/model.ts'));
const base = () => ({
  syncedAt: Date.parse('2026-10-16T09:00:00Z'),
  sourceRevision: 12,
  mainHead: 'a',
  machine: { name: 'Mac Studio', reportedAt: Date.parse('2026-10-16T12:00:00Z'), mainHead: 'a' },
  ownerReport: { revision: 12, reportedAt: Date.parse('2026-10-16T12:00:00Z') },
  push: null,
});

test('current stays current regardless of age; a newer Work revision or reported main marks behind', () => {
  assert.deepEqual(hostedFreshness(base()), { behind: false, catchingUp: false });
  assert.equal(hostedFreshness({ ...base(), syncedAt: 1 }).behind, false);
  assert.equal(hostedFreshness({ ...base(), ownerReport: { revision: 13, reportedAt: 2 } }).behind, true);
  const changed = base();
  changed.machine.mainHead = 'b';
  assert.equal(hostedFreshness(changed).behind, true);
  changed.machine.reportedAt = 1;
  assert.equal(hostedFreshness(changed).behind, false, 'an old machine report cannot override a newer sync');
});

test('an unfinished push catches up; publication clears it; unknown machines do not imply behind', () => {
  assert.deepEqual(hostedFreshness({ ...base(), push: { startedAt: 1, pending: 'Uploading' } }), {
    behind: true,
    catchingUp: true,
  });
  assert.deepEqual(hostedFreshness(base()), { behind: false, catchingUp: false });
  assert.deepEqual(hostedFreshness({ ...base(), machine: null, ownerReport: null }), {
    behind: false,
    catchingUp: false,
  });
  assert.equal(hostedFreshness(null).behind, false);
});

test('freshness reads the newest indexed B5 revision and unfinished source return without Work scans', async () => {
  const s = state([]);
  const project = { _id: 'project', key: 'owner' };
  const backup = { _id: 'backup', preview: { channels: [{ name: 'main', head: 'a' }] } };
  const generation = {
    _id: 'generation',
    initialRevision: 12,
    backupId: 'backup',
    returnAt: '2026-10-16T09:00:00Z',
  };
  s.tables.ownerAcceptanceMachines.set('machine', {
    projectId: 'project',
    ownerId: 'owner',
    name: 'Mac',
    lastSeen: 20,
    mainHead: 'a',
  });
  s.tables.projectWorkRecords.set('new', {
    generationId: 'generation',
    collection: 'ownerSyncOperations',
    position: 14,
    _creationTime: 21,
  });
  s.tables.projectWorkRecords.set('old', {
    generationId: 'generation',
    collection: 'ownerSyncOperations',
    position: 13,
    _creationTime: 22,
  });
  s.tables.projectWorkRecords.set('other', {
    generationId: 'other',
    collection: 'ownerSyncOperations',
    position: 100,
  });
  s.tables.projectWorkGenerations.set('stage', {
    projectId: 'project',
    backupId: 'next',
    initialRevision: 14,
    returnOperationId: 'push',
    returnAt: '2026-10-16T10:00:00Z',
    _creationTime: 23,
  });
  const result = await projectFreshness(s.ctx, project, generation, backup);
  assert.equal(result.ownerReport.revision, 14);
  assert.equal(result.ownerReport.reportedAt, 21);
  assert.equal(result.machine.name, 'Mac');
  assert.equal(result.push.pending, 'Publishing source and Work');
  assert.equal(hostedFreshness(result).catchingUp, true);
  s.tables.projectWorkGenerations.clear();
  s.tables.projectBackups.set('upload', {
    _id: 'upload',
    projectId: 'project',
    preview: { revision: 15 },
    status: 'uploading',
    _creationTime: 24,
  });
  assert.equal(
    (await projectFreshness(s.ctx, project, generation, backup)).push.pending,
    'Uploading source and Work',
  );
  s.tables.projectBackups.clear();
  assert.equal(
    (await projectFreshness(s.ctx, project, { ...generation, initialRevision: 14 }, backup)).push,
    null,
  );
});

test('behind status is a static muted glyph and word with an as-of time; local/current rendering is unchanged', () => {
  const value = { ...base(), push: { startedAt: 1, pending: 'Publishing' } };
  const render = freshness =>
    renderToStaticMarkup(
      h(
        GenerationFreshness.Provider,
        { value: freshness },
        h(StatusPill, { tone: 'running' }, 'Checking'),
        h(Rail, { lane: { tone: 'running', checkpoints: 27, runStatus: 'running' } }),
      ),
    );
  const stale = render(value);
  assert.match(stale, /fx-tone-stale/);
  assert.match(stale, /Checking/);
  assert.match(stale, /as of 2026-10-16T09:00:00.000Z/);
  assert.doesNotMatch(stale, /fx-tone-running|fx-rail-run/);
  assert.match(render(null), /fx-tone-running/);
  assert.match(render(base()), /fx-rail-run/);
});

test('completed and abandoned lifecycle metadata win over a stale running check', () => {
  for (const state of ['completed', 'abandoned']) {
    const lane = cockpitLanes({
      intents: [{ id: 'i', outcome: 'Long title'.repeat(15) }],
      lanes: [{ id: 'l', intentId: 'i', name: 'Lane', base: 'a', head: 'b', state, assignment: '' }],
      views: [
        {
          id: 'v',
          intentId: 'i',
          base: 'a',
          head: 'b',
          status: 'clean',
          at: '2026-10-16',
          inputs: [{ laneId: 'l', head: 'b' }],
        },
      ],
      runs: [{ id: 'r', viewId: 'v', status: 'running' }],
    })[0];
    assert.equal(lane.open, false);
    assert.equal(lane.label, state === 'abandoned' ? 'Abandoned' : 'Done');
    assert.equal(lane.tone, 'plain');
  }
});

test('source-return receipt supplies the recorded sync time and includes the return revision itself', async () => {
  const s = state([]);
  const project = { _id: 'project', key: 'owner' };
  const generation = { _id: 'generation', initialRevision: 12, backupId: 'backup' };
  const backup = { _id: 'backup', preview: { channels: [] } };
  s.tables.projectWorkEvents.set('receipt', {
    projectId: 'project',
    revision: 13,
    command: JSON.stringify({ action: 'source-return' }),
    at: '2026-10-16T09:00:00Z',
  });
  s.tables.projectWorkRecords.set('report', {
    generationId: 'generation',
    collection: 'ownerSyncOperations',
    position: 13,
    _creationTime: 20,
  });
  const result = await projectFreshness(s.ctx, project, generation, backup);
  assert.equal(result.syncedAt, Date.parse('2026-10-16T09:00:00Z'));
  assert.equal(result.sourceRevision, 13);
  assert.equal(hostedFreshness(result).behind, false);
  s.tables.projectBackups.set('upload', {
    _id: 'upload',
    projectId: 'project',
    preview: { revision: 12 },
    status: 'uploading',
    _creationTime: 24,
  });
  assert.equal(
    hostedFreshness(await projectFreshness(s.ctx, project, generation, backup)).catchingUp,
    true,
    'an explicit same-revision upload is still unfinished',
  );
});
