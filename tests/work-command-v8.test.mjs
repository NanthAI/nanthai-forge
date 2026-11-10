// SPDX-License-Identifier: Apache-2.0
// Issue 85801d6f: the hosted Work command runs in the 64 MiB V8 runtime and hands only the commands
// that need Node (acceptance, anchored notes, oversized rows) to the Node action.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { setup, actions } from './hosted-planning-fixture.mjs';
import { findRuntimeViolations } from '../scripts/check-convex-runtime.mjs';

const v8 = await import(moduleUrl('../convex/projectWorkActionsV8.ts'));
const core = await import(moduleUrl('../convex/projectWorkIndexedCommand.ts'));

test('the V8 command module and its helper stay free of the "use node" directive and Node-only imports', async () => {
  for (const file of ['projectWorkActionsV8', 'projectWorkIndexedCommand', 'projectWorkCommandRun']) {
    const source = readFileSync(new URL(`../convex/${file}.ts`, import.meta.url), 'utf8');
    assert(!/^\s*(?:\/\/[^\n]*\n)*\s*['"]use node['"]/.test(source), file);
    assert(
      !/^import (?!type)[^\n]*from '\.\/(?:projectAcceptance|projectSourceReview|projectWorkLoad|projectWorkActions)'/m.test(
        source,
      ),
      file,
    );
  }
  const violations = await findRuntimeViolations(new URL('..', import.meta.url).pathname);
  assert.deepEqual(
    violations.filter(v => /projectWork(?:ActionsV8|IndexedCommand|CommandRun)/.test(v.module)),
    [],
  );
});

test('a planning command runs in V8 without a Node call, replays by operation id and matches the Node action', async t => {
  const s = await setup(t);
  const delegated = [];
  const run = s.ctx.runAction;
  s.ctx.runAction = (ref, args) => {
    delegated.push(getFunctionName(ref));
    return run(ref, args);
  };
  const input = async command => ({
    projectId: s.projectId,
    operationId: command.operationId,
    revision: (await s.read()).data.revision,
    command: JSON.stringify(command),
  });
  const first = s.item(),
    firstInput = await input(first),
    event = await v8.command._handler(s.ctx, firstInput);
  assert.equal(event.operationId, first.operationId);
  assert.equal(event.revision, firstInput.revision + 1);
  assert.deepEqual(delegated, [], 'a planning command never leaves V8');
  // The same operation replays its original event, from V8 and from the Node action alike.
  assert.equal((await v8.command._handler(s.ctx, firstInput))._id, event._id);
  assert.equal((await actions.command._handler(s.ctx, firstInput))._id, event._id);
  // The Node action keeps accepting new work for older clients and writes the same kind of event.
  const second = s.item(),
    secondInput = await input(second),
    nodeEvent = await actions.command._handler(s.ctx, secondInput);
  assert.equal(nodeEvent.revision, secondInput.revision + 1);
  assert.deepEqual(Object.keys(nodeEvent).sort(), Object.keys(event).sort());
  // A changed original request still fails; an unrelated project revision no longer does.
  await assert.rejects(
    v8.command._handler(s.ctx, {
      ...firstInput,
      operationId: first.operationId,
      command: JSON.stringify({ ...first, title: 'changed' }),
    }),
    e => e.data.code === 'WORK_OPERATION_CHANGED',
  );
  const stale = s.item();
  assert.equal(
    (await v8.command._handler(s.ctx, { ...(await input(stale)), revision: firstInput.revision }))
      .operationId,
    stale.operationId,
  );
  assert.deepEqual(delegated, []);
  const signedOut = await input(s.item());
  s.caller(null);
  await assert.rejects(v8.command._handler(s.ctx, signedOut), e => e.data.code === 'PROJECT_UNAVAILABLE');
});

test('anchored notes hand over to the Node action with the resolved owner, before any write', async t => {
  const s = await setup(t);
  const command = {
    action: 'note',
    intentId: randomUUID(),
    text: 'Look at this line',
    kind: 'comment',
    anchor: {
      viewId: randomUUID(),
      base: 'a'.repeat(64),
      head: 'a'.repeat(64),
      file: 'a.ts',
      side: 'after',
      line: 1,
      blob: 'b'.repeat(64),
    },
  };
  const calls = [];
  // The Node action's reply: a stored Work event, as its declared `returns` requires.
  const sentinel = {
    _id: 'node-event',
    _creationTime: 1,
    projectId: s.projectId,
    operationId: 'sentinel',
    request: '0'.repeat(64),
    previousRevision: 1,
    revision: 2,
    actor: 'owner',
    at: new Date(0).toISOString(),
    command: '{}',
  };
  s.ctx.runAction = async (ref, args) => {
    calls.push([getFunctionName(ref), args]);
    return sentinel;
  };
  const writes = s.tables.projectWorkEvents.size;
  const operationId = randomUUID();
  const result = await v8.command._handler(s.ctx, {
    projectId: s.projectId,
    operationId,
    revision: (await s.read()).data.revision,
    command: JSON.stringify(command),
  });
  // Public-people mapping rebuilds a reply that names an actor, so the event comes back equal, not identical.
  assert.deepEqual(result, sentinel);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'projectWorkActions:commandNode');
  assert.equal(calls[0][1].owner, 'owner');
  assert.equal(calls[0][1].operationId, operationId);
  assert.equal(JSON.parse(calls[0][1].command).action, 'note');
  assert.equal(s.tables.projectWorkEvents.size, writes, 'V8 wrote nothing before the hand-over');
  // The same note without an anchor needs no Node reader and stays in V8.
  delete command.anchor;
  calls.length = 0;
  await assert.rejects(
    v8.command._handler(s.ctx, {
      projectId: s.projectId,
      operationId: randomUUID(),
      revision: (await s.read()).data.revision,
      command: JSON.stringify(command),
    }),
  );
  assert.deepEqual(calls, [], 'an unanchored note never leaves V8 (it fails here: unknown intent)');
});

test('rows over the V8 budget hand over to Node, which has no budget', async () => {
  const row = bytes => ({ collection: 'intents', key: 'k', value: 'x'.repeat(bytes) });
  const generation = metadataBytes => ({
    _id: 'generation',
    revision: 1,
    backupId: 'backup',
    metadata: JSON.stringify({
      schema: 24,
      sourceKind: 'native',
      sourceHead: 'a'.repeat(64),
      pad: 'p'.repeat(metadataBytes),
    }),
  });
  const input = { projectId: 'project', operationId: randomUUID(), revision: 1 };
  const command = { action: 'intent', outcome: 'Big', constraints: '', base: 'a'.repeat(64) };
  const contextFor = (current, lookupRows) => ({
    runQuery: async ref => {
      const name = getFunctionName(ref);
      if (name === 'projectWorkIndexStore:current') return current;
      if (name === 'projectWorkIndexStore:lookups') return lookupRows;
      if (name === 'projectWork:get') throw new Error('past the budget gate');
      return {};
    },
  });
  const limit = core.V8_COMMAND_ROW_BYTES;
  assert.equal(limit, 4 * 1024 * 1024);
  // Generation metadata alone over the budget.
  await assert.rejects(
    core.indexedCommand(contextFor(generation(limit + 1), []), input, 'owner', command, 'request'),
    e => e.name === 'NodeCommandRequired',
  );
  // Within budget the V8 path proceeds (and fails later, in this stub, at the project read).
  await assert.rejects(
    core.indexedCommand(contextFor(generation(1000), [row(1000)]), input, 'owner', command, 'request'),
    e => e.message === 'past the budget gate',
  );
  // With Node hooks there is no budget.
  await assert.rejects(
    core.indexedCommand(contextFor(generation(limit + 1), []), input, 'owner', command, 'request', {}),
    e => e.message === 'past the budget gate',
  );
});

test('legacy metadata actions use item concurrency for all five commands and reconcile across revision changes', async t => {
  for (const endpoint of [v8.command, actions.command]) {
    const s = await setup(t);
    const initial = await s.read(),
      intentId = randomUUID(),
      issue = s.item();
    const run = (command, operationId = command.operationId ?? randomUUID()) =>
      endpoint._handler(s.ctx, {
        projectId: s.projectId,
        operationId,
        revision: initial.data.revision,
        command: JSON.stringify(command),
      });
    // Reuse the same now-stale project revision for every distinct metadata operation.
    await run(
      { action: 'intent', outcome: 'Legacy metadata', constraints: '', base: initial.sourceHead },
      intentId,
    );
    await run(issue);
    await run({ action: 'note', intentId, text: 'Kept note', kind: 'comment' });
    await run({ action: 'intent-status', intentId, status: 'completed' });
    await run({ ...issue, operationId: randomUUID(), expectedVersion: 1, title: 'Updated item' });
    const comment = {
      action: 'comment-planning-item',
      operationId: randomUUID(),
      itemId: issue.itemId,
      text: 'Kept comment',
      authorLabel: '',
    };
    const receipt = await run(comment);
    assert.equal((await run(comment))._id, receipt._id);
    await assert.rejects(
      run({ ...issue, operationId: randomUUID(), expectedVersion: 1 }),
      e =>
        e.data.code === 'ITEM_CHANGED' &&
        e.data.recovery.id === issue.itemId &&
        e.data.recovery.expectedVersion === 1 &&
        e.data.recovery.currentVersion === 2,
    );
    await assert.rejects(
      run({ ...comment, text: 'Changed original operation' }),
      e => e.data.code === 'WORK_OPERATION_CHANGED',
    );
    const current = await s.read();
    assert.equal(current.data.planningComments.length, 1);
    assert.equal(current.data.intents.find(item => item.id === intentId).notes.length, 1);
    assert.equal(current.data.intents.find(item => item.id === intentId).status, 'completed');
  }
});

test('scheduled metadata keeps its trusted actor while the mutation rechecks current project authority', async t => {
  const s = await setup(t);
  const commands = await import(moduleUrl('../convex/projectWorkCommand.ts'));
  const issue = s.item();
  const input = {
    projectId: s.projectId,
    owner: 'owner',
    operationId: issue.operationId,
    command: JSON.stringify(issue),
  };
  s.caller(null);
  const receipt = await commands.commandFromAction._handler(s.ctx, input);
  assert.equal(receipt.actor, 'owner');
  assert.deepEqual(await commands.commandFromAction._handler(s.ctx, input), receipt);
  await assert.rejects(
    commands.commandFromAction._handler(s.ctx, { ...input, owner: 'stranger' }),
    e => e.data.code === 'PROJECT_UNAVAILABLE',
  );
  // A project changing owners cannot replay a formerly authorized scheduled command.
  s.tables.hostedProjects.get(s.projectId).owner = 'new-owner';
  await assert.rejects(
    commands.commandFromAction._handler(s.ctx, input),
    e => e.data.code === 'PROJECT_UNAVAILABLE',
  );
});
