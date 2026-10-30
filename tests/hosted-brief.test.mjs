import { commitValidatedCheckpoint } from './project-exchange-fixture.mjs';
import test from 'node:test';
import { validate } from 'convex-helpers/validators';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { state } from './hosted-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import {
  HOSTED_WORK_INDEX_FORMAT,
  laneSummary,
  viewSummary,
  runSummary,
} from '../dist/work-hosted-summary.js';
import { indexedRecord } from '../dist/work-hosted-index.js';
import { records, states, ids, head, guidance } from './agent-brief-fixture.mjs';
import { fixture, checkpoint, modules as exchangeModules } from './project-exchange-fixture.mjs';
const briefs = await import(moduleUrl('../convex/projectBriefings.ts'));
const settings = await import(moduleUrl('../convex/agentGuidance.ts'));
const paths = await import(moduleUrl('../convex/projectBriefingSources.ts'));
const actions = await import(moduleUrl('../convex/projectBriefingActions.ts'));
const indexActions = await import(moduleUrl('../convex/projectWorkIndexActions.ts'));
const code = expected => error => error.data?.code === expected;
async function setup() {
  const s = state([]),
    projectId = 'project',
    backupId = 'backup',
    generationId = 'generation';
  s.tables.hostedProjects.set(projectId, {
    _id: projectId,
    _creationTime: 1,
    owner: 'owner',
    key: randomUUID(),
    name: 'Synthetic brief',
    currentBackup: backupId,
    revision: 1,
    agentGuidance: guidance.project,
    work: { generationId, backupId, initialRevision: 1, revision: 1, operationId: randomUUID() },
  });
  s.tables.projectBackups.set(backupId, { _id: backupId, projectId, status: 'stored' });
  s.tables.projectWorkGenerations.set(generationId, {
    _id: generationId,
    projectId,
    backupId,
    revision: 1,
    initialRevision: 1,
    format: HOSTED_WORK_INDEX_FORMAT,
    status: 'ready',
    nextBatch: 0,
    metadata: '{}',
  });
  let count = 0;
  for (const [collection, values] of Object.entries(records).filter(
    ([name]) => !['events', 'claims'].includes(name),
  )) {
    for (const [position, value] of values.entries()) {
      const key = value.id ?? value.name;
      const parent = value.intentId ?? value.viewId ?? '';
      const summarize = { lanes: laneSummary, views: viewSummary, runs: runSummary }[collection];
      for (const row of indexedRecord(
        collection,
        key,
        parent,
        position,
        value,
        summarize?.(value) ?? value,
      )) {
        const id = `record-${count++}`;
        s.tables.projectWorkRecords.set(id, {
          _id: id,
          _creationTime: count,
          projectId,
          generationId,
          ...row,
        });
      }
    }
  }
  for (const event of records.events) {
    const command =
      event.kind === 'message'
        ? {
            kind: 'message',
            text: event.text,
            context: { intentId: event.intentId, laneId: event.laneId, paths: event.paths },
          }
        : {
            kind: 'handoff',
            to: 'owner',
            summary: event.text,
            head,
            intentId: event.intentId,
            laneId: event.laneId,
          };
    s.tables.projectCoordinationEvents.set(event.id, {
      _id: event.id,
      _creationTime: count++,
      projectId,
      operationId: event.id,
      actor: event.actor,
      at: 1,
      command,
      kind: event.kind,
      intentId: event.intentId,
      laneId: event.laneId,
    });
  }
  s.tables.projectCoordinationClaims.set('claim', {
    _id: 'claim',
    projectId,
    claimId: 'claim',
    actor: 'worker-2',
    paths: ['src/'],
    intentId: ids.intent,
    expiresAt: Date.now() + 60000,
  });
  for (const [stateHead, data] of states)
    await paths.put._handler(s.ctx, {
      projectId,
      backupId,
      actor: 'owner',
      head: stateHead,
      part: 0,
      value: JSON.stringify({ ...data, parts: 1 }),
    });
  await settings.set._handler(s.ctx, {
    operationId: randomUUID(),
    scope: 'personal',
    agentGuidance: guidance.personal,
  });
  return { ...s, projectId };
}
test('authorized hosted query returns current structured context, paths, instructions, summaries and coordination', async () => {
  const s = await setup();
  const result = await briefs.brief._handler(s.ctx, {
    projectId: s.projectId,
    situation: 'resolve-conflict',
    laneId: ids.lane,
    agent: 'codex',
  });
  assert.equal(result.context.lane.head, head);
  assert.deepEqual(result.context.paths, ['.cursor/rules/types.mdc', 'src/check.ts']);
  assert.deepEqual(result.context.conflictPaths, ['src/check.ts']);
  assert.ok(result.context.main.changedPaths.includes('src/accepted.ts'));
  assert.deepEqual(result.context.guidance, guidance);
  assert.equal(result.context.claims[0].actor, 'worker-2');
  assert.equal(result.context.messages.length, 2);
  assert.match(result.full, /not ok 3 - evidence follows the exact View/);
  assert.match(result.full, /AGENTS.md/);
  assert.ok(result.copyText.length <= 1200);
  const message = await briefs.brief._handler(s.ctx, {
    projectId: s.projectId,
    situation: 'answer-message',
    messageId: ids.message,
  });
  assert.equal(message.context.messageId, ids.message);
  const handoff = await briefs.brief._handler(s.ctx, {
    projectId: s.projectId,
    situation: 'take-handoff',
    messageId: ids.handoff,
  });
  assert.equal(handoff.context.laneId, ids.lane);
  assert.equal(s.reads(), 0, 'warm briefing queries never fetch source blobs');
});
test('briefing authorization is checked on every read: non-member and source-only reader cannot access a Lane', async () => {
  const s = await setup();
  const input = { projectId: s.projectId, situation: 'continue-lane', laneId: ids.lane };
  s.caller('stranger');
  await assert.rejects(briefs.brief._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
  s.tables.importReaders.set('reader', { importId: 'private-import', reader: 'reader' });
  s.tables.zoneReaders.set('zone-reader', { zoneId: 'zone', reader: 'reader' });
  s.caller('reader');
  await assert.rejects(briefs.brief._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
  s.tables.projectContributors.set('grant', { projectId: s.projectId, contributor: 'reader' });
  assert.equal((await briefs.brief._handler(s.ctx, input)).context.laneId, ids.lane);
  s.tables.projectContributors.delete('grant');
  await assert.rejects(briefs.brief._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
  s.caller(undefined);
  await assert.rejects(briefs.brief._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
});
test('hosted selected records stay project-scoped and missing path projection is explicitly unknown', async () => {
  const s = await setup();
  await assert.rejects(
    briefs.brief._handler(s.ctx, {
      projectId: s.projectId,
      situation: 'continue-lane',
      laneId: randomUUID(),
    }),
    code('NOT_FOUND'),
  );
  await assert.rejects(
    briefs.brief._handler(s.ctx, {
      projectId: s.projectId,
      situation: 'answer-message',
      messageId: randomUUID(),
    }),
    code('NOT_FOUND'),
  );
  s.tables.projectBriefingSources.clear();
  const result = await briefs.brief._handler(s.ctx, {
    projectId: s.projectId,
    situation: 'continue-lane',
    laneId: ids.lane,
  });
  assert.equal(result.context.main.merged, null);
  assert.deepEqual(result.context.instructionFiles, []);
  assert.ok(result.context.coverage.some(line => /Source paths unavailable/.test(line)));
});
test('hosted guidance preserves original retries, checks current write authority, isolates personal values and enforces approved size', async () => {
  const s = await setup(),
    first = {
      operationId: randomUUID(),
      scope: 'project',
      projectId: s.projectId,
      agentGuidance: '  exact\ntext  ',
    };
  assert.equal((await settings.set._handler(s.ctx, first)).agentGuidance, first.agentGuidance);
  await settings.set._handler(s.ctx, { ...first, operationId: randomUUID(), agentGuidance: 'new' });
  assert.equal((await settings.set._handler(s.ctx, first)).agentGuidance, first.agentGuidance);
  assert.equal((await settings.read._handler(s.ctx, { projectId: s.projectId })).project, 'new');
  await assert.rejects(
    settings.set._handler(s.ctx, { ...first, agentGuidance: 'changed' }),
    code('WORK_OPERATION_CHANGED'),
  );
  await assert.rejects(
    settings.set._handler(s.ctx, { ...first, operationId: randomUUID(), agentGuidance: 'x'.repeat(4001) }),
    code('BAD_ARGUMENT'),
  );
  s.caller('contributor');
  s.tables.projectContributors.set('grant', { projectId: s.projectId, contributor: 'contributor' });
  await assert.rejects(settings.set._handler(s.ctx, first), code('PROJECT_UNAVAILABLE'));
  assert.equal((await settings.read._handler(s.ctx, { projectId: s.projectId })).personal, '');
  await settings.set._handler(s.ctx, {
    operationId: randomUUID(),
    scope: 'personal',
    agentGuidance: 'My instructions',
  });
  assert.equal((await settings.read._handler(s.ctx, { projectId: s.projectId })).personal, 'My instructions');
  s.caller('owner');
  assert.equal((await settings.read._handler(s.ctx, {})).personal, guidance.personal);
});
test('path preparation reads immutable State manifests, is idempotent, and rechecks authority', async t => {
  const s = fixture(),
    source = await checkpoint(t, s),
    { input, store } = source;
  const original = s.ctx.runQuery;
  s.ctx.runAction =
    s.ctx.runQuery =
    s.ctx.runMutation =
      (ref, args) => {
        const [name, method] = getFunctionName(ref).split(':');
        if (name === 'projectBriefingSources') return paths[method]._handler(s.ctx, args);
        return original(ref, args);
      };
  const backupId = await commitValidatedCheckpoint(s, source);
  await exchangeModules.projectWorkActions.initialize._handler(s.ctx, {
    projectId: 'project',
    backupId,
    operationId: randomUUID(),
  });
  const first = await actions.prepare._handler(s.ctx, { projectId: 'project' });
  assert.equal(first.available, true);
  assert.ok(first.states >= 1);
  const count = s.tables.projectBriefingSources.size;
  assert.deepEqual(await actions.prepare._handler(s.ctx, { projectId: 'project' }), first);
  assert.equal(s.tables.projectBriefingSources.size, count);
  const all = [...s.tables.projectBriefingSources.values()].map(row => row.value).join('');
  assert.ok(all.includes('a.ts'));
  assert.ok(!all.includes('export const a'), 'file contents never enter path projection');
  await indexActions.ensure._handler(s.ctx, { rebuild: true, projectId: 'project' });
  s.caller('stranger');
  await assert.rejects(
    actions.prepare._handler(s.ctx, { projectId: 'project' }),
    code('PROJECT_UNAVAILABLE'),
  );
  assert.ok(store.native);
});

test('hosted ancestry reads parent headers without loading ancestor file payloads', async () => {
  const s = await setup(),
    ancestor = 'd'.repeat(64),
    mainRow = [...s.tables.projectBriefingSources.values()].find(
      row => row.head === 'c'.repeat(64) && row.part === 0,
    );
  mainRow.value = JSON.stringify({ ...JSON.parse(mainRow.value), parents: [ancestor] });
  s.tables.projectBriefingSources.set('ancestor-header', {
    _id: 'ancestor-header',
    projectId: s.projectId,
    backupId: 'backup',
    head: ancestor,
    part: -1,
    value: JSON.stringify({ parents: [head], parts: 1 }),
  });
  s.tables.projectBriefingSources.set('ancestor-files', {
    _id: 'ancestor-files',
    projectId: s.projectId,
    backupId: 'backup',
    head: ancestor,
    part: 0,
    value: 'Must never read this ancestor file payload',
  });
  const result = await briefs.brief._handler(s.ctx, {
    projectId: s.projectId,
    situation: 'continue-lane',
    laneId: ids.lane,
  });
  assert.equal(result.context.main.merged, true);
  assert.match(result.copyText, /FORGE_PROJECT_ID='project'/);
  assert.match(result.full, /FORGE_AUTH_TOKEN/);
});

test('owner-assigned maintainers can edit project guidance; ordinary members cannot and retries preserve newer assignments', async () => {
  const s = await setup();
  s.tables.projectContributors.set('maintainer-grant', {
    _id: 'maintainer-grant',
    _creationTime: 1,
    projectId: s.projectId,
    contributor: 'maintainer',
  });
  const role = { operationId: randomUUID(), projectId: s.projectId, actor: 'maintainer', maintainer: true };
  await settings.setMaintainer._handler(s.ctx, role);
  s.caller('maintainer');
  assert.equal((await settings.read._handler(s.ctx, { projectId: s.projectId })).projectEditable, true);
  const change = {
    operationId: randomUUID(),
    projectId: s.projectId,
    scope: 'project',
    agentGuidance: 'Maintainer guidance',
  };
  await settings.set._handler(s.ctx, change);
  assert.equal(
    (await settings.read._handler(s.ctx, { projectId: s.projectId })).project,
    'Maintainer guidance',
  );
  await assert.rejects(
    settings.setMaintainer._handler(s.ctx, { ...role, operationId: randomUUID() }),
    code('PROJECT_UNAVAILABLE'),
  );
  s.caller('owner');
  await settings.setMaintainer._handler(s.ctx, { ...role, operationId: randomUUID(), maintainer: false });
  await settings.setMaintainer._handler(s.ctx, role);
  assert.equal(
    s.tables.projectContributors.get('maintainer-grant').agentGuidanceMaintainer,
    false,
    'original retry must not rewind a newer assignment',
  );
  await assert.rejects(
    settings.setMaintainer._handler(s.ctx, { ...role, maintainer: false }),
    code('WORK_OPERATION_CHANGED'),
  );
  s.caller('maintainer');
  assert.equal((await settings.read._handler(s.ctx, { projectId: s.projectId })).projectEditable, false);
  await assert.rejects(
    settings.set._handler(s.ctx, change),
    code('PROJECT_UNAVAILABLE'),
    'a previous successful operation grants no current access',
  );
});

test('same-account sessions remain visible in briefings and composed View input pins remain explicit', async () => {
  const s = await setup(),
    sessionId = randomUUID();
  s.tables.projectCoordinationClaims.set('same-account', {
    _id: 'same-account',
    projectId: s.projectId,
    claimId: 'same-account',
    actor: 'owner',
    sessionId,
    paths: ['src/check.ts'],
    laneId: ids.lane,
    expiresAt: Date.now() + 60000,
  });
  const result = await briefs.brief._handler(s.ctx, {
    projectId: s.projectId,
    situation: 'resolve-conflict',
    viewId: ids.view,
  });
  assert.equal(result.context.claims.find(c => c.id === 'same-account').sessionId, sessionId);
  assert.deepEqual(result.context.view.inputs, records.views[0].inputs);
  assert.match(result.full, /composed Candidate conflict.*resolution workflow/);
});

test('briefing and guidance registrations enforce current CLI credential scope and revocation', async () => {
  const s = await setup();
  s.ctx.auth.getUserIdentity = async () => ({ subject: 'owner', forgeCredential: 'synthetic-credential' });
  s.tables.cliCredentials.set('credential', {
    _id: 'credential',
    credentialId: 'synthetic-credential',
    owner: 'owner',
    scope: 'coordination',
    expiresAt: Date.now() + 60000,
    revoked: false,
  });
  const input = { projectId: s.projectId, situation: 'continue-lane', laneId: ids.lane };
  await assert.rejects(briefs.brief._handler(s.ctx, input), code('AUTH_SCOPE_DENIED'));
  await assert.rejects(settings.read._handler(s.ctx, { projectId: s.projectId }), code('AUTH_SCOPE_DENIED'));
  await assert.rejects(
    settings.set._handler(s.ctx, {
      projectId: s.projectId,
      operationId: randomUUID(),
      scope: 'project',
      agentGuidance: 'Denied',
    }),
    code('AUTH_SCOPE_DENIED'),
  );
  s.tables.cliCredentials.get('credential').scope = 'cli';
  assert.equal((await briefs.brief._handler(s.ctx, input)).context.laneId, ids.lane);
  s.tables.cliCredentials.get('credential').revoked = true;
  await assert.rejects(briefs.brief._handler(s.ctx, input), code('AUTH_REVOKED'));
  await assert.rejects(settings.read._handler(s.ctx, { projectId: s.projectId }), code('AUTH_REVOKED'));
});

test('hosted add-lane and land-together briefings include indexed sibling tracks and retain authority checks', async () => {
  const s = await setup();
  for (const situation of ['add-lane', 'land-together']) {
    const result = await briefs.brief._handler(s.ctx, {
      projectId: s.projectId,
      situation,
      intentId: ids.intent,
    });
    assert.equal(result.context.siblingLanes[0].laneId, ids.lane);
    assert.match(result.copyText, /Sibling Lanes/);
    assert.match(result.full, situation === 'add-lane' ? /start.*intentId/ : /with:\[siblingLaneId/);
    s.caller('stranger');
    await assert.rejects(
      briefs.brief._handler(s.ctx, { projectId: s.projectId, situation, intentId: ids.intent }),
      code('PROJECT_UNAVAILABLE'),
    );
    s.caller('owner');
  }
});

test('portable delivery context uses current hosted authority on every read', async () => {
  const s = await setup();
  const handoff = {
    schema: 1,
    operationId: randomUUID(),
    request: 'a'.repeat(64),
    laneId: ids.lane,
    intentId: ids.intent,
    head,
    at: new Date().toISOString(),
    actor: 'synthetic-agent',
    summary: 'Portable handoff',
    tests: [{ source: 'self-reported', command: 'synthetic test', passed: 2, failed: 0, skipped: 0 }],
    recordedChecks: [],
    unrun: ['Full suite'],
    next: ['Lead reviews'],
  };
  const row = { text: handoff.summary, kind: 'comment', at: handoff.at, handoff };
  s.tables.projectWorkRecords.set('delivery-note', {
    _id: 'delivery-note',
    _creationTime: 1000,
    projectId: s.projectId,
    generationId: 'generation',
    collection: 'notes',
    key: 'delivery-note',
    parent: ids.intent,
    position: 1000,
    value: JSON.stringify(row),
  });
  const input = { projectId: s.projectId, situation: 'continue-lane', laneId: ids.lane };
  s.caller('reader');
  await assert.rejects(briefs.brief._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
  s.tables.projectContributors.set('delivery-reader', { projectId: s.projectId, contributor: 'reader' });
  const result = await briefs.brief._handler(s.ctx, input);
  assert.deepEqual(result.context.handoff, handoff);
  const { briefingResult } = await import(moduleUrl('../convex/agentBriefFields.ts'));
  assert.equal(validate(briefingResult, result), true);
  assert.match(result.full, /self-reported/);
  s.tables.projectContributors.delete('delivery-reader');
  await assert.rejects(briefs.brief._handler(s.ctx, input), code('PROJECT_UNAVAILABLE'));
});

test('server-authority brief includes hosted-created decisions with one extra indexed query', async () => {
  const s = await setup();
  s.tables.hostedProjects.get(s.projectId).sourceAuthority = { mode: 'server', epoch: 1 };
  s.tables.projectHostedDecisions = new Map();
  const decisions = await import(moduleUrl('../convex/projectHostedDecisions.ts'));
  const { checkArgs } = await import('./convex-args.mjs');
  const create = async extra => {
    const args = {
      projectId: s.projectId,
      request: JSON.stringify({
        operationId: randomUUID(),
        target: { kind: 'project' },
        decidedBy: 'Owner',
        what: 'Hosted-created context',
        why: 'Read the hosted authority',
        ...extra,
      }),
    };
    checkArgs(decisions.decide, args, 'projectHostedDecisions:decide');
    return JSON.parse(await s.transaction(() => decisions.decide._handler(s.ctx, args)));
  };
  const old = await create({}),
    replacement = await create({ supersedes: old.id, what: 'Replacement hosted context' });
  let queries = 0;
  const query = s.ctx.db.query;
  s.ctx.db.query = table => {
    if (table === 'projectHostedDecisions') queries++;
    return query(table);
  };
  const result = await briefs.brief._handler(s.ctx, {
    projectId: s.projectId,
    situation: 'continue-lane',
    laneId: ids.lane,
    agent: 'codex',
  });
  assert.equal(queries, 1);
  assert.deepEqual(
    result.context.decisions.active.map(record => record.id),
    [replacement.id],
  );
  assert.deepEqual(result.context.decisions.superseded[0].supersededBy, [replacement.id]);
  assert.match(result.full, /Replacement hosted context/);
});
