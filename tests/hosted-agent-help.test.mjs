// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
import {
  hostedAgentHelp,
  hostedAgentHelpEntries,
  hostedAgentHelpMarkdown,
} from '../dist/hosted-agent-help.js';
import { landAnnouncement } from '../dist/hosted-land-wait.js';
import { agentCli } from '../dist/agent-cli.js';
import { docsCli } from '../dist/docs-cli.js';
import { agentFixture } from './hosted-agent-fixture.mjs';

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
    [...Object.keys(hostedAgentCommandSchemas), 'wait', 'show'],
  );
  for (const entry of hostedAgentHelpEntries)
    assert.deepEqual(
      entry.parameters.map(p => p.replace(/\?$/, '')),
      Object.keys(entry.schema.properties),
    );
  const doc = readFileSync(new URL('../docs/agents/workflow.md', import.meta.url), 'utf8');
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
    [['landing'], 'observe'],
  ])
    assert.equal(await output(() => agentCli([s.root, ...form, '--help'])), hostedAgentHelp(action));
  assert.equal(
    await output(() => docsCli(['agents/hosted'])),
    `${hostedAgentHelp()}\n${hostedAgentHelpMarkdown()}\n`,
  );
  assert.equal(s.calls.length, before, 'help and docs make zero Convex calls');
  const text = hostedAgentHelp();
  for (const unsupported of ['--resume-ready', 'waitMs', 'records:', 'candidates:', 'log:', 'diff:'])
    assert(!text.includes(unsupported), unsupported);
});

test('unsupported actions give a supported alternative without upgrade advice or network IO', async t => {
  const s = agentFixture(t);
  for (const [action, hint] of [
    ['log', 'observe'],
    ['land-ready', 'land --save'],
    ['records', 'status'],
    ['candidates', 'status'],
    ['diff', 'local Lane'],
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
    overlapAnswer: 'accept-order',
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
  const line = landAnnouncement(s.root, {}, first)[0];
  assert(line.includes(JSON.stringify(first.result.replayParameters)), line);
  const again = await s.transport().dispatch('finish', first.result.replayParameters);
  assert.equal(again.operationId, first.operationId);
  assert.equal(again.result.submission.id, first.result.submission.id);
});

test('inline accept-order on 600 notices adds zero Convex calls against the existing finish path', async t => {
  const { effectiveAgentDefaults } = await import('../dist/agent-parallel-defaults.js');
  const { performance } = await import('node:perf_hooks');
  const notices = Array.from({ length: 600 }, (_, i) => ({
    noticeId: i.toString(16).padStart(64, '0'),
    file: `src/file-${i}.ts`,
    class: 'blocking',
    reason: 'same-symbol',
    lanes: [randomUUID()],
    text: 'Synthetic overlap',
  }));
  async function run(inline) {
    const s = agentFixture(t);
    s.caps.agentDefaults = effectiveAgentDefaults({
      preflight: 'off',
      overlapGate: inline ? 'block' : 'warn',
    });
    await s.transport().dispatch('open', { laneId: s.lane.laneId });
    const transport = s.transport(),
      original = transport.query.bind(transport);
    let reads = 0;
    transport.query = async (name, args) => {
      if (name !== 'projectHostedOverlaps:read') return original(name, args);
      reads++;
      return {
        unacknowledgedOverlaps: { count: 600, items: notices, coverage: 'complete' },
        behindMain: { commits: 0, conflictingPaths: [], more: 0, coverage: 'complete' },
      };
    };
    s.calls.length = 0;
    const start = performance.now();
    const response = await transport.dispatch('finish', {
      laneId: s.lane.laneId,
      ...(inline ? { overlapAnswer: 'accept-order' } : {}),
    });
    return { calls: s.calls.map(c => c.name), reads, response, ms: performance.now() - start };
  }
  const before = await run(false),
    after = await run(true);
  assert.deepEqual(after.calls, before.calls);
  assert.equal(after.reads, before.reads);
  assert.equal(after.reads, 1, 'gate and receipt share the existing overlap read');
  assert.equal(after.response.result.defaults.overlap.status, 'answered');
  assert.equal(after.response.result.defaults.overlap.notices.length, 600);
  t.diagnostic(
    `600 synthetic notices: existing/inline calls ${before.calls.length}/${after.calls.length} plus ${before.reads}/${after.reads} cached overlap read; inline ${after.ms.toFixed(1)} ms; answer receipt ${JSON.stringify(after.response.result.defaults.overlap).length} bytes`,
  );
});

test('pending source replay announcements exclude recovery helper metadata', async t => {
  const s = agentFixture(t);
  s.pending(true);
  const command = { laneId: s.lane.laneId, message: 'Retain async source message', keepOpen: true };
  const first = await s.transport().dispatch('finish', command);
  assert.equal(typeof first.result.replay.command, 'string', 'source recovery has a separate helper command');
  assert.equal(first.result.replayParameters.message, command.message);
  const line = landAnnouncement(s.root, {}, first)[0];
  assert(line.includes(JSON.stringify(first.result.replayParameters)));
  assert(!line.includes('"command":'));
  const again = await s.transport().dispatch('finish', first.result.replayParameters);
  assert.equal(again.operationId, first.operationId);
});
