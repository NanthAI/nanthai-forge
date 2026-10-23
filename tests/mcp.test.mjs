// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { callTool, mcpTestEnvironment, requestOptions, pollUntil } from './mcp-runtime.mjs';
import assert from 'node:assert/strict';
import { realpathSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { doctor, mcpConfig } from '../dist/setup.js';
import { fixture, write, git } from './helpers.mjs';

test('real stdio MCP discovery, refresh, queries, mutations, validation and shutdown', async t => {
  const root = fixture(t, {
    '.gitignore': '.forge/\n',
    'a.ts': 'export const value = 1;',
    'b.ts': 'import { value } from "./a"; export const answer = value;',
  });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli.js'), 'mcp', root],
    env: mcpTestEnvironment(t),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => {
    stderr += chunk;
  });
  const client = new Client({ name: 'forge-protocol-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
  });
  await client.connect(transport, requestOptions('connect'));
  const { tools } = await client.listTools(undefined, requestOptions('listTools'));
  assert.equal(tools.length, 8);
  assert.equal(tools.find(tool => tool.name === 'forge_reindex').annotations.readOnlyHint, false);
  const call = async (name, args = {}) => {
    const result = await callTool(client, { name, arguments: args });
    return { result, body: JSON.parse(result.content[0].text) };
  };
  assert.equal((await call('forge_current')).body.error.code, 'INDEX_MISSING');
  assert.equal((await call('forge_reindex')).body.files, 2);
  const original = (await call('forge_current')).body;
  assert.equal(original.freshness, 'current');
  const inspected = (await call('forge_inspect', { symbol: 'value' })).body;
  assert.equal(inspected.results[0].locator.file, 'a.ts');
  assert.ok((await call('forge_references', { symbol: inspected.results[0].id })).body.total > 0);
  assert.equal((await call('forge_trace', { file: 'b.ts' })).body.results[0].target, 'a.ts');
  assert.equal((await call('forge_impact', { file: 'a.ts' })).body.results[0].from, 'b.ts');
  assert.equal(
    (await call('forge_source', { file: 'a.ts' })).body.results[0].text,
    'export const value = 1;',
  );
  const invalid = await callTool(client, { name: 'forge_context', arguments: { limit: 0 } });
  assert.equal(invalid.isError, true);
  assert.equal((await call('forge_source', { file: '../private.ts' })).result.isError, true);
  write(root, 'a.ts', 'export const changed = 2;');
  assert.equal((await call('forge_context')).body.error.code, 'SOURCE_STALE');
  await call('forge_reindex');
  assert.equal((await call('forge_inspect', { symbol: 'value' })).body.total, 0);
  renameSync(join(root, 'a.ts'), join(root, 'renamed.ts'));
  await call('forge_reindex');
  assert.equal(
    (await call('forge_inspect', { symbol: 'changed' })).body.results[0].locator.file,
    'renamed.ts',
  );
  unlinkSync(join(root, 'renamed.ts'));
  await call('forge_reindex');
  assert.equal((await call('forge_inspect', { symbol: 'changed' })).body.total, 0);
  git(root, ['restore', 'a.ts']);
  git(root, ['checkout', '-qb', 'other']);
  git(root, ['commit', '--allow-empty', '-qm', 'new head']);
  assert.equal((await call('forge_current')).body.freshness, 'stale');
  await call('forge_reindex');
  assert.notEqual((await call('forge_current')).body.gitHead, original.gitHead);
  await client.close();
  assert.equal(stderr, '');
});

test('doctor and emitted MCP configuration preserve existing client settings', t => {
  const root = fixture(t, { 'a.ts': 'export const a = 1;' });
  assert.equal(doctor(root).ready, false);
  const config = mcpConfig(root);
  assert.equal(config.mcpServers.forge.command, process.execPath);
  assert.deepEqual(config.mcpServers.forge.args.slice(1), ['mcp', realpathSync(root)]);
  assert.ok(config.mcpServers.forge.args[0].endsWith('/dist/cli.js'));
});

test('opt-in real stdio workflow MCP shares local work, pins exact source and leaves default source ownership intact', async t => {
  const root = fixture(t, { 'a.ts': 'export const value = 1;\n' });
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'Baseline']);
  const original = git(root, ['rev-parse', 'HEAD']).trim();
  const client = new Client({ name: 'forge-work-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/cli.js'), 'mcp', root, '--work'],
    env: mcpTestEnvironment(t),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => {
    stderr += chunk;
  });
  t.after(() => client.close());
  await client.connect(transport, requestOptions('connect'));
  const tools = (await client.listTools(undefined, requestOptions('listTools'))).tools;
  assert.equal(tools.length, 10);
  assert.equal(tools.find(tool => tool.name === 'forge_work_command').annotations.openWorldHint, true);
  const call = async (name, args = {}) =>
    JSON.parse((await callTool(client, { name, arguments: args })).content[0].text);
  const status = () => call('forge_work_status');
  const run = async command => call('forge_work_command', { command, revision: (await status()).revision });
  await run({ action: 'set-policy', operationId: randomUUID(), preset: 'trusted' });
  const intent = (await run({ action: 'intent', outcome: 'MCP work' })).result;
  const lane = (await run({ action: 'lane', intentId: intent.id, name: 'Candidate' })).result;
  const current = (await status()).lanes[0];
  write(current.path, 'a.ts', 'export const value = 2;\n');
  git(current.path, ['add', 'a.ts']);
  const staged = (await status()).lanes[0];
  const checkpoint = (
    await run({
      action: 'checkpoint',
      laneId: lane.id,
      expectedHead: staged.actualHead,
      expectedTree: staged.indexTree,
      message: 'MCP checkpoint',
    })
  ).result;
  const view = (
    await run({
      action: 'compose',
      intentId: intent.id,
      inputs: [{ laneId: lane.id, head: checkpoint.head }],
    })
  ).result;
  const child = (
    await run({
      action: 'child-lane',
      parentLaneId: lane.id,
      expectedHead: checkpoint.head,
      name: 'MCP child',
    })
  ).result;
  assert.equal(child.base, view.head);
  assert.equal(child.parent.laneId, lane.id);
  const target = (await run({ action: 'intent', outcome: 'MCP dependency' })).result;
  const pinned = (
    await run({
      action: 'compose',
      intentId: target.id,
      inputs: [],
      dependencies: [{ kind: 'view', viewId: view.id, head: view.head }],
    })
  ).result;
  assert.equal(pinned.head, checkpoint.head);
  const policy = (
    await run({
      action: 'define-invariant',
      operationId: randomUUID(),
      invariantId: randomUUID(),
      intentId: target.id,
      name: 'MCP explicit review',
      reviewers: ['MCP label'],
    })
  ).result;
  const assess = {
    action: 'assess-invariant',
    id: policy.id,
    definition: policy.definition,
    viewId: pinned.id,
    expectedHead: pinned.head,
  };
  assert.equal((await run(assess)).result.satisfied, false);
  await run({
    action: 'review-view',
    viewId: pinned.id,
    expectedHead: pinned.head,
    reviewer: 'MCP label',
    decision: 'approve',
    invariant: { id: policy.id, definition: policy.definition },
  });
  assert.equal((await run(assess)).result.satisfied, true);
  const planned = (
    await run({
      action: 'put-planning-item',
      operationId: randomUUID(),
      itemId: randomUUID(),
      kind: 'issue',
      title: 'MCP linked issue',
      intentIds: [target.id],
    })
  ).result;
  await run({
    action: 'comment-planning-item',
    operationId: randomUUID(),
    itemId: planned.id,
    text: 'MCP retained discussion',
  });
  const planning = JSON.parse((await run({ action: 'export-planning' })).result.json);
  assert.equal(planning.items[0].id, planned.id);
  assert.equal(planning.comments[0].text, 'MCP retained discussion');
  assert.equal(
    (await call('forge_work_command', { command: { action: 'intent', outcome: 'Stale' }, revision: 0 })).error
      .code,
    'WORK_STALE',
  );
  assert.equal(
    (
      await callTool(client, {
        name: 'forge_work_command',
        arguments: { command: { action: 'child-lane' }, revision: 0 },
      })
    ).isError,
    true,
  );
  const check = (
    await run({
      action: 'define-check',
      name: 'MCP fixture',
      executable: process.execPath,
      args: ['-e', 'console.log("MCP output"); setInterval(()=>{},1000)'],
    })
  ).result;
  const candidate = await status();
  const operationId = randomUUID();
  const command = {
    action: 'run-check',
    operationId,
    viewId: pinned.id,
    expectedHead: pinned.head,
    checkId: check.id,
    expectedDefinition: check.definition,
    expectedEnvironment: candidate.environment.fingerprint,
  };
  const started = await run(command);
  assert.equal(started.result.id, operationId);
  assert.equal((await call('forge_work_command', { command, revision: 0 })).result.id, operationId);
  // Observe actual output before cancellation: a queued cancellation has no log.
  const describeRun = run => ({ status: run?.status, endedAt: run?.endedAt });
  let outcome;
  try {
    await pollUntil({
      label: 'MCP check output before cancellation',
      observe: () => run({ action: 'read-check-output', operationId, stream: 'stdout' }),
      ready: output => {
        if (output.error) assert.equal(output.error.code, 'NOT_FOUND');
        return Boolean(
          output.result && Buffer.from(output.result.base64, 'base64').toString().includes('MCP output'),
        );
      },
      describe: output => ({ error: output?.error?.code, bytes: output?.result?.base64?.length }),
    });
  } finally {
    // Timeout diagnostics must not leave the fixture's interval/check process alive.
    await run({ action: 'cancel-check', operationId });
    outcome = await pollUntil({
      label: 'MCP cancelled check completion',
      observe: async () => (await status()).runs[0],
      ready: run => Boolean(run?.endedAt),
      describe: describeRun,
    });
  }
  assert.equal(outcome.status, 'cancelled');
  const output = await run({ action: 'read-check-output', operationId, stream: 'stdout' });
  assert.equal(output.result.private, true);
  const beforeExport = await status(),
    checkManifest = (await run({ action: 'export-check', id: operationId })).result;
  assert.equal(JSON.parse(checkManifest.json).run.id, operationId);
  assert.equal(JSON.parse(checkManifest.json).run.status, 'cancelled');
  assert.equal(checkManifest.sha256, createHash('sha256').update(checkManifest.json).digest('hex'));
  assert.equal(
    checkManifest.logs[0].sha256,
    createHash('sha256').update(Buffer.from(output.result.base64, 'base64')).digest('hex'),
  );
  assert.equal((await status()).revision, beforeExport.revision);
  const review = (
    await run({
      action: 'review-view',
      viewId: pinned.id,
      expectedHead: pinned.head,
      reviewer: 'Synthetic MCP reviewer',
      decision: 'comment',
      text: 'Fixture only',
    })
  ).result;
  assert.equal(review.provenance, 'user-declared');
  const step = (
    await run({
      action: 'define-check',
      name: 'MCP Playbook step',
      executable: process.execPath,
      artifactPaths: ['mcp-output.bin'],
      args: [
        '-e',
        'require("node:fs").writeFileSync("mcp-output.bin",Buffer.from([0,255,42]));console.log("Playbook output")',
      ],
    })
  ).result;
  const playbook = (
    await run({ action: 'define-playbook', name: 'MCP Playbook', checkIds: [step.id, step.id] })
  ).result;
  const sequence = {
    action: 'run-playbook',
    operationId: randomUUID(),
    playbookId: playbook.id,
    viewId: pinned.id,
    expectedHead: pinned.head,
    expectedDefinition: playbook.definition,
    expectedEnvironment: (await status()).environment.fingerprint,
    expectedChecks: [step, step].map(c => ({ id: c.id, definition: c.definition })),
  };
  await run(sequence);
  const sequenceOutcome = await pollUntil({
    label: 'MCP Playbook completion',
    observe: async () => (await status()).playbookRuns[0],
    ready: run => Boolean(run?.endedAt),
    describe: describeRun,
  });
  assert.equal(sequenceOutcome.status, 'passed');
  const buildManifest = (await run({ action: 'export-check', id: sequenceOutcome.steps[0].runId })).result;
  assert.equal(
    buildManifest.artifacts[0].sha256,
    createHash('sha256')
      .update(Buffer.from([0, 255, 42]))
      .digest('hex'),
  );
  assert.equal(buildManifest.artifacts[0].size, 3);

  assert.equal(
    (await call('forge_work_command', { command: sequence, revision: 0 })).result.id,
    sequence.operationId,
  );
  const exported = (await run({ action: 'export-playbook', kind: 'run', id: sequence.operationId })).result;
  assert.equal(exported.steps.length, 2);
  assert.ok(exported.steps.every(s => s.outcome.status === 'passed'));
  const automation = (
    await run({
      action: 'define-automation',
      automationId: randomUUID(),
      name: 'MCP automatic checks',
      intentId: target.id,
      playbookId: playbook.id,
      expectedPlaybook: playbook.definition,
      expectedChecks: [step, step].map(c => ({ id: c.id, definition: c.definition })),
      expectedEnvironment: (await status()).environment.fingerprint,
      onFailure: 'stop',
      enabled: true,
    })
  ).result;
  const composedCommand = {
    action: 'compose',
    operationId: randomUUID(),
    intentId: target.id,
    inputs: [],
    dependencies: [{ kind: 'view', viewId: view.id, head: view.head }],
  };
  const automaticView = (await run(composedCommand)).result;
  const automatic = await pollUntil({
    label: 'MCP compose automation completion',
    observe: async () => (await status()).playbookRuns.find(r => r.viewId === automaticView.id),
    ready: run => Boolean(run?.endedAt),
    describe: describeRun,
  });
  assert.equal(automatic.status, 'passed');
  assert.equal(automatic.automation.id, automation.id);
  assert.equal(
    (await call('forge_work_command', { command: composedCommand, revision: 0 })).result.id,
    automaticView.id,
  );
  assert.equal((await status()).playbookRuns.filter(r => r.automation?.id === automation.id).length, 1);
  const history = (
    await run({ action: 'read-history', viewId: pinned.id, expectedHead: pinned.head, limit: 1 })
  ).result;
  assert.equal(history.entries[0].id, pinned.head);
  assert.equal(history.nextOffset, 1);
  const rawHistory = (
    await run({
      action: 'export-history',
      viewId: pinned.id,
      expectedHead: pinned.head,
      offset: history.nextOffset,
    })
  ).result;
  assert.equal(rawHistory.entries[0].id, original);
  assert.equal(rawHistory.private, true);
  assert.match(Buffer.from(rawHistory.entries[0].raw.data, 'base64').toString('utf8'), /Baseline/);
  const interaction = (
    await run({
      action: 'compare-views',
      viewId: pinned.id,
      expectedHead: pinned.head,
      otherViewId: view.id,
      otherHead: view.head,
    })
  ).result;
  assert.equal(interaction.private, true);
  assert.equal(interaction.commonPathCount, 1);
  assert.equal(interaction.sharedPaths[0].display, 'a.ts');
  assert.equal(interaction.left.head, pinned.head);
  assert.equal(interaction.right.head, view.head);
  for (const event of ['channel-accepted', 'release-created'])
    await run({
      action: 'define-automation',
      automationId: randomUUID(),
      intentId: pinned.intentId,
      name: `MCP ${event}`,
      event,
      playbookId: playbook.id,
      expectedPlaybook: playbook.definition,
      expectedChecks: [step, step].map(c => ({ id: c.id, definition: c.definition })),
      expectedEnvironment: (await status()).environment.fingerprint,
      onFailure: 'stop',
      enabled: true,
    });
  const acceptance = {
    action: 'accept-channel',
    operationId: randomUUID(),
    channel: 'mcp-main',
    viewId: pinned.id,
    expectedHead: pinned.head,
    expectedPrevious: null,
  };
  const accepted = await run(acceptance);
  assert.equal(accepted.result.status, 'accepted');
  async function eventOutcome(id, event) {
    const outcome = await pollUntil({
      label: `MCP ${event} automation completion`,
      observe: async () => (await status()).playbookRuns.find(r => r.automation?.eventId === id),
      ready: run => Boolean(run?.endedAt),
      describe: describeRun,
    });
    assert.equal(outcome.status, 'passed');
    assert.equal(outcome.automation.event, event);
    assert.equal(outcome.head, pinned.head);
  }
  await eventOutcome(acceptance.operationId, 'channel-accepted');
  const release = (
    await run({
      action: 'create-release',
      operationId: randomUUID(),
      acceptanceId: acceptance.operationId,
      expectedHead: pinned.head,
      name: 'MCP source release',
    })
  ).result;
  await eventOutcome(release.id, 'release-created');
  const releaseExport = (await run({ action: 'export-release', id: release.id })).result;
  assert.equal(JSON.parse(releaseExport.json).release.acceptance.head, pinned.head);
  assert.equal(releaseExport.bundle.head, pinned.head);
  assert.equal((await status()).channels[0].head, pinned.head);
  assert.equal(
    (await call('forge_work_command', { command: acceptance, revision: 0 })).result.id,
    acceptance.operationId,
  );
  assert.equal(
    (await status()).playbookRuns.filter(r => r.automation?.eventId === acceptance.operationId).length,
    1,
  );
  const bundle = await run({ action: 'export-channel', id: acceptance.operationId });
  assert.equal(
    git(root, ['bundle', 'list-heads', bundle.result.path]).trim(),
    `${pinned.head} refs/heads/accepted`,
  );
  await call('forge_reindex');
  assert.equal((await call('forge_current')).gitHead, original);
  assert.equal((await call('forge_source', { file: 'a.ts' })).results[0].text, 'export const value = 1;\n');
  await client.close();
  assert.equal(stderr, '');
});
