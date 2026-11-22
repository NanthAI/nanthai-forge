// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
import {
  allHelpTopics,
  hostedAgentHelp,
  hostedAgentHelpEntries,
  hostedAgentHelpMarkdown,
  hostedHelpFor,
} from '../dist/hosted-agent-help.js';
import { HELP_TOPIC_MAX, helpTopics, helpTopicText } from '../dist/help-topics.js';
import { cliTeachContext, teach, teachReceipt } from '../dist/error-teaching.js';
import { describeFailure } from '../dist/system-errors.js';
import { ForgeError } from '../dist/errors.js';
import { landAnnouncement } from '../dist/hosted-land-wait.js';
import { canonicalRoot } from '../dist/root-paths.js';
import { agentCli } from '../dist/agent-cli.js';
import { docsCli } from '../dist/docs-cli.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { readDocument } from '../scripts/package-documents.mjs';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));

async function output(call) {
  const previous = process.stdout.write;
  let text = '';
  process.stdout.write = chunk => {
    text += chunk;
    return true;
  };
  try {
    await call();
  } finally {
    process.stdout.write = previous;
  }
  return text;
}

test('hosted help and packaged docs are generated from every enforced schema', async t => {
  assert.deepEqual(
    hostedAgentHelpEntries.map(e => e.action),
    [
      ...Object.keys(hostedAgentCommandSchemas),
      'provenance',
      'records',
      'log',
      'lanes',
      'diff',
      'peers',
      'queue',
      'landings',
      'lane-history',
      'flow',
      'wait',
      'show',
      'board',
      'board-resolve',
      'ask',
      'hand-back',
      'history',
    ],
  );
  for (const entry of hostedAgentHelpEntries)
    assert.deepEqual(
      entry.parameters.map(p => p.replace(/[?*]$/, '')),
      Object.keys(entry.schema.properties),
    );
  const doc = readDocument(repo, 'docs/agents/workflow.md');
  assert.equal(
    doc.match(/<!-- hosted-agent-contract:start -->[\s\S]*?<!-- hosted-agent-contract:end -->/)[0],
    hostedAgentHelpMarkdown(),
  );
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const before = s.calls.length;
  assert.equal(await output(() => agentCli([s.root, '--help'])), hostedAgentHelp());
  for (const [form, action] of [
    [['land', '--save'], 'finish'],
    [['observe'], 'observe'],
    [['lanes'], 'lanes'],
    [['landing'], 'observe'],
  ])
    assert.equal(await output(() => agentCli([s.root, ...form, '--help'])), hostedAgentHelp(action));
  assert.equal(
    await output(() => docsCli(['agents/hosted'])),
    `${hostedAgentHelp()}\n${allHelpTopics()}\n${hostedAgentHelpMarkdown()}\n`,
  );
  assert.equal(s.calls.length, before, 'help and docs make zero Convex calls');
  const text = hostedAgentHelp();
  for (const unsupported of ['--resume-ready', 'waitMs', 'candidates:', 'brief:', 'review:'])
    assert(!text.includes(unsupported), unsupported);
});

test('core maintenance help distinguishes submission cancellation, Lane withdrawal and checked revert', () => {
  for (const action of ['abandon', 'revert', 'cancel']) {
    assert.match(hostedAgentHelp(action), new RegExp(`Example: nforge agent ROOT ${action} `));
  }
  assert.match(hostedAgentHelp('cancel'), /cancel \{submissionId\} stops one named submission/);
  assert.match(hostedAgentHelp('cancel'), /land --withdraw selects the Lane's own live landing/);
  const revert = hostedAgentHelp('revert');
  assert.match(revert, /land --save.*checked compensating landing/);
  assert.match(revert, /"target":\{"kind":"receipt","receiptId":"RECEIPT_ID"\}/);
});

test('hosted coordination entry points retain supported reads and their coverage limits', () => {
  for (const path of ['AGENTS.md', 'skills/forge-agent/SKILL.md', 'docs/agents/workflow.md']) {
    const text = readDocument(repo, path);
    for (const field of ['conflictNotice', 'behindMain'])
      assert(text.includes(field), `${path}: use the supported receipt fields`);
    assert.match(text, /unsaved/i, `${path}: saved-path coverage limit`);
    assert.match(text, /`diff/, `${path}: documented hosted diff`);
    assert.match(text, /`peers/, `${path}: documented hosted peers`);
    assert.doesNotMatch(text, /Receipts include advisory peers;[^\n]*`peers/);
    assert.doesNotMatch(text, /Source reads: `diff` compares Lane base/);
  }
  // The prose lives in its help topics (Issue 0a7d6f56), one fetch away from `help`.
  const text = helpTopicText('review') + helpTopicText('overlap');
  assert.match(hostedAgentHelp(), /help TOPIC/);
  assert.match(text, /peers \{laneId\?,path\?,detail\?\}/);
  assert.match(text, /diff \{laneId\?,paths\?,byteBudget\?,summary\?,cursor\?\}/);
  assert.match(text, /receipts carry behindMain/);
  assert.doesNotMatch(text, /unacknowledgedOverlaps/);
  assert.match(text, /excludes unsaved peer edits/);
  assert.match(text, /compares pinned base to saved head/);
  assert.match(text, /show \{state\?\|candidateId\?/);
});

test('unsupported actions give a supported alternative without upgrade advice or network IO', async t => {
  const s = agentFixture(t);
  for (const [action, hint] of [
    ['land-ready', 'land --save'],
    ['candidates', 'status'],
    ...[
      'review',
      'brief',
      'link',
      'handoff',
      'handoff-read',
      'report',
      'making-of',
      'pending-status',
      'improve',
      'integrate',
      'undo-sync',
    ].map(action => [action, '--help']),
  ]) {
    await assert.rejects(s.transport().dispatch(action, { secret: 'do-not-echo' }), error => {
      assert.equal(error.code, 'HOSTED_ACTION_UNSUPPORTED');
      assert(error.message.includes(hint), error.message);
      assert.doesNotMatch(error.message, /Upgrade|do-not-echo/);
      return true;
    });
  }
  assert.equal(s.calls.length, 0);
});

test('bare land help names the same explicit continuation as dispatch', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const before = s.calls.length;
  const help = await output(() => agentCli([s.root, 'land', '--help']));
  assert.match(help, /^Hosted action land is unavailable\. Use land --save/);
  assert.doesNotMatch(help, /"properties"/);
  await assert.rejects(
    agentCli([s.root, 'land', '{}'], { beforeDispatch: () => assert.fail('Bare land cannot dispatch') }),
    error => error.code === 'HOSTED_ACTION_UNSUPPORTED' && /Use land --save/.test(error.message),
  );
  assert.equal(s.calls.length, before);
});

test('observation BAD_ARGUMENT names supported targets and rejected fields', async t => {
  const s = agentFixture(t);
  await assert.rejects(
    s.transport().dispatch('observe', {}),
    error => error.code === 'BAD_ARGUMENT' && /status also accepts laneId/.test(error.message),
  );
  for (const command of [{ laneId: s.lane.laneId }, { operationId: randomUUID(), waitMs: 1000 }])
    await assert.rejects(
      s.transport().dispatch('observe', command),
      error =>
        error.code === 'BAD_ARGUMENT' &&
        /Unrecognized key/.test(error.message) &&
        !/Retry the original/.test(error.message),
    );
  assert.equal((await s.transport().dispatch('status', { laneId: s.lane.laneId })).result.head, s.lane.head);
});

test('receipt replay preserves the normalized full original parameters and journal identity', async t => {
  const s = agentFixture(t);
  const command = {
    laneId: s.lane.laneId,
    message: 'Save "all"\nparameters',
    keepOpen: true,
    priority: 'normal',
    check: { checkId: randomUUID() },
  };
  const first = await s.transport().dispatch('finish', command);
  assert.equal(first.result.replayParameters.message, command.message);
  assert.deepEqual(
    hostedAgentCommandSchemas.finish.parse(
      first.result.replayParameters && (({ operationId, ...rest }) => rest)(first.result.replayParameters),
    ),
    hostedAgentCommandSchemas.finish.parse(command),
  );
  const announcement = landAnnouncement(canonicalRoot(s.root), {}, first).join('\n');
  assert(announcement.includes(first.result.waitCommand), announcement);
  assert.deepEqual(first.result.next.operationIds, [first.operationId]);
  assert.equal(first.result.next.action, 'wait');
  const again = await s.transport().dispatch('finish', first.result.replayParameters);
  assert.equal(again.operationId, first.operationId);
  assert.equal(again.result.submission.id, first.result.submission.id);
});

test('admitted pending source waits while retaining a helper-free original replay selection', async t => {
  const s = agentFixture(t);
  s.pending(true);
  const command = { laneId: s.lane.laneId, message: 'Retain async source message', keepOpen: true };
  const first = await s.transport().dispatch('finish', command);
  assert.equal(first.result.submission.preparing, true, 'the desired landing is already admitted');
  assert.equal(first.result.next.action, 'wait');
  assert.equal(first.result.command, first.result.waitCommand);
  assert.equal(first.result.replayParameters.message, command.message);
  const line = landAnnouncement(canonicalRoot(s.root), {}, first).join('\n');
  assert(line.includes(first.result.waitCommand));
  assert.equal(first.result.replayParameters.command, undefined);
  assert(!line.includes('"command":'));
  const again = await s.transport().dispatch('finish', first.result.replayParameters);
  assert.equal(again.operationId, first.operationId);
});

test('help TOPIC prints one section, at most 1,500 characters, with no Convex call (0a7d6f56)', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const before = s.calls.length;
  for (const [id, topic] of Object.entries(helpTopics))
    assert(`${topic.title}\n${topic.text}`.length <= HELP_TOPIC_MAX, id);
  const conflict = await output(() => agentCli([s.root, 'help', 'conflict']));
  assert.equal(conflict, helpTopicText('conflict'));
  assert(!conflict.includes(helpTopics.board.text), 'one topic, not the manual');
  // An action name prints that action's schema plus only its own topic.
  const wait = hostedAgentHelp('wait');
  assert(wait.includes(helpTopics.wait.text) && !wait.includes(helpTopics.board.text));
  assert(hostedAgentHelp().length < 6000, 'the overview keeps how-to prose in topics');
  await assert.rejects(
    agentCli([s.root, 'help', 'no-such-topic']),
    error => error.code === 'BAD_ARGUMENT' && /Topics \(one section each\)/.test(error.message),
  );
  assert.equal(s.calls.length, before);
});

test('a refusal teaches next and learn with the caller values; code, message and recovery stay as they were', () => {
  // Bench B1.5d: agents typed the operator form under agent and repeated the same BAD_ARGUMENT.
  const operator = describeFailure(
    new ForgeError('BAD_ARGUMENT', 'Use agent ROOT ACTION [JSON | --command-file FILE].'),
    cliTeachContext(['agent', '.', 'x', 'cancel', '{"submissionId":"dfcc483d-3972-408d-9251-cc90909247e4"}']),
  );
  assert.equal(operator.code, 'BAD_ARGUMENT');
  assert.equal(operator.message, 'Use agent ROOT ACTION [JSON | --command-file FILE].');
  assert.equal(operator.next, `nforge x . cancel '{"submissionId":"dfcc483d-3972-408d-9251-cc90909247e4"}'`);
  assert.equal(operator.learn, 'nforge agent . help arguments');
  const friction = describeFailure(
    new ForgeError('BAD_ARGUMENT', 'operationId must be a UUID.'),
    cliTeachContext(['agent', '/a lane', 'save', '--friction', '{"operationId":"short"}']),
  );
  assert.equal(friction.next, "nforge agent '/a lane' help friction");
  assert.equal(friction.learn, "nforge agent '/a lane' help arguments");
  assert.match(hostedHelpFor('friction'), /operationId[\s\S]*uuid/);
  const lane = '7c9295d7-6f84-4ee1-8e5c-aa27e4ccc69c';
  // A server continuation wins over the template; an unknown code teaches nothing and breaks nothing.
  const own = teach('COMPOSITION_CONFLICT', cliTeachContext(['agent', '.', 'land']), {
    command: `nforge agent . resolve '{"laneId":"${lane}"}'`,
  });
  assert.equal(own.next, `nforge agent . resolve '{"laneId":"${lane}"}'`);
  assert.deepEqual(teach('NOT_A_PUBLIC_CODE'), {});
  // A replay longer than the budget is omitted rather than cut.
  const long = teach(
    'WORK_STALE',
    cliTeachContext(['agent', '.', 'save', `{"message":"${'x'.repeat(400)}"}`]),
  );
  assert.equal(long.next, undefined);
  assert.equal(long.learn, 'nforge agent . help retry');
  // Without a caller context (in-process callers) the failure is exactly as before.
  assert.deepEqual(describeFailure(new ForgeError('NOT_FOUND', 'x')), { code: 'NOT_FOUND', message: 'x' });
  // MCP learns through its own help call and never gets a shell command it cannot run.
  assert.deepEqual(teach('CHECK_FAILED', { surface: 'mcp' }), {
    learn: 'forge_work_overview {"action":"help","topic":"check"}',
  });
});

test('a terminal error inside a receipt names its topic; a healthy receipt is returned unchanged', () => {
  const healthy = { result: { status: 'landed', receiptId: 'r' } };
  assert.equal(teachReceipt(healthy, { surface: 'cli' }), healthy);
  const failed = teachReceipt(
    { result: { submission: { error: { code: 'COMPOSITION_CONFLICT', message: 'conflicts' } } } },
    cliTeachContext(['agent', '.', 'wait', '{}']),
  );
  assert.deepEqual(failed.result.submission.error, {
    code: 'COMPOSITION_CONFLICT',
    message: 'conflicts',
    learn: 'nforge agent . help conflict',
  });
});

// 657d63ee: help once advertised client reads that dispatch rejected before validation.
test('every generated hosted action reaches dispatch validation instead of an unsupported refusal', async t => {
  const s = agentFixture(t);
  const transport = s.transport();
  for (const { action } of hostedAgentHelpEntries) {
    // CLI-owned adapters (source/board/wait) are tested at their entry points; transport
    // actions must recognise their names before rejecting this deliberately invalid body.
    if (['show', 'history', 'wait', 'board', 'ask', 'hand-back', 'board-resolve'].includes(action)) continue;
    await assert.rejects(
      transport.dispatch(action, { unsupportedGuard: true }),
      error => {
        assert.notEqual(error.code, 'HOSTED_ACTION_UNSUPPORTED', action);
        return true;
      },
      action,
    );
  }
  assert.equal(s.calls.length, 0, 'invalid advertised commands must not start work');
});

// c24edcb2: a stalled live operation must retain its repair identity; generic advice cannot replace it.
test('stalled landing guidance follows exact recovery, and otherwise reads the queue without resubmitting', () => {
  const root = '/synthetic/project';
  const operationId = randomUUID();
  const repair = `nforge agent ${root} landing '{"operationId":"${operationId}"}'`;
  for (const surface of ['cli', 'mcp'])
    assert.equal(teach('LANDING_STALLED', { root, surface }, { command: repair }).next, repair);
  assert.equal(teach('LANDING_STALLED', { root }).next, `nforge agent ${root} queue '{}'`);
  for (const topic of ['wait', 'queue']) {
    const stalled = helpTopicText(topic).split('LANDING_STALLED:')[1].split('\n')[0];
    assert.match(stalled, /repair command/);
    assert.match(stalled, /do not resubmit/i);
    assert.doesNotMatch(stalled, /land --save again/);
  }
});

// J18-3: the CLI adapter must be discoverable without advertising an unsupported transport action.
test('history help exposes the enforced log/blame/show selectors without a server call', async t => {
  const s = agentFixture(t);
  const before = s.calls.length;
  const text = await output(() => agentCli([s.root, 'history', '--help']));
  for (const word of ['log', 'blame', 'show', 'commit', 'path', 'skip']) assert(text.includes(word));
  assert.match(await output(() => agentCli([s.root, 'help'])), /history:.*log, blame, show/);
  assert.match(text, /who changed lines/);
  assert.equal(hostedHelpFor('history'), text);
  assert.equal(s.calls.length, before);
});

test('limits help identifies the service rather than promising owner control of service quotas', () => {
  assert.match(helpTopicText('limits'), /service[^.\n]*(?:set|defined)|(?:set|defined)[^.\n]*service/i);
  assert.doesNotMatch(helpTopicText('limits'), /Limits are set by the project owner/);
});

// A file-history request must teach the existing reader rather than silently discard the filter.
test('landings directs unsupported file filters to history log and blame without a query', async t => {
  const s = agentFixture(t);
  await assert.rejects(
    () =>
      agentCli(
        [
          s.root,
          'landings',
          JSON.stringify({ ...s.address, from: '2026-11-01', to: '2026-12-01', path: 'src/file.ts' }),
        ],
        { beforeDispatch: async () => assert.fail('invalid input must not reach release discovery') },
      ),
    error => error.code === 'BAD_ARGUMENT' && /history.*log.*path.*history.*blame/.test(error.message),
  );
  assert.equal(s.calls.length, 0);
  const { landingsHostedSource } = await import('../dist/hosted-agent-landings.js');
  await assert.rejects(
    () =>
      landingsHostedSource(
        {
          query() {
            assert.fail('invalid input must stay local');
          },
        },
        { path: 'src/file.ts' },
      ),
    error => error.code === 'BAD_ARGUMENT' && /history.*log.*path.*history.*blame/.test(error.message),
  );
});

test('df06081d: the CLI landings read filters a window to agents or to people and refuses it for one receipt', async () => {
  const { landingsHostedSource } = await import('../dist/hosted-agent-landings.js');
  const sent = [];
  const transport = {
    async query(name, args) {
      sent.push([name, args]);
      return { landings: [] };
    },
  };
  const window = { from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' };
  await landingsHostedSource(transport, { ...window, kind: 'agent' });
  assert.equal(sent[0][0], 'projectHostedLandings:read');
  assert.equal(sent[0][1].kind, 'agent');
  for (const input of [
    { ...window, kind: 'robot' },
    { receiptId: 'abcdef12', kind: 'person' },
  ])
    await assert.rejects(landingsHostedSource(transport, input), error => error.code === 'BAD_ARGUMENT');
  assert.equal(sent.length, 1, 'invalid input stays local');
});

test('journey 61 (Issue 47558a99): action help leads with a runnable example and prints ids as format uuid, without the pattern', () => {
  for (const [action, example] of [
    ['lane-history', `Example: nforge agent ROOT lane-history '{}'`],
    ['records', `Example: nforge agent ROOT records '{"collection":"intents"}'`],
    ['comment-planning-item', `Example: nforge agent ROOT comment-planning-item '{"text":"…"}'`],
    ['configure-check', `Example: nforge x ROOT configure-check '{}'`],
  ]) {
    const text = hostedAgentHelp(action);
    const lines = text.split('\n');
    const at = lines.indexOf(example);
    assert(at > 0, `${action}: ${example}`);
    assert(at < lines.findIndex(line => line === '{'), 'the example comes before the schema');
    assert.doesNotMatch(text, /"pattern": "\^\(\[0-9a-fA-F\]\{8\}/, 'no uuid regex in printed help');
  }
  // The printed schema keeps every field and its uuid format; only the repeated regex goes.
  const schema = hostedAgentHelpEntries.find(entry => entry.action === 'lane-history').schema;
  assert.equal(schema.properties.laneId.format, 'uuid');
  assert.match(
    hostedAgentHelp('lane-history'),
    /"laneId": \{\n\s+"type": "string",\n\s+"format": "uuid"\n\s+\}/,
  );
});
