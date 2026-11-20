// SPDX-License-Identifier: Apache-2.0
// Issue ad80e037 (CLI papercuts): the retry reason has one name across the failure reply and land,
// and a preflight refused for edits made during its `nforge heavy` wait says so. Issue 593fc2d7: refusals
// name the field and what to send first, a withdrawn landing says its id is spent, agent verbs typed at
// the top level name the agent command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
import { validateHostedCliCommand } from '../dist/hosted-cli-validation.js';
import { normalizeHostedFinishResult } from '../dist/hosted-agent-finish-result.js';
import { landSummary } from '../dist/hosted-land-summary.js';
import { helpTopics } from '../dist/help-topics.js';

test('ad80e037: land takes the retry reason as reason or retryReason; two different values are refused before any call', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  const before = s.calls.length;
  await assert.rejects(
    s
      .transport()
      .dispatch('finish', { laneId: s.lane.laneId, retry: true, reason: 'flake', retryReason: 'infra' }),
    error => error.code === 'BAD_ARGUMENT' && /as "reason"/.test(error.message),
  );
  assert.equal(s.calls.length, before, 'no call');
  // The reply's name lands the same request as the schema's name: the enqueue carries the reason.
  const enqueued = [];
  for (const command of [
    { laneId: s.lane.laneId, retry: true, retryReason: 'flake' },
    { laneId: s.lane.laneId, retry: true, reason: 'flake' },
  ]) {
    const calls = s.calls.length;
    await s.transport().dispatch('finish', { ...command, operationId: randomUUID() });
    const enqueue = s.calls.slice(calls).filter(call => call.name === 'projectHostedLanding:enqueue');
    assert.equal(enqueue.length, 1);
    enqueued.push(JSON.parse(enqueue[0].args.request).retryReason);
  }
  assert.deepEqual(enqueued, ['flake', 'flake'], 'both names enqueue the same retry reason');
  // The schema's own refusal names the field to add.
  const refused = hostedAgentCommandSchemas.finish.safeParse({ retry: true });
  assert.match(refused.error.issues[0].message, /add "reason".*next\.retryReason/);
});

test('ad80e037: a preflight refused for edits made during its heavy wait says so and names save and the same preflight', async t => {
  const s = agentFixture(t);
  await s.transport().dispatch('open', { laneId: s.lane.laneId });
  // Edited while the preflight waited: a runnable Node project the plan can read, not yet saved.
  writeFileSync(
    join(s.root, 'package.json'),
    JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }),
  );
  writeFileSync(join(s.root, 'a.test.mjs'), "import test from 'node:test'; test('a', () => {});");
  const prior = process.env.FORGE_HEAVY_PARENT;
  process.env.FORGE_HEAVY_PARENT = JSON.stringify({
    directory: '/unused',
    slot: '1',
    pid: 1,
    waitedMs: 185_000,
  });
  t.after(() =>
    prior === undefined ? delete process.env.FORGE_HEAVY_PARENT : (process.env.FORGE_HEAVY_PARENT = prior),
  );
  await assert.rejects(s.transport().dispatch('preflight', { laneId: s.lane.laneId }), error => {
    assert.equal(error.code, 'LANE_DIRTY');
    assert.match(error.message, /waited 3 min for a heavy slot; the edits came during that wait/);
    assert.match(error.message, /Save, then run the same preflight again/);
    assert.match(
      error.message,
      new RegExp(
        ` save '\\{\\}', then nforge agent .* preflight '\\{"laneId":"${s.lane.laneId}","run":true\\}'`,
      ),
    );
    return true;
  });
});

test('ad80e037: nforge heavy tells the command it runs how long it queued for its slot', t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-heavy-waited-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const settings = join(directory, 'client.json');
  writeFileSync(settings, JSON.stringify({ localHeavySlots: 1 }));
  const show = join(directory, 'show');
  writeFileSync(show, '#!/bin/sh\nprintf "%s" "$FORGE_HEAVY_PARENT"\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, ['dist/cli-entry.js', 'heavy', '--no-build', show], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FORGE_HEAVY_DIR: join(directory, 'slots'),
      FORGE_CLIENT_SETTINGS: settings,
      FORGE_HEAVY_PARENT: '',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parent = JSON.parse(result.stdout);
  assert.equal(typeof parent.waitedMs, 'number');
  assert(parent.waitedMs >= 0 && parent.waitedMs < 60_000, 'a free slot: next to no wait');
});

const refused = (action, command) => {
  try {
    validateHostedCliCommand('/repo', action, command);
  } catch (error) {
    assert.equal(error.code, 'BAD_ARGUMENT');
    return error.message;
  }
  assert.fail(`${action} was accepted`);
};

test('593fc2d7: an enum refusal names the field and its allowed values at the start', () => {
  const message = refused('put-planning-item', { itemId: randomUUID(), status: 'done' });
  assert.match(
    message.slice(0, 120),
    /status: one of proposed\|open\|in-progress\|closed\|abandoned \(got "done"\)/,
  );
  // land's retry reason: the allowed values in the error, and in land help.
  assert.match(
    refused('finish', { retry: true, reason: 'flaky' }),
    /reason: one of flake\|main-moved\|infra\|other \(got "flaky"\)/,
  );
  assert.match(helpTopics.land.text, /"retry":true,"reason":"flake"\|"main-moved"\|"infra"\|"other"/);
  // Self-review before land, and save as an agent action, are in the same topic.
  assert.match(helpTopics.land.text, /diff '\{"summary":true\}' lists changed paths/);
  assert.match(helpTopics.land.text, /nforge agent \. save '\{\}' \(an agent action, not top-level\)/);
});

test('593fc2d7: start with planningItemId and outcome names outcome as the field to drop', () => {
  assert.match(
    refused('start', { planningItemId: randomUUID(), outcome: 'my words' }),
    /Invalid start parameters: outcome: drop it: planningItemId starts from its Issue/,
  );
  assert.match(
    refused('start', { planningItemId: randomUUID(), intentId: randomUUID() }),
    /intentId: drop it/,
  );
});

test('593fc2d7: a withdrawn landing says its operationId is spent and gives a land --save that is new work', () => {
  const operationId = randomUUID(),
    laneId = randomUUID();
  const selection = { laneId, message: 'fix', operationId };
  const result = normalizeHostedFinishResult('/repo', selection, {
    phase: 'finish',
    submission: {
      id: randomUUID(),
      operationId,
      phase: 'terminal-failed',
      observation: { state: 'terminal-failed', pendingReason: null, cause: null },
      error: { code: 'LANDING_CANCELLED', message: 'The hosted landing request was cancelled.' },
    },
  });
  assert.equal(result.retry, undefined, 'a withdraw is not a failed check to retry');
  // retry:true selects a new operation for the same source (the shorthand would replay the cancelled one).
  assert.equal(
    result.command,
    `nforge agent '/repo' land --save '${JSON.stringify({ laneId, message: 'fix', retry: true, reason: 'other' })}'`,
  );
  const [first, second] = landSummary({ operationId, result });
  assert.match(
    first,
    new RegExp(
      `^CANCELLED: this landing was withdrawn; nothing landed\\. Its operationId ${operationId} is spent`,
    ),
  );
  assert.equal(second, `Submit again as a new operation: ${result.command}`);
});

test('593fc2d7: an agent action typed as a top-level command names the agent command', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'forge-top-level-verb-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const cli = join(process.cwd(), 'dist', 'cli-entry.js');
  for (const [verb, prefix] of [
    ['save', 'agent'],
    ['preflight', 'agent'],
    ['abandon', 'x'],
  ]) {
    const result = spawnSync(process.execPath, [cli, verb, '.', '{}'], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      new RegExp(`${verb} is an agent action, not a top-level command: run nforge ${prefix} ROOT ${verb}`),
    );
    assert.equal(result.stdout, '');
  }
});
