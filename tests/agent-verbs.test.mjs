// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  lifecycleVerbs,
  lowerVerb,
  namedReads,
  newForm,
  operatorActions,
  parseVerbForm,
} from '../dist/agent-verbs.js';
import { agentCli } from '../dist/agent-cli.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import {
  hostedAgentAction,
  hostedAgentActions,
  hostedAgentOwnerActions,
  hostedAgentRecordActions,
} from '../dist/hosted-agent-contract.js';
import { agentActionSchema } from '../dist/agent-workflow-schema.js';
import { initNative } from '../dist/native-work.js';
import { trustAgents } from './autonomy-fixture.mjs';
import { cleanupOwner } from './owner-cleanup.mjs';

/**
 * The V1 agent/hosted mapping (plans/p5c-v1-vocabulary.md), one row per current action:
 * [current action, new form or null when kept, native wire action, hosted wire action].
 */
const rows = [
  ['start', null],
  ['open', 'start --open', 'open', 'open'],
  ['checkpoint', 'save', 'checkpoint', 'save'],
  ['save', null],
  ['sync', 'save --sync', 'sync', 'sync'],
  ['undo-sync', 'x undo-sync'],
  ['compose', 'save --candidate', 'compose', 'compose'],
  ['run', 'save --check', 'run', 'check'],
  ['check', 'save --check', 'run', 'check'],
  ['tests', null],
  ['confirm-tests', 'save --contract', 'confirm-tests', 'confirm-tests'],
  ['finish', 'land --save', 'finish', 'finish'],
  ['land', null],
  ['land-ready', 'land --resume-ready', 'land-ready', 'land-ready'],
  ['accept', 'x accept'],
  ['landing', null],
  ['observe', null],
  ['wait', null],
  ['log', null],
  ['cancel', 'x cancel'],
  ['revert', 'x revert'],
  ['undo-revert', 'x undo-revert'],
  ['abandon', 'x abandon'],
  ['reopen', 'start --reopen', 'reopen', 'reopen'],
  ['complete', 'x complete'],
  ['complete-merged', 'x complete-merged'],
  ['clean', 'x clean'],
  ['take', 'x take'],
  ['link', null],
  ['status', null],
  ['pending-status', 'status --pending'],
  ['records', null],
  ['candidate', null],
  ['view', null],
  ['candidates', null],
  ['views', null],
  ['provenance', null],
  ['review', null],
  ['diff', null],
  ['show', null],
  ['brief', null],
  ['guidance', 'x guidance'],
  ['peers', null],
  ['pre-edit', 'x pre-edit'],
  ['install-hooks', 'x install-hooks'],
  ['uninstall-hooks', 'x uninstall-hooks'],
  ['peer-ack', 'save --overlap-answer', 'peer-ack', 'peer-ack'],
  ['overlap-acks', 'save --overlap-answers', 'overlap-acks', 'overlap-acks'],
  ['handoff', 'save --handoff', 'handoff', 'handoff'],
  ['handoff-read', null],
  ['report', 'save --report', 'report', 'report'],
  ['making-of', null],
  ['metrics', null],
  ['friction', 'save --friction', 'friction', 'friction'],
  ['friction-triage', 'x friction-triage'],
  ['improve', null],
  ['decide', 'save --decision', 'decide', 'decide'],
  ['decisions', null],
  ['policy', null],
  ['set-policy', 'x set-policy'],
  ['define-check', 'x define-check'],
  ['configure-check', 'x configure-check'],
  ['configure-runner', 'x configure-runner'],
  ['prioritize', 'x prioritize'],
  ['source-pack', 'x source-pack'],
  ['check-settings', null],
  ['capabilities', null],
  ['integrate', 'save --preview', 'integrate', 'integrate'],
  ['resolve', null],
  ['planning', null],
  ['put-planning-item', null],
  ['comment-planning-item', null],
];

function captured(stream) {
  let text = '';
  const write = process[stream].write;
  process[stream].write = chunk => {
    text += chunk;
    return true;
  };
  return () => {
    process[stream].write = write;
    return text;
  };
}

async function help(args, options) {
  const done = captured('stdout');
  try {
    await agentCli(['/unused/help-only', ...args, '--help'], options);
    return { stdout: done() };
  } catch (error) {
    done();
    return { code: error.code };
  }
}

for (const [action, form, nativeWire, hostedWire] of rows)
  test(`V1 mapping row ${action} → ${form ?? 'kept'}`, async () => {
    // pending-status is MCP only; finish without accept is covered in its own test below.
    const accept = action === 'finish' ? { accept: true } : {};
    assert.equal(newForm(action, accept, false) ?? null, form);
    if (!form) {
      assert.ok(
        [...lifecycleVerbs, ...namedReads].includes(action),
        `${action} is a kept verb or named read`,
      );
      return;
    }
    if (form.startsWith('x ')) {
      const [parsed] = parseVerbForm(action, [], true);
      assert.equal(lowerVerb(parsed, false), action);
      assert.deepEqual(await help([action], { operator: true }), await help([action]));
      return;
    }
    if (action === 'pending-status') return;
    const [verb, ...flags] = form.split(' ');
    const [parsed, rest] = parseVerbForm(verb, [...flags, '{}']);
    assert.deepEqual(rest, ['{}']);
    assert.equal(lowerVerb(parsed, false), nativeWire);
    assert.equal(lowerVerb(parsed, true), hostedWire);
    // The CLI routes the new form to the old native action (same help, same refusal).
    const before = await help([nativeWire]),
      after = await help(form.split(' '));
    assert.deepEqual(after, before);
  });

test('every current agent, hosted, owner and record action has exactly one V1 home', () => {
  const homes = new Set(rows.map(([action]) => action));
  const native = [...agentActionSchema._zod.propValues.action];
  for (const action of [
    ...native,
    ...hostedAgentActions,
    ...hostedAgentOwnerActions,
    ...hostedAgentRecordActions,
    'save',
    'wait',
    'integrate',
  ])
    assert.ok(homes.has(action), `${action} needs a row in the V1 mapping`);
  assert.equal(homes.size, rows.length, 'one row per action');
  for (const action of operatorActions) assert.ok(homes.has(action));
});

test('finish without accept maps to land --save --check-only natively; hosted mirrors its accept:false', () => {
  assert.equal(newForm('finish', {}, false), 'land --save --check-only');
  assert.equal(newForm('finish', { accept: true }, false), 'land --save');
  assert.equal(newForm('finish', {}, true), 'land --save');
  assert.equal(newForm('finish', { accept: false }, true), 'land --save --check-only');
});

test('mode flags are validated before any Work or network access', async () => {
  for (const args of [
    ['save', '--sync', '--candidate'],
    ['save', '--sync', '--sync'],
    ['save', '--check-only'],
    ['start', '--save'],
  ])
    await assert.rejects(
      agentCli(['/unavailable/root', ...args, '{}']),
      error => error.code === 'BAD_ARGUMENT',
    );
  await assert.rejects(
    agentCli(['/unavailable/root', 'finish', '{}'], { operator: true }),
    error => error.code === 'BAD_ARGUMENT' && /x runs operator actions/.test(error.message),
  );
});

/** Old and new spellings reach the hosted transport with the same action and command. */
test('old and new spellings send the same hosted request; only the old one prints its new form', async t => {
  const previous = process.env.FORGE_AUTH_TOKEN;
  process.env.FORGE_AUTH_TOKEN = 'synthetic-test-credential';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_AUTH_TOKEN;
    else process.env.FORGE_AUTH_TOKEN = previous;
  });
  t.mock.method(globalThis, 'fetch', () => assert.fail('No network: dispatch is replaced'));
  const root = join(mkdtempSync(join(tmpdir(), 'forge-verbs-')), 'checkout');
  const address = { url: 'https://synthetic.convex.cloud', projectId: 'project-synthetic' };
  const sent = [];
  t.mock.method(HostedAgentTransport.prototype, 'dispatch', async (action, command) => {
    // Compare what the transport executes: it already treats run/check and checkpoint/save as one action.
    sent.push({ action: hostedAgentAction(action), command });
    return { schema: 1, transport: 'hosted', action, operationId: null, resolved: null, result: {} };
  });
  const laneId = randomUUID(),
    candidateId = randomUUID(),
    submissionId = randomUUID();
  const pairs = [
    ['checkpoint', ['save'], { laneId, message: 'Save' }],
    ['sync', ['save', '--sync'], { laneId }],
    ['compose', ['save', '--candidate'], { laneId }],
    ['run', ['save', '--check'], { candidateId }],
    ['check', ['save', '--check'], { candidateId }],
    ['open', ['start', '--open'], { laneId }],
    ['reopen', ['start', '--reopen'], { laneId }],
    ['finish', ['land', '--save'], { laneId, message: 'Land' }],
    ['finish', ['land', '--save', '--check-only'], { laneId, message: 'Check', accept: false }],
    ['confirm-tests', ['save', '--contract'], { candidateId }],
    ['friction', ['save', '--friction'], { title: 'T' }],
    ['decide', ['save', '--decision'], { what: 'W' }],
    ['peer-ack', ['save', '--overlap-answer'], { laneId }],
    ['overlap-acks', ['save', '--overlap-answers'], { answers: [] }],
    ['cancel', ['x', 'cancel'], { submissionId }],
    ['revert', ['x', 'revert'], { message: 'R' }],
    ['abandon', ['x', 'abandon'], { laneId }],
    ['prioritize', ['x', 'prioritize'], { submissionId, priority: 'urgent' }],
    ['configure-check', ['x', 'configure-check'], { name: 'verify' }],
    ['configure-runner', ['x', 'configure-runner'], { provider: 'self-hosted' }],
  ];
  for (const [old, current, input] of pairs) {
    const oldInput = input;
    const newInput = current.includes('--check-only') ? (({ accept, ...rest }) => rest)(input) : input;
    sent.length = 0;
    let done = captured('stderr');
    await agentCli([root, old, JSON.stringify({ ...address, ...oldInput })]);
    const oldNotice = done();
    done = captured('stderr');
    const args =
      current[0] === 'x'
        ? [[root, current[1], JSON.stringify({ ...address, ...newInput })], { operator: true }]
        : [[root, ...current, JSON.stringify({ ...address, ...newInput })]];
    await agentCli(...args);
    const newNotice = done();
    // Budget: lowering is local; each spelling makes exactly one transport dispatch.
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[1], sent[0], `${old} and ${current.join(' ')} send the same request`);
    assert.equal(
      oldNotice,
      `Alias: ${old} is now nforge ${current[0] === 'x' ? 'x' : 'agent'} ${root} ${current[0] === 'x' ? current[1] : current.join(' ')} (same JSON and replay identity).\n`,
    );
    assert.equal(newNotice, '');
  }
  // Kept verbs and reads stay quiet; the internal set-policy facade does too.
  for (const action of ['save', 'start', 'status', 'capabilities']) {
    const done = captured('stderr');
    await agentCli([root, action, JSON.stringify(address)]);
    assert.equal(done(), '', action);
  }
  // A failing old spelling prints no notice: error stderr stays one JSON object for callers that parse it.
  t.mock.method(HostedAgentTransport.prototype, 'dispatch', async () => {
    throw Object.assign(new Error('Synthetic failure'), { code: 'WORK_OPERATION_CHANGED' });
  });
  const failing = captured('stderr');
  await assert.rejects(agentCli([root, 'friction', JSON.stringify({ ...address, title: 'T' })]));
  assert.equal(failing(), '');
});

test('native land --save replays the original finish: same receipt, one operation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-verbs-native-'));
  writeFileSync(join(root, 'a.txt'), 'a\n');
  initNative(root);
  trustAgents(root);
  try {
    const agent = new AgentWorkflow(root);
    await agent.dispatch({
      action: 'define-check',
      name: 'verify',
      executable: process.execPath,
      args: ['-e', '0'],
    });
    const lane = (await agent.dispatch({ action: 'start', outcome: 'Verbs' })).result;
    writeFileSync(join(lane.path, 'a.txt'), 'b\n');
    const operationId = randomUUID();
    let done = captured('stderr');
    const finished = await agentCli([
      root,
      'finish',
      JSON.stringify({ operationId, laneId: lane.laneId, message: 'Old spelling', accept: true }),
    ]);
    // Check progress lines follow on stderr; the alias notice is the single first line.
    const notices = done()
      .split('\n')
      .filter(line => line.startsWith('Alias:'));
    assert.deepEqual(notices, [
      `Alias: finish is now nforge agent ${root} land --save (same JSON and replay identity).`,
    ]);
    assert.equal(finished.result.status, 'accepted');
    done = captured('stderr');
    const replayed = await agentCli([root, 'land', '--save', JSON.stringify({ operationId })]);
    assert.doesNotMatch(done(), /Alias:/);
    const { resolved, ...original } = finished.result;
    assert.ok(resolved, 'the first reply returns its filled pins');
    assert.deepEqual(replayed.result, original);
    // A check-only resume of an accepting finish is refused rather than silently landing.
    await assert.rejects(
      agentCli([root, 'land', '--save', '--check-only', JSON.stringify({ operationId })]),
      error => error.code === 'BAD_ARGUMENT',
    );
    // A fresh land --save requests acceptance like finish {accept:true}.
    const second = (await agent.dispatch({ action: 'start', outcome: 'Verbs 2' })).result;
    writeFileSync(join(second.path, 'a.txt'), 'c\n');
    done = captured('stderr');
    const landed = await agentCli([
      root,
      'land',
      '--save',
      JSON.stringify({ laneId: second.laneId, message: 'New spelling' }),
    ]);
    assert.doesNotMatch(done(), /Alias:/);
    assert.equal(landed.result.status, 'accepted');
  } finally {
    await cleanupOwner(root);
  }
});
