// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
  retiredActions,
} from '../dist/agent-verbs.js';
import { agentCli } from '../dist/agent-cli.js';
import { HostedAgentTransport } from '../dist/hosted-agent-transport.js';
import {
  hostedAgentAction,
  hostedAgentActions,
  hostedAgentOwnerActions,
  hostedAgentRecordActions,
  hostedAgentLandingActions,
} from '../dist/hosted-agent-contract.js';
import { agentActionSchema } from '../dist/agent-workflow-schema.js';

/**
 * The V1 agent/hosted mapping (plans/p5c-v1-vocabulary.md), one row per current action:
 * [current action, new form or null when kept or 'retired' when it left with native mode,
 * native wire action, hosted wire action].
 */
const rows = [
  ['start', null],
  ['open', 'start --open', 'open', 'open'],
  ['checkpoint', 'save', 'checkpoint', 'save'],
  ['save', null],
  ['sync', 'save --sync', 'sync', 'sync'],
  ['undo-sync', 'retired'],
  ['compose', 'save --candidate', 'compose', 'compose'],
  ['run', 'save --check', 'run', 'check'],
  ['check', 'save --check', 'run', 'check'],
  ['tests', null],
  ['confirm-tests', 'save --contract', 'confirm-tests', 'confirm-tests'],
  ['finish', 'land --save', 'finish', 'finish'],
  ['land', null],
  ['land-ready', 'retired'],
  ['withdraw', 'land --withdraw', 'withdraw', 'withdraw'],
  ['accept', 'retired'],
  ['landing', null],
  ['observe', null],
  ['wait', null],
  ['log', null],
  ['cancel', 'x cancel'],
  ['revert', 'x revert'],
  ['undo-revert', 'retired'],
  ['abandon', 'x abandon'],
  ['reopen', 'start --reopen', 'reopen', 'reopen'],
  ['complete', 'x complete'],
  ['complete-merged', 'x complete-merged'],
  ['abandon-dormant', 'x abandon-dormant'],
  ['pin', 'x pin'],
  ['clean', 'retired'],
  ['take', 'retired'],
  ['link', 'retired'],
  ['status', null],
  ['pending-status', 'retired'],
  ['records', 'retired'],
  ['candidate', 'retired'],
  ['view', 'retired'],
  ['candidates', 'retired'],
  ['views', 'retired'],
  ['provenance', 'retired'],
  ['review', 'retired'],
  ['diff', null],
  ['show', null],
  ['brief', 'retired'],
  ['guidance', 'retired'],
  ['peers', null],
  ['pre-edit', 'retired'],
  ['install-hooks', 'x install-hooks'],
  ['uninstall-hooks', 'x uninstall-hooks'],
  ['peer-ack', 'retired'],
  ['handoff', 'retired'],
  ['handoff-read', 'retired'],
  ['report', 'retired'],
  ['making-of', 'retired'],
  ['metrics', null],
  ['friction', 'save --friction', 'friction', 'friction'],
  ['friction-triage', 'x friction-triage'],
  ['friction-list', null],
  ['improve', 'retired'],
  ['decide', 'save --decision', 'decide', 'decide'],
  ['decisions', null],
  ['policy', null],
  ['set-policy', 'x set-policy'],
  ['define-check', 'retired'],
  ['configure-check', 'x configure-check'],
  ['configure-runner', 'x configure-runner'],
  ['prioritize', 'x prioritize'],
  ['source-pack', 'x source-pack'],
  ['snapshots', 'x snapshots'],
  ['check-settings', null],
  ['capabilities', null],
  ['integrate', 'retired'],
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

test('save --overlap-answer is refused with the conflictNotice explanation (path notices were removed, Issue 853fcde3)', () => {
  assert.throws(
    () => parseVerbForm('save', ['--overlap-answer', '{}']),
    error =>
      error.code === 'HOSTED_ACTION_UNSUPPORTED' &&
      error.message ===
        `save --overlap-answer was removed with native mode. Use ${retiredActions['peer-ack']}.`,
  );
});

for (const [action, form, nativeWire, hostedWire] of rows)
  test(`V1 mapping row ${action} → ${form ?? 'kept'}`, async () => {
    // pending-status is MCP only; finish without accept is covered in its own test below.
    const accept = action === 'finish' ? { accept: true } : {};
    if (form === 'retired') {
      // One client mode (Issue 657d63ee): a native-only action is refused with its hosted replacement.
      assert.equal(newForm(action, accept, true), undefined);
      assert.throws(
        () => parseVerbForm(action, ['{}']),
        error =>
          error.code === 'HOSTED_ACTION_UNSUPPORTED' &&
          error.message === `${action} was removed with native mode. Use ${retiredActions[action]}.`,
      );
      return;
    }
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
    ...hostedAgentLandingActions,
    'save',
    'wait',
    'integrate',
  ])
    assert.ok(homes.has(action), `${action} needs a row in the V1 mapping`);
  assert.equal(homes.size, rows.length, 'one row per action');
  for (const action of operatorActions) assert.ok(homes.has(action));
  for (const action of Object.keys(retiredActions)) assert.ok(homes.has(action), action);
});

test('retired native mode spellings name the typed form and its hosted replacement', () => {
  for (const [verb, flag, action] of [
    ['save', '--handoff', 'handoff'],
    ['save', '--report', 'report'],
    ['save', '--preview', 'integrate'],
    ['land', '--resume-ready', 'land-ready'],
  ])
    assert.throws(
      () => parseVerbForm(verb, [flag, '{}']),
      error =>
        error.code === 'HOSTED_ACTION_UNSUPPORTED' &&
        error.message === `${verb} ${flag} was removed with native mode. Use ${retiredActions[action]}.`,
    );
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
    ['cancel', ['x', 'cancel'], { submissionId }],
    ['revert', ['x', 'revert'], { message: 'R' }],
    ['abandon', ['x', 'abandon'], { laneId }],
    ['prioritize', ['x', 'prioritize'], { submissionId, priority: 'urgent' }],
    ['pin', ['x', 'pin'], { laneId, pinned: true }],
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
